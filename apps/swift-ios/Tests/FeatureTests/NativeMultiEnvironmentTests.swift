import Foundation
import XCTest
@testable import T3Code

@MainActor
final class NativeMultiEnvironmentTests: XCTestCase {
    func testProviderCatalogueUsesStableProviderAndModelIdentities() {
        let normalized = NativeFeatureClient.normalizedProviders([
            FeatureProvider(
                id: "codex-work",
                name: "Codex",
                models: [
                    FeatureModel(id: "gpt-5.6", name: "GPT-5.6"),
                    FeatureModel(id: "gpt-5.6", name: "Duplicate GPT-5.6"),
                ]
            ),
            FeatureProvider(
                id: "codex-work",
                name: "Duplicate provider",
                models: [
                    FeatureModel(id: "gpt-5.6", name: "Duplicate again"),
                    FeatureModel(id: "gpt-5.6-mini", name: "GPT-5.6 mini"),
                ]
            ),
        ])

        XCTAssertEqual(normalized.map(\.id), ["codex-work"])
        XCTAssertEqual(normalized[0].models.map(\.id), ["gpt-5.6", "gpt-5.6-mini"])
    }

    func testClientReplacementIsSharedWhileStaleClientDisconnects() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-runtime-race-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let originalEnvironment = Environment(
            id: "shared-environment",
            label: "Old endpoint",
            httpBaseURL: URL(string: "https://old.example")!,
            webSocketBaseURL: URL(string: "wss://old.example")!
        )
        let updatedEnvironment = Environment(
            id: originalEnvironment.id,
            label: "New endpoint",
            httpBaseURL: URL(string: "https://new.example")!,
            webSocketBaseURL: URL(string: "wss://new.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([updatedEnvironment])
        let staleConnection = BlockingRuntimeCloseConnection()
        let connector = RuntimeReplacementConnector(connection: staleConnection)
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    originalEnvironment.id: EnvironmentCredential(accessToken: "token"),
                ]
            ),
            httpTransport: RuntimeReplacementHTTPTransport(),
            webSocketConnector: connector
        )
        let original = await runtime.client(for: originalEnvironment)
        await original.connect()
        await staleConnection.waitUntilReceiving()

        let firstLookup = Task { await runtime.client(for: updatedEnvironment) }
        await staleConnection.waitUntilCloseStarted()
        let concurrentLookup = await runtime.client(for: updatedEnvironment)
        await staleConnection.releaseClose()
        let replacement = await firstLookup.value

        XCTAssertTrue(
            replacement === concurrentLookup,
            "Concurrent lookups must share the replacement cached before stale disconnect."
        )
    }

    func testSnapshotMergesEnvironmentsAndRoutesThreadWorkToItsOwner() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()

        XCTAssertEqual(Set(snapshot.projects.map(\.environmentID)), ["one", "two"])
        XCTAssertEqual(Set(snapshot.threads.compactMap(\.wireID)), ["thread-one", "thread-two"])
        let remoteThread = try XCTUnwrap(
            snapshot.threads.first(where: { $0.environmentID == "two" })
        )
        XCTAssertEqual(
            remoteThread.environmentName,
            "Steam Box"
        )
        XCTAssertEqual(
            snapshot.environments.first(where: { $0.id == "two" })?.connectionState,
            .connected
        )

        let detail = try await fixture.client.loadThread(id: remoteThread.id)
        XCTAssertEqual(detail.thread.environmentID, "two")
        XCTAssertEqual(detail.thread.environmentName, "Steam Box")

        try await fixture.client.renameThread(id: remoteThread.id, title: "Remote rename")
        try await fixture.client.sendMessage(
            threadID: remoteThread.id,
            text: "Run this on Steam Box",
            selection: nil
        )

        let routedHosts = await fixture.dispatches.hosts()
        XCTAssertEqual(routedHosts, ["two.example", "two.example"])
        await fixture.client.disconnect()
    }

    func testFailedEnvironmentKeepsItsLastKnownRowsWithoutHidingHealthyDevices() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.client.initialSnapshot()
        await fixture.transport.setReachable(false, host: "two.example")

        let passiveFailure = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            Set(passiveFailure.threads.compactMap(\.wireID)),
            ["thread-one", "thread-two"]
        )
        XCTAssertEqual(passiveFailure.connection.state, .connected)
        XCTAssertEqual(
            passiveFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .disconnected
        )

        await fixture.transport.setReachable(false, host: "one.example")
        await fixture.transport.setReachable(true, host: "two.example")

        let activeFailure = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            Set(activeFailure.threads.compactMap(\.wireID)),
            ["thread-one", "thread-two"]
        )
        XCTAssertEqual(activeFailure.connection.state, .disconnected)
        XCTAssertEqual(activeFailure.connection.environmentName, "Left Book")
        XCTAssertEqual(
            activeFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .connected
        )
        await fixture.client.disconnect()
    }

    func testAggregateRefreshRetriesTransientEnvironmentLoadFailures() async throws {
        let retryObserved = expectation(description: "aggregate refresh retried")
        let loader = FailOnceAggregateEnvironmentLoader(retryObserved: retryObserved)
        let fixture = try await makeFixture(
            aggregateRefreshInterval: .milliseconds(5),
            aggregateEnvironmentLoader: { runtime in
                try await loader.load(from: runtime)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.client.initialSnapshot()

        await fulfillment(of: [retryObserved], timeout: 1)
        let retryCallCount = await loader.callCount
        XCTAssertGreaterThanOrEqual(retryCallCount, 2)
        await fixture.client.disconnect()
    }

    func testSameClientSnapshotRestartsAggregateRefresh() async throws {
        let firstLoadStarted = expectation(description: "first aggregate load started")
        let restartedLoadObserved = expectation(description: "restarted aggregate load observed")
        let loader = BlockingFirstAggregateEnvironmentLoader(
            firstLoadStarted: firstLoadStarted,
            restartedLoadObserved: restartedLoadObserved
        )
        let fixture = try await makeFixture(
            aggregateRefreshInterval: .milliseconds(5),
            aggregateEnvironmentLoader: { runtime in
                try await loader.load(from: runtime)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.client.initialSnapshot()
        await fulfillment(of: [firstLoadStarted], timeout: 1)

        _ = try await fixture.client.initialSnapshot()

        await fulfillment(of: [restartedLoadObserved], timeout: 1)
        let restartedCallCount = await loader.callCount
        XCTAssertGreaterThanOrEqual(restartedCallCount, 2)
        await fixture.client.disconnect()
    }

    func testDuplicateWireIDsRemainDistinctAndRouteByEnvironment() async throws {
        let fixture = try await makeFixture(duplicateIDs: true)
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()
        XCTAssertEqual(snapshot.projects.count, 2)
        XCTAssertEqual(snapshot.threads.count, 2)
        XCTAssertEqual(Set(snapshot.projects.map(\.id)).count, 2)
        XCTAssertEqual(Set(snapshot.threads.map(\.id)).count, 2)
        XCTAssertEqual(Set(snapshot.projects.compactMap(\.wireID)), ["project-shared"])
        XCTAssertEqual(Set(snapshot.threads.compactMap(\.wireID)), ["thread-shared"])

        let remote = try XCTUnwrap(
            snapshot.threads.first(where: { $0.environmentID == "two" })
        )
        _ = try await fixture.client.loadThread(id: remote.id)
        try await fixture.client.renameThread(id: remote.id, title: "Remote only")

        let hosts = await fixture.dispatches.hosts()
        XCTAssertEqual(hosts, ["two.example"])
        await fixture.client.disconnect()
    }

    func testPassiveCreateUsesOwningProjectDefaultAndFallbackRemainsRoutable() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()
        let remoteProject = try XCTUnwrap(
            snapshot.projects.first(where: { $0.environmentID == "two" })
        )
        let created = try await fixture.client.createThread(
            projectID: remoteProject.id,
            title: "Passive task",
            selection: nil
        )

        XCTAssertEqual(created.environmentID, "two")
        XCTAssertEqual(created.projectID, remoteProject.id)
        XCTAssertNotNil(created.wireID)
        try await fixture.client.renameThread(id: created.id, title: "Fallback routed")

        let records = await fixture.dispatches.records()
        XCTAssertEqual(records.map(\.host), ["two.example", "two.example"])
        XCTAssertEqual(records[0].command["type"]?.stringValue, "thread.create")
        XCTAssertEqual(records[0].command["projectId"]?.stringValue, "project-two")
        XCTAssertEqual(
            records[0].command["modelSelection"]?["instanceId"]?.stringValue,
            "claudeAgent"
        )
        XCTAssertEqual(
            records[1].command["threadId"]?.stringValue,
            created.wireID
        )
        await fixture.client.disconnect()
    }

    func testUnarchiveImmediatelyRestoresLiveThreadWhenRefreshIsUnavailable() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try XCTUnwrap(
            initial.threads.first(where: { $0.environmentID == "one" })
        )
        let events = fixture.client.events()
        var iterator = events.makeAsyncIterator()
        await fixture.transport.setShellReadsEnabled(false, host: "one.example")

        try await fixture.client.setThreadArchived(id: thread.id, archived: true)
        while let event = await iterator.next() {
            if case let .thread(candidate) = event,
               candidate.id == thread.id,
               candidate.isArchived {
                break
            }
        }
        try await fixture.client.setThreadArchived(id: thread.id, archived: false)
        var restored: FeatureThread?
        while let event = await iterator.next() {
            if case let .thread(candidate) = event,
               candidate.id == thread.id,
               !candidate.isArchived {
                restored = candidate
                break
            }
        }

        XCTAssertEqual(restored?.id, thread.id)
        XCTAssertEqual(restored?.isArchived, false)
        await fixture.client.disconnect()
    }

    func testHTTPFallbackKeepsLiveConnectionReconnecting() async throws {
        let fixture = try await makeFixture(
            fallbackPollingInitialDelay: .milliseconds(40),
            fallbackPollingInterval: .seconds(2)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let current = multiEnvironmentShell(
            projectID: "project-one",
            threadID: "thread-one",
            title: "Local work"
        )
        let addedProject = OrchestrationProject(
            id: "project-fallback",
            title: "Fallback project",
            workspaceRoot: "/work/fallback",
            repositoryIdentity: nil,
            defaultModelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            scripts: [],
            createdAt: V2Fixture.timestamp,
            updatedAt: V2Fixture.timestamp,
            deletedAt: nil
        )
        var next = current
        next.snapshotSequence = current.snapshotSequence + 1
        next.projects = current.projects + [addedProject]
        await fixture.transport.setShell(next, host: "one.example")
        let events = fixture.client.events()
        var iterator = events.makeAsyncIterator()
        var refreshed: FeatureSnapshot?
        while let event = await iterator.next() {
            if case let .snapshot(snapshot) = event,
               snapshot.projects.contains(where: { $0.wireID == addedProject.id }) {
                refreshed = snapshot
                break
            }
        }

        XCTAssertEqual(refreshed?.connection.state, .reconnecting)
        await fixture.client.disconnect()
    }

    private func makeFixture(
        duplicateIDs: Bool = false,
        fallbackPollingInitialDelay: Duration = .seconds(3),
        fallbackPollingInterval: Duration = .seconds(2),
        aggregateRefreshInterval: Duration = .seconds(20),
        aggregateEnvironmentLoader: @escaping @Sendable (EnvironmentRuntime) async throws -> [Environment] = {
            try await $0.environments()
        }
    ) async throws -> MultiEnvironmentFixture {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-multi-\(UUID().uuidString)", isDirectory: true)
        let environments = [
            Environment(
                id: "one",
                label: "Left Book",
                httpBaseURL: URL(string: "https://one.example")!,
                webSocketBaseURL: URL(string: "wss://one.example")!
            ),
            Environment(
                id: "two",
                label: "Steam Box",
                httpBaseURL: URL(string: "https://two.example")!,
                webSocketBaseURL: URL(string: "wss://two.example")!
            ),
        ]
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save(environments)
        try await store.setActiveEnvironment(id: "one")
        let dispatches = MultiEnvironmentDispatchLog()
        let transport = MultiEnvironmentHTTPTransport(
            shells: [
                "one.example": multiEnvironmentShell(
                    projectID: duplicateIDs ? "project-shared" : "project-one",
                    threadID: duplicateIDs ? "thread-shared" : "thread-one",
                    title: "Local work"
                ),
                "two.example": multiEnvironmentShell(
                    projectID: duplicateIDs ? "project-shared" : "project-two",
                    threadID: duplicateIDs ? "thread-shared" : "thread-two",
                    title: "Remote work",
                    providerID: "claudeAgent",
                    modelID: "claude-opus-4-1"
                ),
            ]
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    "one": EnvironmentCredential(accessToken: "one-token"),
                    "two": EnvironmentCredential(accessToken: "two-token"),
                ]
            ),
            httpTransport: transport,
            webSocketConnector: MultiEnvironmentWebSocketConnector(log: dispatches)
        )
        let settings = UserDefaults(
            suiteName: "t3-native-multi-\(UUID().uuidString)"
        )!
        return MultiEnvironmentFixture(
            directory: directory,
            transport: transport,
            dispatches: dispatches,
            client: NativeFeatureClient(
                runtime: runtime,
                settingsStore: settings,
                fallbackPollingInitialDelay: fallbackPollingInitialDelay,
                fallbackPollingInterval: fallbackPollingInterval,
                aggregateRefreshInterval: aggregateRefreshInterval,
                aggregateEnvironmentLoader: aggregateEnvironmentLoader
            )
        )
    }
}

