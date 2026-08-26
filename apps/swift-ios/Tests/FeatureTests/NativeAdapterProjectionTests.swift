import Foundation
import XCTest
@testable import T3Code

// The adapter surfaces that render from the *relational* half of a thread
// projection, plus the two account/environment capabilities that live outside
// `FeatureClient`. Everything here is about what the client can feed the UI:
// the queue control, the relationship rows, checkpoint rollback, T3 Work's
// backing project, and automations.
@MainActor
final class NativeAdapterProjectionTests: XCTestCase {
    // MARK: - GAP 1: queue, lineage, transfers

    func testThreadDetailCarriesQueueStateFromTheProjection() async throws {
        let fixture = try await makeFixture()
        defer { fixture.tearDown() }

        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try XCTUnwrap(snapshot.threads.first)
        let detail = try await fixture.client.loadThread(id: thread.id)

        let queue = detail.workflow.queueState
        XCTAssertEqual(queue.activeRun?.id, "run-active")
        XCTAssertEqual(queue.queuedRuns.map(\.id), ["run-queued-a", "run-queued-b"])
        // Queue order comes from `queuePosition`, not from ordinal: the two
        // disagree here precisely so the wrong one is visible if it is used.
        XCTAssertEqual(queue.queuedRuns.map(\.text), ["First in line", "Second in line"])
        XCTAssertEqual(queue.queuedRuns.first?.attachmentCount, 0)
        // The session's driver descriptor allows queued messages and active
        // steering, and the active attempt has a running provider turn.
        XCTAssertTrue(queue.canReorder)
        XCTAssertTrue(queue.canPromoteToSteer)
        XCTAssertTrue(detail.workflow.canDetachProviderSession)
        XCTAssertEqual(detail.workflow.providerSession?.id, "session-live")

        await fixture.client.disconnect()
    }

    func testThreadDetailCarriesForkTransferAndSubagentEdgesScopedToTheEnvironment() async throws {
        let fixture = try await makeFixture()
        defer { fixture.tearDown() }

        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try XCTUnwrap(snapshot.threads.first)
        let detail = try await fixture.client.loadThread(id: thread.id)

        func scoped(_ wireID: String) -> String {
            FeatureScopedID.thread(environmentID: "environment-1", wireID: wireID)
        }

        // Every thread id that leaves the projection is feature-scoped, so a row
        // can be matched against the home snapshot and opened.
        let current = try XCTUnwrap(detail.workflow.thread)
        XCTAssertEqual(current.id, scoped("thread-1"))
        XCTAssertEqual(current.parentThreadID, scoped("thread-parent"))
        XCTAssertEqual(current.relationshipToParent, "fork")
        XCTAssertEqual(current.forkedFromRunThreadID, scoped("thread-parent"))
        XCTAssertEqual(
            detail.workflow.transfers.map(\.sourceThreadID),
            [scoped("thread-1")]
        )
        XCTAssertEqual(
            detail.workflow.transfers.map(\.targetThreadID),
            [scoped("thread-transfer-target")]
        )
        XCTAssertEqual(
            detail.workflow.subagents.map(\.childThreadID),
            [scoped("thread-child")]
        )
        // The projection's subagent table is the only source of the
        // observability annotations a relationship row renders.
        XCTAssertEqual(detail.workflow.subagents.first?.workflow?.name, "review")
        XCTAssertEqual(detail.workflow.subagents.first?.usage?.toolUses, 7)

        let relationships = try XCTUnwrap(detail.workflow.relationships())
        XCTAssertEqual(
            Set(relationships.rows.map(\.threadID)),
            [scoped("thread-parent"), scoped("thread-child"), scoped("thread-transfer-target")]
        )
        XCTAssertEqual(
            Set(relationships.rows.map(\.edge.kind)),
            [.fork, .subagent, .transfer]
        )
        // Merge-back targets the fork parent, but the run selection stays
        // empty here: this fixture's newest run is still `running`, and an
        // active run blocks merge-back (see `resolveLatestMergeBackRun`).
        XCTAssertEqual(relationships.mergeTargetThreadID, scoped("thread-parent"))
        XCTAssertNil(relationships.latestMergeBackRunID)
        XCTAssertFalse(relationships.canMerge)
        XCTAssertTrue(relationships.canDetach)

        await fixture.client.disconnect()
    }

