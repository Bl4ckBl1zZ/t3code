import Foundation
import XCTest
@testable import T3Code

/// Dead-socket detection, foreground probes, and resumable subscriptions.
/// Keepalive, pong, and probe timers run on a manual clock, so nothing here
/// waits on real time.
final class ConnectionResilienceTests: XCTestCase {
    private static let keepalive: Duration = .seconds(5)
    private static let pongTimeout: Duration = .seconds(10)
    private static let probeTimeout: Duration = .seconds(3)

    // MARK: - Pong deadline

    func testUnansweredPingDropsTheSocketAndRedials() async {
        let clock = ManualClock()
        let silent = ScriptedSocket(answersPings: false)
        let next = ScriptedSocket(answersPings: true)
        let connector = ScriptedConnector(sockets: [silent, next])
        let client = makeClient(connector: connector, clock: clock)

        await client.start()
        await silent.waitUntilReceiving()
        await clock.fire(Self.keepalive)
        await silent.waitForPings(1)
        await clock.fire(Self.pongTimeout)

        await connector.waitUntilConnectionCount(2)
        let closed = await silent.isClosed
        XCTAssertTrue(closed, "A socket that stopped answering pings must be replaced.")
        await client.stop()
    }

    func testPongSettlesTheDeadlineAndKeepsTheSocket() async {
        let clock = ManualClock()
        let socket = ScriptedSocket(answersPings: true)
        let connector = ScriptedConnector(sockets: [socket])
        let client = makeClient(connector: connector, clock: clock)

        await client.start()
        await socket.waitUntilReceiving()
        await clock.fire(Self.keepalive)
        await socket.waitForPings(1)
        await clock.waitForCancellation(Self.pongTimeout)

        // The answered ping no longer blocks the next one.
        await clock.fire(Self.keepalive)
        await socket.waitForPings(2)
        let connections = await connector.connectionCount
        let closed = await socket.isClosed
        XCTAssertEqual(connections, 1)
        XCTAssertFalse(closed)
        await client.stop()
    }

    func testProbeOfAHealthySocketAnswers() async {
        let clock = ManualClock()
        let socket = ScriptedSocket(answersPings: true)
        let connector = ScriptedConnector(sockets: [socket])
        let client = makeClient(connector: connector, clock: clock)

        await client.start()
        await socket.waitUntilReceiving()
        let alive = await client.probe(timeout: Self.probeTimeout)

        XCTAssertTrue(alive)
        await clock.waitForCancellation(Self.probeTimeout)
        let connections = await connector.connectionCount
        XCTAssertEqual(connections, 1)
        await client.stop()
    }

    func testSilentProbeDropsTheSocketAndRedials() async {
        let clock = ManualClock()
        let silent = ScriptedSocket(answersPings: false)
        let next = ScriptedSocket(answersPings: true)
        let connector = ScriptedConnector(sockets: [silent, next])
        let client = makeClient(connector: connector, clock: clock)

        await client.start()
        await silent.waitUntilReceiving()
        async let alive = client.probe(timeout: Self.probeTimeout)
        await silent.waitForPings(1)
        await clock.fire(Self.probeTimeout)

        let answered = await alive
        XCTAssertFalse(answered)
        await connector.waitUntilConnectionCount(2)
        await client.stop()
    }

    func testProbeWithoutASocketReportsDead() async {
        let client = WebSocketRPCClient(
            connector: ScriptedConnector(sockets: []),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )
        let alive = await client.probe(timeout: Self.probeTimeout)
        XCTAssertFalse(alive)
    }

    // MARK: - Resubscribe payloads