private actor FailOnceAggregateEnvironmentLoader {
    private let retryObserved: XCTestExpectation
    private(set) var callCount = 0

    init(retryObserved: XCTestExpectation) {
        self.retryObserved = retryObserved
    }

    func load(from runtime: EnvironmentRuntime) async throws -> [Environment] {
        callCount += 1
        if callCount == 1 {
            throw URLError(.cannotOpenFile)
        }
        retryObserved.fulfill()
        return try await runtime.environments()
    }
}

private actor BlockingFirstAggregateEnvironmentLoader {
    private let firstLoadStarted: XCTestExpectation
    private let restartedLoadObserved: XCTestExpectation
    private(set) var callCount = 0

    init(
        firstLoadStarted: XCTestExpectation,
        restartedLoadObserved: XCTestExpectation
    ) {
        self.firstLoadStarted = firstLoadStarted
        self.restartedLoadObserved = restartedLoadObserved
    }

    func load(from runtime: EnvironmentRuntime) async throws -> [Environment] {
        callCount += 1
        if callCount == 1 {
            firstLoadStarted.fulfill()
            try await Task.sleep(for: .seconds(60))
        }
        restartedLoadObserved.fulfill()
        return try await runtime.environments()
    }
}

private actor RuntimeReplacementConnector: WebSocketConnecting {
    let connection: BlockingRuntimeCloseConnection

    init(connection: BlockingRuntimeCloseConnection) {
        self.connection = connection
    }

    func connect(to _: URL) -> any WebSocketConnection {
        connection
    }
}