    func testEmptyWorkflowKeepsTheQueueAndLineageSurfacesSilent() {
        let workflow = FeatureThreadWorkflow.empty
        XCTAssertEqual(workflow.queueState, .empty)
        XCTAssertNil(workflow.providerSession)
        XCTAssertFalse(workflow.canDetachProviderSession)
        XCTAssertNil(workflow.relationships())
    }

    // MARK: - GAP 4: checkpoint rollback

    func testCheckpointRollbackDispatchesTheForksCommandForAWireThreadID() async throws {
        let fixture = try await makeFixture()
        defer { fixture.tearDown() }

        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try XCTUnwrap(snapshot.threads.first)
        _ = try await fixture.client.loadThread(id: thread.id)

        // The rollback target comes from the projection's checkpoint row, whose
        // thread id is a *wire* id — not the feature-scoped one the rest of the
        // feature layer routes with.
        try await fixture.client.rollBackToCheckpoint(
            threadID: "thread-1",
            scopeID: "scope-1",
            checkpointID: "checkpoint-2"
        )
        // The feature-scoped spelling routes just as well, so a caller that has
        // one does not have to unwrap it first.
        try await fixture.client.rollBackToCheckpoint(
            threadID: thread.id,
            scopeID: "scope-1",
            checkpointID: "checkpoint-3"
        )

        let commands = await fixture.connection.commands()
        let rollbacks = commands.filter {
            $0["type"]?.stringValue == "checkpoint.rollback"
        }
        XCTAssertEqual(rollbacks.count, 2)
        XCTAssertEqual(rollbacks.map { $0["threadId"]?.stringValue }, ["thread-1", "thread-1"])
        XCTAssertEqual(rollbacks.map { $0["scopeId"]?.stringValue }, ["scope-1", "scope-1"])
        XCTAssertEqual(
            rollbacks.map { $0["checkpointId"]?.stringValue },
            ["checkpoint-2", "checkpoint-3"]
        )

        await fixture.client.disconnect()
    }

    // MARK: - GAP 3: T3 Work's backing project

    func testWorkspaceServerConfigsResolveTheHermesConversationTarget() async throws {
        let fixture = try await makeFixture()
        defer { fixture.tearDown() }

        _ = try await fixture.client.initialSnapshot()

        // The catalog read guarantees the config regardless of whether the
        // config subscription's own snapshot already delivered it above.
        _ = try await fixture.client.scheduledTaskModelCatalog(environmentID: "environment-1")

        let configs = fixture.client.workspaceServerConfigs()
        XCTAssertEqual(configs.map(\.environmentID), ["environment-1"])
        XCTAssertEqual(configs.first?.t3WorkDirectory, "/work/t3-work")
        XCTAssertEqual(configs.first?.providers.map(\.instanceId), ["codex", "hermes"])

        let target = MobileWorkspaceRouting.resolveHermesConversationTarget(
            projects: [
                MobileWorkspaceProject(
                    environmentID: "environment-1",
                    project: V2Fixture.project(id: "project-1", workspaceRoot: "/work/t3")
                ),
                MobileWorkspaceProject(
                    environmentID: "environment-1",
                    project: V2Fixture.project(
                        id: "project-work",
                        workspaceRoot: "/work/t3-work"
                    )
                ),
            ],
            serverConfigs: configs,
            requiredEnvironmentID: nil
        )
        XCTAssertEqual(target?.project.project.id, "project-work")
        XCTAssertEqual(target?.modelSelection.instanceId, "hermes")

        await fixture.client.disconnect()
    }