    func testResubscribeBuildsItsPayloadFromTheLatestSequence() async throws {
        let clock = ManualClock()
        let first = ScriptedSocket(answersPings: true)
        let second = ScriptedSocket(answersPings: true)
        let connector = ScriptedConnector(sockets: [first, second])
        let client = makeClient(connector: connector, clock: clock)
        let applied = SequenceBox(5)

        let stream = await client.subscribe("orchestration.subscribeShell", as: JSONValue.self) {
            .object(["afterSequence": .number(Double(applied.value))])
        }
        let opened = await first.waitForSubscription("orchestration.subscribeShell")
        XCTAssertEqual(opened["payload"]?["afterSequence"], .number(5))

        applied.value = 9
        await client.reconnectNow(reason: "test")
        let resumed = await second.waitForSubscription("orchestration.subscribeShell")
        XCTAssertEqual(resumed["payload"]?["afterSequence"], .number(9))

        withExtendedLifetime(stream) {}
        await client.stop()
    }

    func testThreadStreamResumesAfterTheNewestDeliveredFrame() async throws {
        let first = ScriptedSocket(answersPings: true)
        let second = ScriptedSocket(answersPings: true)
        let client = makeT3Client(connector: ScriptedConnector(sockets: [first, second]))

        let stream = await client.threadEvents(threadID: "thread-1", after: 3)
        var iterator = stream.makeAsyncIterator()
        let opened = await first.waitForSubscription(RPCMethod.subscribeThread.rawValue)
        XCTAssertEqual(opened["payload"]?["afterSequence"], .number(3))
        XCTAssertEqual(opened["payload"]?["threadId"], .string("thread-1"))

        try await first.push(
            to: opened,
            .object(["kind": .string("event"), "sequence": .number(7), "event": .object([:])])
        )
        let delivered = try await iterator.next()
        guard case .event(7, _)? = delivered else {
            return XCTFail("Expected the pushed event, got \(String(describing: delivered)).")
        }

        await client.reconnect(reason: "test")
        let resumed = await second.waitForSubscription(RPCMethod.subscribeThread.rawValue)
        XCTAssertEqual(resumed["payload"]?["afterSequence"], .number(7))
        XCTAssertEqual(resumed["payload"]?["requestCompletionMarker"], .bool(true))
        await client.disconnect()
    }

    func testCursorIgnoresEnrichmentFramesAndNeverMovesBack() {
        let cursor = StreamResumeCursor(after: nil)
        XCTAssertNil(cursor.sequence)

        cursor.advance(to: OrchestrationV2ShellStreamItem.snapshot(
            V2Fixture.shellSnapshot(sequence: 12),
            resolvedRepositoryIdentityRoots: nil
        ).resumeSequence)
        XCTAssertEqual(cursor.sequence, 12)

        cursor.advance(to: OrchestrationV2ShellStreamItem.snapshot(
            V2Fixture.shellSnapshot(sequence: 40),
            resolvedRepositoryIdentityRoots: ["/work"]
        ).resumeSequence)
        cursor.advance(to: OrchestrationV2ShellStreamItem.projectRemoved(sequence: 8, projectID: "p")
            .resumeSequence)
        XCTAssertEqual(cursor.sequence, 12)
    }

    // MARK: - Stale HTTP shells

    func testFetchedShellOlderThanTheHeldOneIsRejected() {
        let held = V2Fixture.shellSnapshot(
            sequence: 20,
            threads: [V2Fixture.threadShell(id: "streamed")]
        )
        let stale = V2Fixture.shellSnapshot(sequence: 18)

        XCTAssertNil(ShellSnapshotMerge.mergeFetched(previous: held, fetched: stale))
        XCTAssertEqual(
            ShellSnapshotMerge.mergeFetched(
                previous: held,
                fetched: V2Fixture.shellSnapshot(sequence: 21)
            )?.snapshotSequence,
            21
        )
        XCTAssertEqual(
            ShellSnapshotMerge.mergeFetched(previous: nil, fetched: stale)?.snapshotSequence,
            18
        )
    }

    // MARK: - Shell row mapping