private actor BlockingRuntimeCloseConnection: WebSocketConnection {
    private var receiveContinuation: CheckedContinuation<Data, Error>?
    private var receiveWaiters: [CheckedContinuation<Void, Never>] = []
    private var closeContinuation: CheckedContinuation<Void, Never>?
    private var closeWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_: Data) {}

    func receive() async throws -> Data {
        let waiters = receiveWaiters
        receiveWaiters.removeAll()
        waiters.forEach { $0.resume() }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() async {
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
        let waiters = closeWaiters
        closeWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { continuation in
            closeContinuation = continuation
        }
    }

    func waitUntilReceiving() async {
        guard receiveContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            receiveWaiters.append(continuation)
        }
    }

    func waitUntilCloseStarted() async {
        guard closeContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            closeWaiters.append(continuation)
        }
    }

    func releaseClose() {
        closeContinuation?.resume()
        closeContinuation = nil
    }
}

private actor RuntimeReplacementHTTPTransport: HTTPTransport {
    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        guard request.url?.path == "/api/auth/websocket-ticket" else {
            throw URLError(.unsupportedURL)
        }
        return (
            Data("{\"ticket\":\"ticket\",\"expiresAt\":\"2026-08-01T12:05:00.000Z\"}".utf8),
            multiEnvironmentResponse(request)
        )
    }
}