    // MARK: - GAP 2: automations

    func testAutomationsRoundTripThroughTheScheduledTaskRPCs() async throws {
        let fixture = try await makeFixture()
        defer { fixture.tearDown() }

        _ = try await fixture.client.initialSnapshot()

        let tasks = try await fixture.client.loadScheduledTasks(
            environmentID: "environment-1"
        )
        XCTAssertEqual(tasks.map(\.id), ["task-1"])
        let task = try XCTUnwrap(tasks.first)
        XCTAssertEqual(task.schedule, .fixedTime(timeOfDay: "09:00", weekdays: [.monday]))
        XCTAssertEqual(task.projectID, "project-1")
        XCTAssertEqual(task.lastRunStatus, .succeeded)
        XCTAssertEqual(task.launch.modelSelection.instanceId, "codex")
        // Launch settings this form does not edit are held verbatim.
        XCTAssertEqual(task.launch.workspaceStrategy["baseRef"]?.stringValue, "main")

        var draft = AutomationDraft(task: task)
        draft.title = "Renamed automation"
        let upsert = try XCTUnwrap(draft.upsert(editing: task))
        _ = try await fixture.client.upsertScheduledTask(
            environmentID: "environment-1",
            input: upsert
        )
        _ = try await fixture.client.setScheduledTaskEnabled(
            environmentID: "environment-1",
            id: "task-1",
            enabled: false
        )
        _ = try await fixture.client.runScheduledTaskNow(
            environmentID: "environment-1",
            id: "task-1"
        )
        try await fixture.client.deleteScheduledTask(
            environmentID: "environment-1",
            id: "task-1"
        )

        let tags = await fixture.connection.tags()
        XCTAssertEqual(
            tags.filter { $0.hasPrefix("scheduledTasks.") },
            [
                "scheduledTasks.list",
                "scheduledTasks.upsert",
                "scheduledTasks.setEnabled",
                "scheduledTasks.runNow",
                "scheduledTasks.delete",
            ]
        )
        let recordedUpsert = await fixture.connection.payload(
            forTag: "scheduledTasks.upsert"
        )
        let upsertPayload = try XCTUnwrap(recordedUpsert)
        XCTAssertEqual(upsertPayload["id"]?.stringValue, "task-1")
        XCTAssertEqual(upsertPayload["title"]?.stringValue, "Renamed automation")
        // An edit must not rewrite the creation attribution the server recorded.
        XCTAssertNil(upsertPayload["creationSource"])

        await fixture.client.disconnect()
    }

    // MARK: - Fixture

    private func makeFixture() async throws -> AdapterFixture {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-adapter-\(UUID().uuidString)", isDirectory: true)
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)
        let connection = AdapterWebSocketConnection()
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [environment.id: EnvironmentCredential(accessToken: "token")]
            ),
            httpTransport: AdapterHTTPTransport(
                shell: adapterShell(),
                projection: adapterProjection()
            ),
            webSocketConnector: AdapterWebSocketConnector(connection: connection)
        )
        return AdapterFixture(
            directory: directory,
            connection: connection,
            client: NativeFeatureClient(
                runtime: runtime,
                settingsStore: UserDefaults(
                    suiteName: "t3-adapter-\(UUID().uuidString)"
                )!,
                // Keep the background refreshers out of the way: these tests
                // assert on what one command sent, not on polling.
                fallbackPollingInitialDelay: .seconds(600),
                aggregateRefreshInterval: .seconds(600)
            )
        )
    }
}

private struct AdapterFixture {
    let directory: URL
    let connection: AdapterWebSocketConnection
    let client: NativeFeatureClient

    func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }
}

// MARK: - Projection fixture

