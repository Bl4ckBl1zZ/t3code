import XCTest
@testable import T3Code

@MainActor
final class TransportReliabilityTests: XCTestCase {
    func testHTTPPolicyOffersGzipWithoutOverwritingCallerPreference() {
        var request = URLRequest(url: URL(string: "https://studio.example/api")!)
        let prepared = HTTPRequestPolicy.prepare(request)
        XCTAssertEqual(prepared.value(forHTTPHeaderField: "Accept-Encoding"), "gzip")
        XCTAssertEqual(prepared.value(forHTTPHeaderField: "Accept"), "application/json")

        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        XCTAssertEqual(
            HTTPRequestPolicy.prepare(request).value(forHTTPHeaderField: "Accept-Encoding"),
            "identity"
        )
    }

    func testEnvironmentAPIDecodesURLSessionDecompressedGzipResponse() async throws {
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {"repositoryIdentity": true}
            }
            """
            return (
                Data(body.utf8),
                transportResponse(
                    request,
                    headers: [
                        "Content-Type": "application/json",
                        // URLSession retains this response header while
                        // returning the already decompressed body.
                        "Content-Encoding": "gzip",
                    ]
                )
            )
        }
        let api = EnvironmentAPI(
            transport: transport,
            credentials: InMemoryCredentialStore()
        )

        let descriptor = try await api.descriptor(
            at: URL(string: "https://studio.example")!
        )
        XCTAssertEqual(descriptor.environmentId, "environment-1")
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept-Encoding"), "gzip")
    }

    func testShellSnapshotAppliesBoundedStartupTimeout() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = #"{"snapshotSequence":0,"projects":[],"threads":[],"updatedAt":"2026-08-05T12:00:00.000Z"}"#
            return (Data(body.utf8), transportResponse(request))
        }
        let api = EnvironmentAPI(transport: transport, credentials: credentials)

        _ = try await api.shellSnapshot(for: environment, timeoutInterval: 6)

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.timeoutInterval, 6)
    }

    func testThreadSnapshotSendsVisibleItemWindowAndDecodesWithheldCount() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(accessToken: "access-token"),
        ])
        let body = try JSONEncoder.t3.encode(
            OrchestrationV2ThreadDetailSnapshot(
                snapshotSequence: 42,
                projection: windowedProjectionFixture(truncatedVisibleItemCount: 40)
            )
        )
        let transport = RecordingHTTPTransport { request in
            (body, transportResponse(request))
        }
        let api = EnvironmentAPI(transport: transport, credentials: credentials)

        let snapshot = try await api.threadSnapshot(
            id: "thread-1",
            environment: environment,
            maxVisibleItems: 20
        )

        XCTAssertEqual(snapshot.projection.truncatedVisibleItemCount, 40)
        XCTAssertTrue(snapshot.projection.hasOlderItems)
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let query = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            .queryItems
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: (query ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }),
            ["maxVisibleItems": "20"]
        )
    }

    /// Project-scoped thread ids carry colons, and the server matches the path
    /// segment after exactly one round of percent-decoding. Escaping the id
    /// before it reaches `URLComponents.path` encoded it twice and turned every
    /// open of such a thread into `thread_not_found`.
    func testThreadSnapshotSendsProjectScopedIdWithoutDoubleEncoding() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(accessToken: "access-token"),
        ])
        let body = try JSONEncoder.t3.encode(
            OrchestrationV2ThreadDetailSnapshot(
                snapshotSequence: 1,
                projection: windowedProjectionFixture(truncatedVisibleItemCount: 0)
            )
        )
        let transport = RecordingHTTPTransport { request in
            (body, transportResponse(request))
        }
        let api = EnvironmentAPI(transport: transport, credentials: credentials)
        let threadID = "thread:project:6848ee2d-f2cc-43d6-ad8a-7a669b24120c:"
            + "c3214a51-04d5-48f2-9a26-97b8b9f41338"

        _ = try await api.threadSnapshot(id: threadID, environment: environment)

        let requests = await transport.requests
        let url = try XCTUnwrap(requests.first?.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertFalse(components.percentEncodedPath.contains("%25"))
        XCTAssertEqual(components.path, "/api/orchestration/threads/\(threadID)")
    }

    func testWebSocketHandshakeOffersPerMessageDeflate() {
        let url = URL(string: "wss://studio.example/ws?wsTicket=secret")!
        let compressed = WebSocketHandshakeRequest.make(url: url)
        XCTAssertEqual(
            compressed.value(forHTTPHeaderField: "Sec-WebSocket-Extensions"),
            "permessage-deflate; client_max_window_bits"
        )
        XCTAssertNil(
            WebSocketHandshakeRequest.make(
                url: url,
                offersPerMessageDeflate: false
            ).value(forHTTPHeaderField: "Sec-WebSocket-Extensions")
        )
    }

    func testBootstrapUsesTheThreadLaunchRPC() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "ticket": "websocket-ticket",
              "expiresAt": "2026-07-30T12:05:00.000Z"
            }
            """
            return (Data(body.utf8), transportResponse(request))
        }
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )

        let result = try await client.createThreadAndSend(
            threadID: "thread-first-send",
            projectID: "project-1",
            title: "Native first send",
            text: "Start from this message",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            runtimeMode: .fullAccess,
            commandID: "stable-command",
            messageID: "stable-message"
        )
        await client.disconnect()

        XCTAssertEqual(result.threadId, "thread-first-send")
        XCTAssertFalse(result.resumed)
        let requests = await connection.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?["tag"]?.stringValue, "orchestration.launchThread")
        XCTAssertEqual(requests.first?["payload"]?["projectId"]?.stringValue, "project-1")
        XCTAssertEqual(requests.first?["payload"]?["commandId"]?.stringValue, "stable-command")
        XCTAssertEqual(
            requests.first?["payload"]?["initialMessage"]?["messageId"]?.stringValue,
            "stable-message"
        )
        XCTAssertEqual(
            requests.first?["payload"]?["workspaceStrategy"]?["type"]?.stringValue,
            "root"
        )

        let httpRequests = await transport.requests
        XCTAssertEqual(httpRequests.map(\.url?.path), ["/api/auth/websocket-ticket"])
    }

    /// Commands are WebSocket-only on this fork.
    ///
    /// `EnvironmentOrchestrationHttpApi` serves the shell and thread-snapshot
    /// GETs and nothing else, so an HTTP dispatch fallback could only ever
    /// answer 404 — and a 404 read as a command failure hides the fact that the
    /// socket is down. An unsent command surfaces its `RPCError` instead, and
    /// the only HTTP request a disconnected client makes is the socket ticket.
    func testCommandsSurfaceTheSocketFailureRatherThanPostingToAMissingEndpoint() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "ticket": "websocket-ticket",
              "expiresAt": "2026-07-30T12:05:00.000Z"
            }
            """
            return (Data(body.utf8), transportResponse(request))
        }
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: FailingWebSocketConnector(),
            rpcConnectionWaitTimeout: .milliseconds(30)
        )

        do {
            _ = try await client.rename(threadID: "thread-1", title: "Renamed")
            XCTFail("A command must not report success while the socket is down.")
        } catch let error as RPCError {
            guard case .connectionUnavailable = error else {
                return XCTFail("Unexpected RPC error: \(error)")
            }
        }

        do {
            _ = try await client.createThreadAndSend(
                threadID: "thread-first-send",
                projectID: "project-1",
                title: "Native first send",
                text: "Start from this message",
                model: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
                runtimeMode: .fullAccess
            )
            XCTFail("Bootstrap must not use the HTTP endpoint that cannot expand it.")
        } catch let error as RPCError {
            guard case .connectionUnavailable = error else {
                return XCTFail("Unexpected RPC error: \(error)")
            }
        }
        await client.disconnect()

        let requests = await transport.requests
        XCTAssertEqual(
            Set(requests.compactMap(\.url?.path)),
            ["/api/auth/websocket-ticket"]
        )
    }

    func testCheckpointRollbackNamesBothTheScopeAndTheCheckpoint() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    environment.id: EnvironmentCredential(accessToken: "access-token"),
                ]
            ),
            httpTransport: RecordingHTTPTransport { request in
                let body = """
                {"ticket":"websocket-ticket","expiresAt":"2026-07-30T12:05:00.000Z"}
                """
                return (Data(body.utf8), transportResponse(request))
            },
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )

        _ = try await client.rollBackToCheckpoint(
            threadID: "thread-1",
            scopeID: "scope-1",
            checkpointID: "checkpoint-3",
            commandID: "stable-rollback"
        )
        await client.disconnect()

        let requests = await connection.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(
            requests.first?["tag"]?.stringValue,
            RPCMethod.dispatchCommand.rawValue
        )
        let command = try XCTUnwrap(requests.first?["payload"])
        XCTAssertEqual(command["type"]?.stringValue, "checkpoint.rollback")
        XCTAssertEqual(command["commandId"]?.stringValue, "stable-rollback")
        XCTAssertEqual(command["threadId"]?.stringValue, "thread-1")
        XCTAssertEqual(command["scopeId"]?.stringValue, "scope-1")
        XCTAssertEqual(command["checkpointId"]?.stringValue, "checkpoint-3")
    }

    func testScheduledTaskUpsertMatchesTheContractInput() throws {
        let created = try ScheduledTaskUpsert(
            title: "Morning triage",
            prompt: "Summarize overnight failures",
            enabled: true,
            schedule: .fixedTime(timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5]),
            projectID: "project-1",
            threadID: nil,
            workspaceStrategy: .object([
                "type": .string("worktree"),
                "baseRef": .string("main"),
            ]),
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            creationSource: "mobile"
        ).jsonValue(commandID: "stable-upsert")

        XCTAssertNil(created["id"])
        XCTAssertEqual(created["commandId"]?.stringValue, "stable-upsert")
        XCTAssertEqual(created["title"]?.stringValue, "Morning triage")
        XCTAssertEqual(created["projectId"]?.stringValue, "project-1")
        // Optional *and* nullable on the wire: an explicit null is what clears a
        // pinned thread back to "start a fresh thread per run".
        XCTAssertEqual(created["threadId"], JSONValue.null)
        XCTAssertEqual(created["schedule"]?["type"]?.stringValue, "fixed_time")
        XCTAssertEqual(created["schedule"]?["timeOfDay"]?.stringValue, "09:00")
        XCTAssertEqual(
            created["schedule"]?["weekdays"],
            JSONValue.array([.number(1), .number(2), .number(3), .number(4), .number(5)])
        )
        XCTAssertEqual(created["workspaceStrategy"]?["baseRef"]?.stringValue, "main")
        XCTAssertEqual(created["modelSelection"]?["instanceId"]?.stringValue, "codex")
        XCTAssertEqual(created["runtimeMode"]?.stringValue, "full-access")
        XCTAssertEqual(created["interactionMode"]?.stringValue, "default")
        XCTAssertEqual(created["creationSource"]?.stringValue, "mobile")
        XCTAssertEqual(created["createdBy"]?.stringValue, "user")

        // An edit keeps the creation attribution the server already recorded.
        let edited = try ScheduledTaskUpsert(
            id: "task-1",
            title: "Morning triage",
            prompt: "Summarize overnight failures",
            enabled: false,
            schedule: .interval(everyMs: 900_000),
            projectID: "project-1",
            threadID: "thread-7",
            workspaceStrategy: .object(["type": .string("root")]),
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.4")
        ).jsonValue(commandID: "stable-edit")

        XCTAssertEqual(edited["id"]?.stringValue, "task-1")
        XCTAssertEqual(edited["threadId"]?.stringValue, "thread-7")
        XCTAssertEqual(edited["schedule"]?["type"]?.stringValue, "interval")
        XCTAssertEqual(edited["schedule"]?["everyMs"], JSONValue.number(900_000))
        XCTAssertNil(edited["creationSource"])
        XCTAssertNil(edited["createdBy"])
    }

    func testScheduledTaskRecordDecodesBothScheduleShapes() throws {
        let json = """
        {
          "tasks": [
            {
              "id": "task-1",
              "title": "Nightly",
              "prompt": "Run the suite",
              "enabled": true,
              "schedule": {"type": "fixed_time", "timeOfDay": "23:30"},
              "projectId": "project-1",
              "threadId": null,
              "workspaceStrategy": {"type": "worktree", "baseRef": "main"},
              "modelSelection": {"instanceId": "codex", "model": "gpt-5.4"},
              "runtimeMode": "full-access",
              "interactionMode": "default",
              "createdBy": "user",
              "creationSource": "web",
              "createdAt": "2026-07-31T12:00:00.000Z",
              "updatedAt": "2026-07-31T12:00:00.000Z",
              "nextRunAt": "2026-08-01T23:30:00.000Z",
              "lastRunAt": null,
              "lastRunStatus": "never",
              "lastRunError": null,
              "runCount": 0
            },
            {
              "id": "task-2",
              "title": "Every quarter hour",
              "prompt": "Check the queue",
              "enabled": false,
              "schedule": {"type": "interval", "everyMs": 900000},
              "projectId": "project-2",
              "threadId": "thread-9",
              "workspaceStrategy": {"type": "root"},
              "modelSelection": {"instanceId": "claudeAgent", "model": "opus"},
              "runtimeMode": "full-access",
              "interactionMode": "default",
              "createdBy": "user",
              "creationSource": "mobile",
              "createdAt": "2026-07-31T12:00:00.000Z",
              "updatedAt": "2026-07-31T12:00:00.000Z",
              "nextRunAt": null,
              "lastRunAt": "2026-07-31T11:45:00.000Z",
              "lastRunStatus": "failed",
              "lastRunError": "boom",
              "runCount": 4
            }
          ]
        }
        """
        struct Payload: Decodable { let tasks: [ScheduledTaskRecord] }
        let tasks = try JSONDecoder.t3.decode(Payload.self, from: Data(json.utf8)).tasks

        XCTAssertEqual(tasks.count, 2)
        // Absent weekdays mean every day, which has to stay distinguishable
        // from an empty list.
        XCTAssertEqual(tasks[0].schedule, .fixedTime(timeOfDay: "23:30", weekdays: nil))
        XCTAssertNil(tasks[0].threadId)
        XCTAssertEqual(tasks[0].workspaceStrategy["baseRef"]?.stringValue, "main")
        XCTAssertEqual(tasks[1].schedule, .interval(everyMs: 900_000))
        XCTAssertEqual(tasks[1].threadId, "thread-9")
        XCTAssertEqual(tasks[1].lastRunStatus, "failed")
        XCTAssertEqual(tasks[1].runCount, 4)
    }

    /// Set `T3_SWIFT_WS_DEFLATE_ECHO_URL` to a WebSocket endpoint that rejects
    /// non-deflate handshakes and echoes binary frames. This is intentionally
    /// opt-in because XCTest does not own a Node process. A successful round
    /// trip proves URLSession accepted the server's compressed frame.
    func testLivePerMessageDeflateRoundTripWhenConfigured() async throws {
        guard let value = ProcessInfo.processInfo.environment[
            "T3_SWIFT_WS_DEFLATE_ECHO_URL"
        ], let url = URL(string: value) else {
            throw XCTSkip("Set T3_SWIFT_WS_DEFLATE_ECHO_URL for live compression proof.")
        }
        let connection = try await URLSessionWebSocketConnector().connect(to: url)
        defer { Task { await connection.close() } }
        let payload = Data(repeating: 0x54, count: 64 * 1024)
        try await connection.send(payload)
        let echoed = try await connection.receive()
        XCTAssertEqual(echoed, payload)
    }

    func testPairingInputParsesClipboardQRHostedAndLooseFormats() throws {
        let direct = try PairingURL.parseFields(
            " https://studio.example:3773/pair#token=N735%4BQXJ "
        )
        XCTAssertEqual(direct.host, "https://studio.example:3773")
        XCTAssertEqual(direct.pairingCode, "N735KQXJ")

        let hosted = try PairingURL.parseFields(
            "https://app.t3.codes/pair?host=http%3A%2F%2F192.168.1.7%3A18773"
                + "&label=Big%20O#token=PAIRING"
        )
        XCTAssertEqual(hosted.host, "http://192.168.1.7:18773")
        XCTAssertEqual(hosted.pairingCode, "PAIRING")
        XCTAssertEqual(hosted.label, "Big O")

        let loose = try PairingURL.parseFields("192.168.1.7:18773 N735KQXJ5SJW")
        XCTAssertEqual(loose.host, "https://192.168.1.7:18773")
        XCTAssertEqual(loose.pairingCode, "N735KQXJ5SJW")

        let wrapped = try PairingURL.pairingURL(
            fromQRCode: "t3code://pair?pairingUrl=https%3A%2F%2Fstudio.example"
                + "%2Fpair%23token%3DQR-CODE"
        )
        XCTAssertEqual(wrapped, "https://studio.example/pair#token=QR-CODE")
        XCTAssertEqual(try PairingURL.parseFields(wrapped).pairingCode, "QR-CODE")
    }

    func testSplitPairingFieldsAcceptCompleteURLInHostField() throws {
        let target = try PairingURL.resolve(
            host: "http://192.168.1.7:18773/pair#token=FROM-URL",
            pairingCode: ""
        )
        XCTAssertEqual(target.credential, "FROM-URL")
        XCTAssertEqual(target.httpBaseURL.absoluteString, "http://192.168.1.7:18773/")
        XCTAssertEqual(target.webSocketBaseURL.absoluteString, "ws://192.168.1.7:18773/")
    }

    func testLocalNetworkProbeClassificationDistinguishesFailureModes() {
        XCTAssertTrue(LocalNetworkProbe.isLocalHost("192.168.20.4"))
        XCTAssertTrue(LocalNetworkProbe.isLocalHost("studio.local"))
        XCTAssertFalse(LocalNetworkProbe.isLocalHost("app.t3.codes"))

        let denied = NSError(
            domain: NSURLErrorDomain,
            code: URLError.notConnectedToInternet.rawValue,
            userInfo: [
                NSUnderlyingErrorKey: NSError(
                    domain: NSPOSIXErrorDomain,
                    code: 13
                ),
            ]
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(denied, host: "192.168.20.4", isLocal: true),
            .likelyLocalNetworkDenied("192.168.20.4")
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(
                URLError(.timedOut),
                host: "studio.local",
                isLocal: true
            ),
            .timeout("studio.local")
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(
                URLError(.cannotConnectToHost),
                host: "studio.local",
                isLocal: true
            ),
            .unavailableHost("studio.local")
        )
    }

}

private func windowedProjectionFixture(
    truncatedVisibleItemCount: Int
) -> OrchestrationV2ThreadProjection {
    OrchestrationV2ThreadProjection(
        thread: OrchestrationV2AppThread(
            id: "thread-1",
            projectId: "project-1",
            createdBy: "user",
            creationSource: "mobile",
            title: "Long native thread",
            titleRevision: nil,
            titleOrigin: nil,
            providerInstanceId: "codex",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: "main",
            worktreePath: nil,
            linkedPullRequest: nil,
            activeProviderThreadId: nil,
            historyOrigin: nil,
            lineage: OrchestrationV2AppThreadLineage(
                parentThreadId: nil,
                relationshipToParent: nil,
                rootThreadId: "thread-1"
            ),
            forkedFrom: nil,
            createdAt: "2026-08-06T12:00:00.000Z",
            updatedAt: "2026-08-06T12:00:00.000Z",
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
        truncatedVisibleItemCount: truncatedVisibleItemCount,
        updatedAt: "2026-08-06T12:00:00.000Z"
    )
}

private func transportResponse(
    _ request: URLRequest,
    status: Int = 200,
    headers: [String: String] = ["Content-Type": "application/json"]
) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: headers
    )!
}

private actor RecordingHTTPTransport: HTTPTransport {
    typealias Handler = @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)

    private(set) var requests: [URLRequest] = []
    private let handler: Handler

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return try handler(request)
    }
}

private struct StaticWebSocketConnector: WebSocketConnecting {
    let connection: RecordingWebSocketConnection

    func connect(to _: URL) async throws -> any WebSocketConnection {
        connection
    }
}

private struct FailingWebSocketConnector: WebSocketConnecting {
    func connect(to _: URL) async throws -> any WebSocketConnection {
        throw URLError(.cannotConnectToHost)
    }
}

private actor RecordingWebSocketConnection: WebSocketConnection {
    private var recordedRequests: [JSONValue] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        recordedRequests.append(request)
        guard case let .number(rawID) = request["id"] else { return }
        // launchThread answers with the launched thread; every other RPC here
        // is a dispatched command, which answers with a sequence.
        let value: JSONValue = if request["tag"]?.stringValue == RPCMethod.launchThread.rawValue {
            .object([
                "threadId": request["payload"]?["threadId"] ?? .string("thread"),
                "resumed": .bool(false),
            ])
        } else {
            .object(["sequence": .number(42)])
        }
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(rawID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": value,
            ]),
        ])
        enqueue(try JSONEncoder.t3.encode(response))
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func requests() -> [JSONValue] {
        recordedRequests
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }
}