private struct MultiEnvironmentFixture {
    let directory: URL
    let transport: MultiEnvironmentHTTPTransport
    let dispatches: MultiEnvironmentDispatchLog
    let client: NativeFeatureClient
}

private actor MultiEnvironmentHTTPTransport: HTTPTransport {
    private let shells: [String: OrchestrationV2ShellSnapshot]
    private var shellData: [String: Data]
    private var reachableHosts: Set<String>
    private var shellReadsEnabledHosts: Set<String>

    init(shells: [String: OrchestrationV2ShellSnapshot]) {
        self.shells = shells
        shellData = shells.mapValues { try! JSONEncoder.t3.encode($0) }
        reachableHosts = Set(shells.keys)
        shellReadsEnabledHosts = Set(shells.keys)
    }

    func setReachable(_ reachable: Bool, host: String) {
        if reachable {
            reachableHosts.insert(host)
        } else {
            reachableHosts.remove(host)
        }
    }

    func setShellReadsEnabled(_ enabled: Bool, host: String) {
        if enabled {
            shellReadsEnabledHosts.insert(host)
        } else {
            shellReadsEnabledHosts.remove(host)
        }
    }

    func setShell(_ shell: OrchestrationV2ShellSnapshot, host: String) {
        shellData[host] = try! JSONEncoder.t3.encode(shell)
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let host = request.url?.host ?? ""
        guard reachableHosts.contains(host) else {
            throw URLError(.cannotConnectToHost)
        }
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell",
           shellReadsEnabledHosts.contains(host),
           let data = shellData[host] {
            return (data, multiEnvironmentResponse(request))
        }
        if path.hasPrefix("/api/orchestration/threads/") {
            let threadID = request.url?.lastPathComponent.removingPercentEncoding ?? "thread"
            let projectID = shells[host]?.threads
                .first(where: { $0.id == threadID })?
                .projectId ?? shells[host]?.projects.first?.id ?? "project"
            return (
                try JSONEncoder.t3.encode(
                    multiEnvironmentDetail(projectID: projectID, threadID: threadID)
                ),
                multiEnvironmentResponse(request)
            )
        }
        if path == "/api/auth/websocket-ticket" {
            return (
                Data(
                    """
                    {"ticket":"ticket","expiresAt":"2026-07-31T12:05:00.000Z"}
                    """.utf8
                ),
                multiEnvironmentResponse(request)
            )
        }
        throw URLError(.unsupportedURL)
    }
}