/// One thread that is a fork, has an active run with two queued behind it, a
/// live provider session, a subagent, and an outgoing context transfer — the
/// shape every surface in GAP 1 needs at once.
private func adapterProjection() -> OrchestrationV2ThreadProjection {
    let thread = OrchestrationV2AppThread(
        id: "thread-1",
        projectId: "project-1",
        createdBy: "user",
        creationSource: "mobile",
        title: "Forked work",
        titleRevision: nil,
        titleOrigin: nil,
        providerInstanceId: "codex",
        modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
        runtimeMode: .fullAccess,
        interactionMode: .default,
        branch: nil,
        worktreePath: nil,
        linkedPullRequest: nil,
        activeProviderThreadId: "provider-thread-1",
        historyOrigin: nil,
        lineage: OrchestrationV2AppThreadLineage(
            parentThreadId: "thread-parent",
            relationshipToParent: "fork",
            rootThreadId: "thread-parent"
        ),
        forkedFrom: .run(threadID: "thread-parent", runID: "run-parent"),
        createdAt: V2Fixture.timestamp,
        updatedAt: V2Fixture.timestamp,
        archivedAt: nil,
        settledOverride: nil,
        settledAt: nil,
        unsettledAt: nil,
        pinnedAt: nil,
        workInboxRole: nil,
        timelineClearedAt: nil,
        snoozedUntil: nil,
        snoozedAt: nil,
        lastVisitedAt: nil,
        titleRegeneration: nil,
        deletedAt: nil
    )

    func run(
        id: String,
        ordinal: Int,
        status: String,
        messageID: String,
        queuePosition: Int? = nil,
        activeAttemptID: String? = nil
    ) -> OrchestrationV2Run {
        OrchestrationV2Run(
            id: id,
            ordinal: ordinal,
            status: status,
            providerInstanceId: "codex",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            providerThreadId: "provider-thread-1",
            userMessageId: messageID,
            activeAttemptId: activeAttemptID,
            queuePosition: queuePosition,
            requestedAt: V2Fixture.timestamp,
            startedAt: V2Fixture.timestamp,
            completedAt: nil
        )
    }

    return OrchestrationV2ThreadProjection(
        thread: thread,
        runs: [
            run(
                id: "run-active",
                ordinal: 1,
                status: "running",
                messageID: "message-active",
                activeAttemptID: "attempt-1"
            ),
            // Ordinal and queue position disagree so the sort is observable.
            run(
                id: "run-queued-b",
                ordinal: 2,
                status: "queued",
                messageID: "message-b",
                queuePosition: 2
            ),
            run(
                id: "run-queued-a",
                ordinal: 3,
                status: "queued",
                messageID: "message-a",
                queuePosition: 1
            ),
        ],
        subagents: [
            OrchestrationV2Subagent(
                id: "subagent-1",
                threadId: "thread-1",
                childThreadId: "thread-child",
                title: "Review the diff",
                origin: "driver",
                status: "running",
                progress: nil,
                result: nil,
                workflow: OrchestrationV2WorkflowProgress(
                    name: "review",
                    description: nil,
                    phases: [],
                    currentPhase: nil,
                    spawnedCount: nil
                ),
                usage: OrchestrationV2TaskUsage(
                    totalTokens: 120,
                    inputTokens: nil,
                    cachedInputTokens: nil,
                    outputTokens: nil,
                    reasoningOutputTokens: nil,
                    toolUses: 7,
                    durationMs: nil
                )
            ),
        ],
        providerSessions: [
            OrchestrationV2ProviderSession(
                id: "session-live",
                status: "running",
                model: "gpt-5.6-sol",
                cwd: "/work/t3",
                capabilities: OrchestrationV2ProviderCapabilities(
                    turns: OrchestrationV2TurnCapabilities(
                        supportsActiveSteering: true,
                        supportsSteeringByInterruptRestart: false,
                        supportsQueuedMessages: true
                    )
                )
            ),
        ],
        providerThreads: [
            OrchestrationV2ProviderThread(
                id: "provider-thread-1",
                providerInstanceId: "codex",
                providerSessionId: "session-live",
                appThreadId: "thread-1",
                status: "running"
            ),
        ],
        providerTurns: [
            OrchestrationV2ProviderTurn(
                id: "provider-turn-1",
                runAttemptId: "attempt-1",
                status: "running"
            ),
        ],
        contextTransfers: [
            OrchestrationV2ContextTransfer(
                id: "transfer-1",
                type: "handoff",
                sourceThreadId: "thread-1",
                targetThreadId: "thread-transfer-target",
                status: "completed",
                resolution: nil
            ),
        ],
        messages: [
            adapterMessage(id: "message-active", text: "Start the work"),
            adapterMessage(id: "message-a", text: "First in line"),
            adapterMessage(id: "message-b", text: "Second in line"),
        ],
        turnItems: [],
        visibleTurnItems: [],
        truncatedVisibleItemCount: nil,
        updatedAt: V2Fixture.timestamp
    )
}

