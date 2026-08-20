import Foundation
import XCTest

@testable import T3Code

/// The shell subscription's opening frame on a resume is a metadata-only
/// enrichment refresh: repository identity for the roots that just resolved,
/// and deliberately empty thread lists. Treating it as an authoritative shell
/// is what emptied Home a second after launch.
@MainActor
final class ShellEnrichmentFrameTests: XCTestCase {
    func testEnrichmentFrameDoesNotEmptyHome() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-shell-enrichment-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let environment = Environment(
            id: "one",
            label: "Left Book",
            httpBaseURL: URL(string: "https://one.example")!,
            webSocketBaseURL: URL(string: "wss://one.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)

        let project = V2Fixture.project(id: "project-one", workspaceRoot: "/work/one")
        let shell = V2Fixture.shellSnapshot(
            sequence: 1,
            projects: [project],
            threads: [
                V2Fixture.threadShell(
                    id: "thread-one",
                    projectID: "project-one",
                    title: "Local work"
                ),
            ]
        )
        let socket = ShellFrameSocket(
            frames: [
                // Frame one: what a resuming client is now sent first.
                .object([
                    "kind": .string("snapshot"),
                    "snapshot": encode(
                        V2Fixture.shellSnapshot(sequence: 1, projects: [project])
                    ),
                    "resolvedRepositoryIdentityRoots": .array([.string("/work/one")]),
                ]),
                // Frame two: an ordinary delta, and this test's sync point.
                .object([
                    "kind": .string("thread.updated"),
                    "sequence": .number(2),
                    "location": .string("active"),
                    "thread": encode(
                        V2Fixture.threadShell(
                            id: "thread-late",
                            projectID: "project-one",
                            title: "Started after launch"
                        )
                    ),
                ]),
            ]
        )
        let client = NativeFeatureClient(
            runtime: EnvironmentRuntime(
                environmentStore: store,
                credentialStore: InMemoryCredentialStore(
                    credentials: [environment.id: EnvironmentCredential(accessToken: "token")]
                ),
                httpTransport: ShellFrameHTTPTransport(shell: shell),
                webSocketConnector: ShellFrameConnector(socket: socket)
            ),
            settingsStore: UserDefaults(
                suiteName: "t3-shell-enrichment-\(UUID().uuidString)"
            )!
        )
        defer { Task { await client.disconnect() } }

        let events = client.events()
        let initial = try await client.initialSnapshot()
        XCTAssertEqual(initial.threads.compactMap(\.wireID), ["thread-one"])

        var threadIDs: Set<String> = ["thread-one"]
        let observed = expectation(description: "the delta after the enrichment frame arrives")
        let watcher = Task {
            for await event in events {
                switch event {
                case let .snapshot(snapshot):
                    threadIDs = Set(snapshot.threads.compactMap(\.wireID))
                case let .thread(thread):
                    if let wireID = thread.wireID { threadIDs.insert(wireID) }
                case let .threadRemoved(id):
                    threadIDs = threadIDs.filter {
                        FeatureScopedID.thread(environmentID: "one", wireID: $0) != id
                    }
                default:
                    break
                }
                if threadIDs.contains("thread-late") {
                    observed.fulfill()
                    return
                }
            }
        }
        await fulfillment(of: [observed], timeout: 5)
        watcher.cancel()

        XCTAssertTrue(
            threadIDs.contains("thread-one"),
            "The enrichment frame carries no threads and must not remove any."
        )
    }

    private func encode(_ value: some Encodable) -> JSONValue {
        try! JSONDecoder.t3.decode(JSONValue.self, from: try! JSONEncoder.t3.encode(value))
    }
}

private struct ShellFrameConnector: WebSocketConnecting {
    let socket: ShellFrameSocket

    func connect(to url: URL) async throws -> any WebSocketConnection { socket }
}

/// Answers `orchestration.subscribeShell` with a scripted frame sequence and
/// stays silent on every other subscription, so the shell stream is the only
/// thing under test.
private actor ShellFrameSocket: WebSocketConnection {
    private let frames: [JSONValue]
    private var queued: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    init(frames: [JSONValue]) {
        self.frames = frames
    }

    func send(_ data: Data) async throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard request["tag"]?.stringValue == RPCMethod.subscribeShell.rawValue,
              case let .number(rawID) = request["id"] else {
            return
        }
        for frame in frames {
            enqueue(
                try JSONEncoder.t3.encode(
                    JSONValue.object([
                        "_tag": .string("Chunk"),
                        "requestId": .number(rawID),
                        "values": .array([frame]),
                    ])
                )
            )
        }
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

private struct ShellFrameHTTPTransport: HTTPTransport {
    let shell: OrchestrationV2ShellSnapshot

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        switch request.url?.path {
        case "/api/orchestration/shell":
            return (try JSONEncoder.t3.encode(shell), response)
        case "/api/auth/websocket-ticket":
            return (
                Data(#"{"ticket":"ticket","expiresAt":"2126-07-31T12:05:00.000Z"}"#.utf8),
                response
            )
        default:
            throw URLError(.unsupportedURL)
        }
    }
}