private struct MultiEnvironmentDispatchRecord: Sendable {
    let host: String
    let command: JSONValue
}

/// Commands are WebSocket-only, so a fixture that wants to observe routing has
/// to speak the socket. Only `orchestration.dispatchCommand` and
/// `orchestration.launchThread` are answered; everything else — the shell,
/// thread and server-config subscriptions — is accepted and never delivers, so
/// these tests keep exercising the HTTP refresh path.
private struct MultiEnvironmentWebSocketConnector: WebSocketConnecting {
    let log: MultiEnvironmentDispatchLog

    func connect(to url: URL) async throws -> any WebSocketConnection {
        MultiEnvironmentWebSocketConnection(host: url.host ?? "", log: log)
    }
}

private actor MultiEnvironmentDispatchLog {
    private var dispatched: [MultiEnvironmentDispatchRecord] = []

    func record(_ record: MultiEnvironmentDispatchRecord) {
        dispatched.append(record)
    }

    func hosts() -> [String] {
        dispatched.map(\.host)
    }

    func records() -> [MultiEnvironmentDispatchRecord] {
        dispatched
    }
}

private actor MultiEnvironmentWebSocketConnection: WebSocketConnection {
    private let host: String
    private let log: MultiEnvironmentDispatchLog
    private var queued: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    init(host: String, log: MultiEnvironmentDispatchLog) {
        self.host = host
        self.log = log
    }

    func send(_ data: Data) async throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard case let .number(rawID) = request["id"] else { return }
        let tag = request["tag"]?.stringValue
        let exit: JSONValue
        switch tag {
        case RPCMethod.dispatchCommand.rawValue:
            await log.record(
                MultiEnvironmentDispatchRecord(
                    host: host,
                    command: request["payload"] ?? .null
                )
            )
            exit = .object([
                "_tag": .string("Success"),
                "value": .object(["sequence": .number(2)]),
            ])
        case RPCMethod.launchThread.rawValue:
            await log.record(
                MultiEnvironmentDispatchRecord(
                    host: host,
                    command: request["payload"] ?? .null
                )
            )
            exit = .object([
                "_tag": .string("Success"),
                "value": .object([
                    "threadId": request["payload"]?["threadId"] ?? .string("thread"),
                    "resumed": .bool(false),
                ]),
            ])
        default:
            // Silence, not a failure: a subscription that ends would flip the
            // connection state and turn granular thread events into whole
            // snapshot replacements, which is not what these tests are about.
            return
        }
        enqueue(
            try JSONEncoder.t3.encode(
                JSONValue.object([
                    "_tag": .string("Exit"),
                    "requestId": .number(rawID),
                    "exit": exit,
                ])
            )
        )
    }

    func receive() async throws -> Data {
        if !queued.isEmpty { return queued.removeFirst() }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queued.append(data)
        }
    }
}