/// Conversation messages decode rather than initialize: the type owns a custom
/// `init(from:)`, so there is no memberwise initializer to call.
private func adapterMessage(id: String, text: String) -> OrchestrationV2ConversationMessage {
    let json = JSONValue.object([
        "id": .string(id),
        "threadId": .string("thread-1"),
        "runId": .null,
        "nodeId": .null,
        "role": .string("user"),
        "text": .string(text),
        "attachments": .array([]),
        "streaming": .bool(false),
        "createdAt": .string(V2Fixture.timestamp),
        "updatedAt": .string(V2Fixture.timestamp),
    ])
    return try! JSONDecoder.t3.decode(
        OrchestrationV2ConversationMessage.self,
        from: try! JSONEncoder.t3.encode(json)
    )
}

private func adapterShell() -> OrchestrationV2ShellSnapshot {
    V2Fixture.shellSnapshot(
        projects: [
            V2Fixture.project(id: "project-1", title: "T3 Code", workspaceRoot: "/work/t3"),
            V2Fixture.project(
                id: "project-work",
                title: "T3 Work",
                workspaceRoot: "/work/t3-work"
            ),
        ],
        threads: [
            V2Fixture.threadShell(
                id: "thread-1",
                title: "Forked work",
                status: "running",
                activeRunID: "run-active"
            ),
        ]
    )
}

// MARK: - Transports

private actor AdapterHTTPTransport: HTTPTransport {
    private let shellData: Data
    private let projectionData: Data

    init(shell: OrchestrationV2ShellSnapshot, projection: OrchestrationV2ThreadProjection) {
        shellData = try! JSONEncoder.t3.encode(shell)
        projectionData = try! JSONEncoder.t3.encode(
            OrchestrationV2ThreadDetailSnapshot(snapshotSequence: 3, projection: projection)
        )
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell" {
            return (shellData, adapterResponse(request))
        }
        if path.hasPrefix("/api/orchestration/threads/") {
            return (projectionData, adapterResponse(request))
        }
        if path == "/api/auth/websocket-ticket" {
            return (
                Data(#"{"ticket":"ticket","expiresAt":"2026-08-01T12:05:00.000Z"}"#.utf8),
                adapterResponse(request)
            )
        }
        throw URLError(.unsupportedURL)
    }
}

private func adapterResponse(_ request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
    )!
}

private struct AdapterWebSocketConnector: WebSocketConnecting {
    let connection: AdapterWebSocketConnection

    func connect(to _: URL) async throws -> any WebSocketConnection {
        connection
    }
}