    func testOneChangedThreadRemapsOnlyThatRow() {
        var cache = ShellThreadMappingCache<Int>()
        var mapped: [String] = []
        let map = { (thread: OrchestrationV2ThreadShell) -> FeatureThread in
            mapped.append(thread.id)
            return FeatureThread(id: thread.id, projectID: "p", title: thread.title)
        }
        let threads = ["a", "b", "c"].map { V2Fixture.threadShell(id: $0, title: $0) }

        let first = cache.rows(environmentID: "env", context: 1, threads: threads, map: map)
        XCTAssertEqual(mapped, ["a", "b", "c"])

        mapped.removeAll()
        var changed = threads
        changed[1] = V2Fixture.threadShell(id: "b", title: "renamed")
        let second = cache.rows(environmentID: "env", context: 1, threads: changed, map: map)
        XCTAssertEqual(mapped, ["b"])
        XCTAssertEqual(second.map(\.title), ["a", "renamed", "c"])
        XCTAssertEqual(second[0], first[0])

        mapped.removeAll()
        _ = cache.rows(environmentID: "env", context: 2, threads: changed, map: map)
        XCTAssertEqual(mapped, ["a", "b", "c"], "A context change remaps every row.")

        mapped.removeAll()
        _ = cache.rows(environmentID: "other", context: 2, threads: changed, map: map)
        XCTAssertEqual(mapped, ["a", "b", "c"], "Environments do not share rows.")
    }

    // MARK: - Wakeups

    func testForegroundProbesAfterAShortAbsenceAndReconnectsAfterALongOne() {
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(
            ConnectionWakeup.applicationActive(backgroundedAt: nil, activeAt: now),
            .probe(reason: "foreground")
        )
        XCTAssertEqual(
            ConnectionWakeup.applicationActive(backgroundedAt: now.addingTimeInterval(-9), activeAt: now),
            .probe(reason: "foreground")
        )
        XCTAssertEqual(
            ConnectionWakeup.applicationActive(backgroundedAt: now.addingTimeInterval(-10), activeAt: now),
            .reconnect(reason: "foreground")
        )
    }

    func testNetworkWakeupsOnlyForReturningOrMovingOnline() {
        let wifi = NetworkPathSummary(isSatisfied: true, interfaces: ["en0"])
        let cellular = NetworkPathSummary(isSatisfied: true, interfaces: ["pdp_ip0"])
        let offline = NetworkPathSummary(isSatisfied: false, interfaces: [])

        XCTAssertFalse(NetworkPathSummary.isWakeup(from: nil, to: wifi), "The first report is the starting point.")
        XCTAssertFalse(NetworkPathSummary.isWakeup(from: wifi, to: wifi))
        XCTAssertFalse(NetworkPathSummary.isWakeup(from: wifi, to: offline))
        XCTAssertTrue(NetworkPathSummary.isWakeup(from: offline, to: wifi))
        XCTAssertTrue(NetworkPathSummary.isWakeup(from: wifi, to: cellular))
    }

    // MARK: - Helpers

    private func makeClient(connector: ScriptedConnector, clock: ManualClock) -> WebSocketRPCClient {
        WebSocketRPCClient(
            connector: connector,
            keepaliveInterval: Self.keepalive,
            pongTimeout: Self.pongTimeout,
            sleep: clock.sleeper,
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )
    }

    private func makeT3Client(connector: ScriptedConnector) -> T3Client {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        return T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore(
                credentials: [environment.id: EnvironmentCredential(accessToken: "token")]
            ),
            httpTransport: TicketTransport(),
            webSocketConnector: connector
        )
    }
}