private func multiEnvironmentShell(
    projectID: String,
    threadID: String,
    title: String,
    providerID: String = "codex",
    modelID: String = "gpt-5.6-sol"
) -> OrchestrationV2ShellSnapshot {
    var project = V2Fixture.project(
        id: projectID,
        title: title,
        workspaceRoot: "/work/" + projectID
    )
    project = OrchestrationProject(
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        repositoryIdentity: nil,
        defaultModelSelection: ModelSelection(instanceId: providerID, model: modelID),
        scripts: [],
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        deletedAt: nil
    )
    return V2Fixture.shellSnapshot(
        projects: [project],
        threads: [V2Fixture.threadShell(id: threadID, projectID: projectID, title: title)]
    )
}

private func multiEnvironmentDetail(
    projectID: String,
    threadID: String
) -> OrchestrationV2ThreadDetailSnapshot {
    let timestamp = "2026-07-31T12:00:00.000Z"
    return OrchestrationV2ThreadDetailSnapshot(
        snapshotSequence: 2,
        projection: OrchestrationV2ThreadProjection(
            thread: OrchestrationV2AppThread(
                id: threadID,
                projectId: projectID,
                createdBy: "user",
                creationSource: "mobile",
                title: threadID,
                titleRevision: nil,
                titleOrigin: nil,
                providerInstanceId: "codex",
                modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
                runtimeMode: .fullAccess,
                interactionMode: .default,
                branch: "feat/multi-device",
                worktreePath: nil,
                activeProviderThreadId: nil,
                historyOrigin: nil,
                lineage: OrchestrationV2AppThreadLineage(
                    parentThreadId: nil,
                    relationshipToParent: nil,
                    rootThreadId: threadID
                ),
                forkedFrom: nil,
                createdAt: timestamp,
                updatedAt: timestamp,
                archivedAt: nil,
                settledOverride: nil,
                settledAt: nil,
                pinnedAt: nil,
                workInboxRole: nil,
                timelineClearedAt: nil,
                snoozedUntil: nil,
                snoozedAt: nil,
                lastVisitedAt: nil,
                titleRegeneration: nil,
                deletedAt: nil
            ),
            runs: [],
            turnItems: [],
            visibleTurnItems: [],
            truncatedVisibleItemCount: nil,
            updatedAt: timestamp
        )
    )
}

private func multiEnvironmentResponse(_ request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
    )!
}