/// Answers the unary RPCs these tests drive and fails every subscription, which
/// keeps the fixture from depending on live-sync timing.
private actor AdapterWebSocketConnection: WebSocketConnection {
    private var recorded: [(tag: String, payload: JSONValue)] = []
    private var queued: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard case let .number(rawID) = request["id"],
              let tag = request["tag"]?.stringValue else { return }
        recorded.append((tag, request["payload"] ?? .null))
        guard let value = Self.reply(tag: tag) else {
            enqueue(
                try JSONEncoder.t3.encode(
                    JSONValue.object([
                        "_tag": .string("Exit"),
                        "requestId": .number(rawID),
                        "exit": .object([
                            "_tag": .string("Failure"),
                            "cause": .array([
                                .object([
                                    "_tag": .string("Fail"),
                                    "error": .object([
                                        "message": .string("Unsupported in this fixture."),
                                    ]),
                                ]),
                            ]),
                        ]),
                    ])
                )
            )
            return
        }
        enqueue(
            try JSONEncoder.t3.encode(
                JSONValue.object([
                    "_tag": .string("Exit"),
                    "requestId": .number(rawID),
                    "exit": .object([
                        "_tag": .string("Success"),
                        "value": value,
                    ]),
                ])
            )
        )
    }

    private static func reply(tag: String) -> JSONValue? {
        switch tag {
        case RPCMethod.dispatchCommand.rawValue:
            .object(["sequence": .number(4)])
        case RPCMethod.serverGetConfig.rawValue:
            .object([
                "t3WorkDirectory": .string("/work/t3-work"),
                "providers": .array([
                    adapterProvider(instanceID: "codex", driver: "codex"),
                    adapterProvider(instanceID: "hermes", driver: "hermes"),
                ]),
            ])
        case RPCMethod.scheduledTasksList.rawValue:
            .object(["tasks": .array([adapterScheduledTask()])])
        case RPCMethod.scheduledTasksUpsert.rawValue,
             RPCMethod.scheduledTasksSetEnabled.rawValue,
             RPCMethod.scheduledTasksRunNow.rawValue:
            .object(["task": adapterScheduledTask()])
        case RPCMethod.scheduledTasksDelete.rawValue:
            .object(["id": .string("task-1")])
        default:
            nil
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

    func tags() -> [String] {
        recorded.map(\.tag)
    }

    func commands() -> [JSONValue] {
        recorded
            .filter { $0.tag == RPCMethod.dispatchCommand.rawValue }
            .map(\.payload)
    }

    func payload(forTag tag: String) -> JSONValue? {
        recorded.first { $0.tag == tag }?.payload
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

private func adapterProvider(instanceID: String, driver: String) -> JSONValue {
    .object([
        "instanceId": .string(instanceID),
        "driver": .string(driver),
        "enabled": .bool(true),
        "installed": .bool(true),
        "status": .string("ready"),
        "auth": .object(["status": .string("authenticated")]),
        "checkedAt": .string(V2Fixture.timestamp),
        "models": .array([
            .object([
                "slug": .string("default"),
                "name": .string("Default"),
                "isCustom": .bool(false),
            ]),
        ]),
    ])
}

private func adapterScheduledTask() -> JSONValue {
    .object([
        "id": .string("task-1"),
        "title": .string("Morning triage"),
        "prompt": .string("Summarize overnight failures"),
        "enabled": .bool(true),
        "schedule": .object([
            "type": .string("fixed_time"),
            "timeOfDay": .string("09:00"),
            "weekdays": .array([.number(1)]),
        ]),
        "projectId": .string("project-1"),
        "threadId": .null,
        "workspaceStrategy": .object([
            "type": .string("worktree"),
            "baseRef": .string("main"),
        ]),
        "modelSelection": .object([
            "instanceId": .string("codex"),
            "model": .string("gpt-5.6-sol"),
        ]),
        "runtimeMode": .string("full-access"),
        "interactionMode": .string("default"),
        "createdBy": .string("user"),
        "creationSource": .string("web"),
        "createdAt": .string(V2Fixture.timestamp),
        "updatedAt": .string(V2Fixture.timestamp),
        "nextRunAt": .string(V2Fixture.timestamp),
        "lastRunAt": .string(V2Fixture.timestamp),
        "lastRunStatus": .string("succeeded"),
        "lastRunError": .null,
        "runCount": .number(3),
    ])
}