private final class SequenceBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Int

    init(_ value: Int) {
        stored = value
    }

    var value: Int {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

/// Sleeps that end only when a test fires them, so deadlines are driven
/// rather than waited out. Sleeps are told apart by their duration.
private actor ManualClock {
    private struct Sleep {
        let id: UUID
        let duration: Duration
        let resume: CheckedContinuation<Void, Error>
    }

    private var sleeps: [Sleep] = []
    private var cancelled: [Duration] = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    nonisolated var sleeper: WebSocketRPCClient.Sleeper {
        { [self] duration in try await self.sleep(for: duration) }
    }

    func sleep(for duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                sleeps.append(Sleep(id: id, duration: duration, resume: continuation))
                notify()
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    /// Ends the oldest pending sleep of `duration`, waiting for one to start.
    func fire(_ duration: Duration) async {
        await waitUntil { sleeps.contains { $0.duration == duration } }
        guard let index = sleeps.firstIndex(where: { $0.duration == duration }) else { return }
        sleeps.remove(at: index).resume.resume()
    }

    func waitForCancellation(_ duration: Duration) async {
        await waitUntil { cancelled.contains(duration) }
    }

    private func cancel(_ id: UUID) {
        guard let index = sleeps.firstIndex(where: { $0.id == id }) else { return }
        let sleep = sleeps.remove(at: index)
        cancelled.append(sleep.duration)
        sleep.resume.resume(throwing: CancellationError())
        notify()
    }

    /// Re-checks `condition` after every change.
    private func waitUntil(_ condition: () -> Bool) async {
        while !condition() {
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    private func notify() {
        let ready = waiters
        waiters.removeAll()
        ready.forEach { $0.resume() }
    }
}

private actor ScriptedConnector: WebSocketConnecting {
    private let sockets: [ScriptedSocket]
    private(set) var connectionCount = 0
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    init(sockets: [ScriptedSocket]) {
        self.sockets = sockets
    }

    func connect(to _: URL) throws -> any WebSocketConnection {
        guard connectionCount < sockets.count else {
            throw URLError(.cannotConnectToHost)
        }
        let socket = sockets[connectionCount]
        connectionCount += 1
        let ready = waiters.filter { connectionCount >= $0.0 }
        waiters.removeAll { connectionCount >= $0.0 }
        ready.forEach { $0.1.resume() }
        return socket
    }

    func waitUntilConnectionCount(_ count: Int) async {
        guard connectionCount < count else { return }
        await withCheckedContinuation { continuation in
            waiters.append((count, continuation))
        }
    }
}

/// Records what the client sends, answers Ping with Pong when told to, and
/// lets a test push subscription chunks.
private actor ScriptedSocket: WebSocketConnection {
    private let answersPings: Bool
    private var requests: [JSONValue] = []
    private var pings = 0
    private var queued: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var receiving = false
    private(set) var isClosed = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(answersPings: Bool) {
        self.answersPings = answersPings
    }

    func send(_ data: Data) throws {
        if isClosed { throw URLError(.networkConnectionLost) }
        let message = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        switch message["_tag"]?.stringValue {
        case "Ping":
            pings += 1
            if answersPings {
                enqueue(try JSONEncoder.t3.encode(JSONValue.object(["_tag": .string("Pong")])))
            }
        case "Request":
            requests.append(message)
        default:
            break
        }
        notify()
    }

    func receive() async throws -> Data {
        if isClosed { throw URLError(.networkConnectionLost) }
        receiving = true
        notify()
        if !queued.isEmpty { return queued.removeFirst() }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        isClosed = true
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }

    func push(to request: JSONValue, _ value: JSONValue) throws {
        guard let requestID = request["id"] else { return }
        enqueue(try JSONEncoder.t3.encode(JSONValue.object([
            "_tag": .string("Chunk"),
            "requestId": requestID,
            "values": .array([value]),
        ])))
    }

    func waitUntilReceiving() async {
        await waitUntil { receiving }
    }

    func waitForPings(_ count: Int) async {
        await waitUntil { pings >= count }
    }

    func waitForSubscription(_ tag: String) async -> JSONValue {
        await waitUntil { requests.contains { $0["tag"]?.stringValue == tag } }
        return requests.first { $0["tag"]?.stringValue == tag }!
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queued.append(data)
        }
    }

    /// Re-checks `condition` after every change.
    private func waitUntil(_ condition: () -> Bool) async {
        while !condition() {
            await withCheckedContinuation { waiters.append($0) }
        }
    }

    private func notify() {
        let ready = waiters
        waiters.removeAll()
        ready.forEach { $0.resume() }
    }
}

private struct TicketTransport: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard request.url?.path == "/api/auth/websocket-ticket" else {
            throw URLError(.unsupportedURL)
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(#"{"ticket":"ticket","expiresAt":"2126-07-31T12:05:00.000Z"}"#.utf8), response)
    }
}
