import XCTest
@testable import T3Code

@MainActor
final class CoreContractTests: XCTestCase {
    func testJSONValueRoundTripsLargeIntegersWithoutDoubleRounding() throws {
        let signedData = Data("9007199254740993".utf8)
        let signed = try JSONDecoder.t3.decode(JSONValue.self, from: signedData)
        XCTAssertEqual(signed, .integer(9_007_199_254_740_993))
        XCTAssertEqual(try JSONEncoder.t3.encode(signed), signedData)

        let unsignedData = Data("18446744073709551615".utf8)
        let unsigned = try JSONDecoder.t3.decode(JSONValue.self, from: unsignedData)
        XCTAssertEqual(unsigned, .unsignedInteger(UInt64.max))
        XCTAssertEqual(try JSONEncoder.t3.encode(unsigned), unsignedData)
    }

    func testDirectAndHostedPairingURLsResolveLikeExistingClients() throws {
        let direct = try PairingURL.resolve("https://studio.example/pair#token=secret")
        XCTAssertEqual(direct.credential, "secret")
        XCTAssertEqual(direct.httpBaseURL.absoluteString, "https://studio.example/")
        XCTAssertEqual(direct.webSocketBaseURL.absoluteString, "wss://studio.example/")

        let hosted = try PairingURL.resolve(
            "https://app.t3.codes/pair?host=https%3A%2F%2Fremote.example#token=hosted-secret"
        )
        XCTAssertEqual(hosted.credential, "hosted-secret")
        XCTAssertEqual(hosted.httpBaseURL.absoluteString, "https://remote.example/")
        XCTAssertEqual(hosted.webSocketBaseURL.absoluteString, "wss://remote.example/")
    }

    func testShellSnapshotDecodesCurrentWireShape() throws {
        let data = Data(
            """
            {
              "snapshotSequence": 7,
              "projects": [{
                "id": "project-1",
                "title": "T3 Code",
                "workspaceRoot": "/work/t3",
                "defaultModelSelection": {
                  "instanceId": "codex",
                  "model": "gpt-5.6-sol"
                },
                "scripts": [],
                "createdAt": "2026-07-30T12:00:00.000Z",
                "updatedAt": "2026-07-30T12:00:00.000Z"
              }],
              "schemaVersion": 1,
              "threads": [],
              "archivedThreads": []
            }
            """.utf8
        )

        let snapshot = try JSONDecoder.t3.decode(OrchestrationV2ShellSnapshot.self, from: data)
        XCTAssertEqual(snapshot.snapshotSequence, 7)
        XCTAssertEqual(snapshot.projects.first?.defaultModelSelection?.instanceId, "codex")
        XCTAssertNil(snapshot.projects.first?.deletedAt)
        XCTAssertTrue(snapshot.archivedThreads.isEmpty)
    }

    /// This fork windows cold loads instead of paginating them, so the snapshot
    /// reports how many older visible items it withheld rather than handing back
    /// a cursor.
    func testThreadSnapshotReportsWithheldHistory() throws {
        let snapshot = try JSONDecoder.t3.decode(
            OrchestrationV2ThreadDetailSnapshot.self,
            from: Data(
                #"{"snapshotSequence":42,"projection":{"thread":{"id":"t","projectId":"p","createdBy":"user","creationSource":"web","title":"T","providerInstanceId":"codex","modelSelection":{"instanceId":"codex","model":"m"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"activeProviderThreadId":null,"lineage":{"parentThreadId":null,"relationshipToParent":null,"rootThreadId":"t"},"forkedFrom":null,"createdAt":"2026-07-30T12:00:00.000Z","updatedAt":"2026-07-30T12:00:00.000Z","archivedAt":null,"settledOverride":null,"settledAt":null,"lastVisitedAt":null,"deletedAt":null},"runs":[],"turnItems":[],"visibleTurnItems":[],"truncatedVisibleItemCount":12,"updatedAt":"2026-07-30T12:00:00.000Z"}}"#.utf8
            )
        )

        XCTAssertEqual(snapshot.snapshotSequence, 42)
        XCTAssertEqual(snapshot.projection.truncatedVisibleItemCount, 12)
        XCTAssertTrue(snapshot.projection.hasOlderItems)
    }

    func testServerConfigAdvertisesThreadSnapshotWindowing() throws {
        let config = try JSONDecoder.t3.decode(
            ServerConfigSnapshot.self,
            from: Data(#"{"providers":[],"threadSnapshotWindow":true}"#.utf8)
        )

        XCTAssertEqual(config.threadSnapshotWindow, true)
    }

    /// `OrchestrationV2Command`'s union members, verbatim from
    /// `packages/contracts/src/orchestrationV2.ts`. A command carrying any
    /// other tag fails schema validation before it reaches a handler, which is
    /// exactly how the vendored upstream write path broke: it emitted V1 tags
    /// this fork never defined.
    private static let contractCommandTypes: Set<String> = [
        "thread.create", "thread.archive", "thread.unarchive", "thread.delete",
        "thread.settle", "thread.unsettle", "thread.snooze", "thread.unsnooze",
        "thread.visit", "thread.mark-unread", "thread.metadata.update",
        "thread.runtime-mode.set", "thread.interaction-mode.set",
        "thread.model-selection.set", "provider-session.detach", "message.dispatch",
        "prepared-run.release", "prepared-run.progress", "prepared-run.fail",
        "run.interrupt", "queued-message.promote-to-steer", "queued-run.reorder",
        "queued-run.cancel", "queued-run.edit", "runtime-request.respond",
        "checkpoint.rollback", "thread.fork", "thread.merge_back",
        "delegated_task.request", "delegated_task.wake-policy",
        "thread.created.record", "provider.switch",
    ]

    private static func everyDispatchedCommand() throws -> [JSONValue] {
        let model = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        return [
            try OrchestrationCommands.createThread(
                projectID: "project-1",
                title: "Native rebuild",
                model: model,
                runtimeMode: .fullAccess
            ),
            try OrchestrationCommands.sendTurn(threadID: "thread-1", text: "Go"),
            OrchestrationCommands.archive(threadID: "thread-1", archived: true),
            OrchestrationCommands.archive(threadID: "thread-1", archived: false),
            OrchestrationCommands.deleteThread(threadID: "thread-1"),
            OrchestrationCommands.rename(threadID: "thread-1", title: "Renamed"),
            OrchestrationCommands.interrupt(threadID: "thread-1", runID: "run-1"),
            OrchestrationCommands.respondToApproval(
                threadID: "thread-1",
                requestID: "request-1",
                decision: "accept"
            ),
            OrchestrationCommands.respondToUserInput(
                threadID: "thread-1",
                requestID: "request-1",
                answers: ["name": .string("value")]
            ),
            OrchestrationCommands.settle(threadID: "thread-1", settled: true),
            OrchestrationCommands.settle(threadID: "thread-1", settled: false),
            OrchestrationCommands.snooze(threadID: "thread-1", until: Date()),
            OrchestrationCommands.snooze(threadID: "thread-1", until: nil),
            OrchestrationCommands.pin(threadID: "thread-1", pinned: true),
            OrchestrationCommands.pin(threadID: "thread-1", pinned: false),
            OrchestrationCommands.setRuntimeMode(threadID: "thread-1", mode: .fullAccess),
            OrchestrationCommands.setInteractionMode(threadID: "thread-1", mode: .plan),
        ]
    }

    /// The regression guard the vendored client never had: no builder may emit
    /// a tag outside the union, and every one has to carry the two fields the
    /// dispatch envelope requires of all of them.
    func testEveryBuilderEmitsAContractCommandTypeWithAnIdentity() throws {
        for command in try Self.everyDispatchedCommand() {
            let type = try XCTUnwrap(command["type"]?.stringValue)
            XCTAssertTrue(
                Self.contractCommandTypes.contains(type),
                "\(type) is not a member of OrchestrationV2Command"
            )
            XCTAssertNotNil(command["commandId"]?.stringValue, "\(type) is missing commandId")
            XCTAssertNotNil(command["threadId"]?.stringValue, "\(type) is missing threadId")
        }
    }

    func testCommandBuildersMatchOrchestrationContract() throws {
        let model = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
        let command = try OrchestrationCommands.createThread(
            threadID: "thread-1",
            projectID: "project-1",
            title: "Native rebuild",
            model: model,
            runtimeMode: .fullAccess,
            branch: "main",
            commandID: "command-1",
            createdAt: "2026-07-30T12:00:00.000Z"
        )

        XCTAssertEqual(command["type"]?.stringValue, "thread.create")
        XCTAssertEqual(command["threadId"]?.stringValue, "thread-1")
        XCTAssertEqual(command["modelSelection"]?["instanceId"]?.stringValue, "codex")
        XCTAssertEqual(command["runtimeMode"]?.stringValue, "full-access")
        XCTAssertEqual(command["interactionMode"]?.stringValue, "default")
        // OrchestrationV2CreationFields: both are required, and a missing
        // creationSource silently books phone work as web activity.
        XCTAssertEqual(command["createdBy"]?.stringValue, "user")
        XCTAssertEqual(command["creationSource"]?.stringValue, "mobile")
        XCTAssertEqual(command["branch"]?.stringValue, "main")
        XCTAssertEqual(command["worktreePath"], .null)

        let archived = OrchestrationCommands.archive(threadID: "thread-1", archived: true)
        XCTAssertEqual(archived["type"]?.stringValue, "thread.archive")
        XCTAssertEqual(
            OrchestrationCommands.archive(threadID: "thread-1", archived: false)["type"]?
                .stringValue,
            "thread.unarchive"
        )

        let settled = OrchestrationCommands.settle(threadID: "thread-1", settled: true)
        XCTAssertEqual(settled["type"]?.stringValue, "thread.settle")
        let unsettled = OrchestrationCommands.settle(threadID: "thread-1", settled: false)
        XCTAssertEqual(unsettled["type"]?.stringValue, "thread.unsettle")
        XCTAssertEqual(unsettled["reason"]?.stringValue, "user")

        let snoozed = OrchestrationCommands.snooze(
            threadID: "thread-1",
            until: Date(timeIntervalSince1970: 1_785_000_000)
        )
        XCTAssertEqual(snoozed["type"]?.stringValue, "thread.snooze")
        XCTAssertNotNil(snoozed["snoozedUntil"]?.stringValue)
        let unsnoozed = OrchestrationCommands.snooze(threadID: "thread-1", until: nil)
        XCTAssertEqual(unsnoozed["type"]?.stringValue, "thread.unsnooze")
        XCTAssertEqual(unsnoozed["reason"]?.stringValue, "user")

        let runtimeMode = OrchestrationCommands.setRuntimeMode(
            threadID: "thread-1",
            mode: .approvalRequired
        )
        XCTAssertEqual(runtimeMode["type"]?.stringValue, "thread.runtime-mode.set")
        XCTAssertEqual(runtimeMode["runtimeMode"]?.stringValue, "approval-required")
        // The contract's mode commands carry no timestamp.
        XCTAssertNil(runtimeMode["createdAt"])

        let interactionMode = OrchestrationCommands.setInteractionMode(
            threadID: "thread-1",
            mode: .plan
        )
        XCTAssertEqual(interactionMode["type"]?.stringValue, "thread.interaction-mode.set")
        XCTAssertEqual(interactionMode["interactionMode"]?.stringValue, "plan")
        XCTAssertNil(interactionMode["createdAt"])
    }

    /// Renaming and pinning are thread metadata fields in this fork, not
    /// commands of their own.
    func testRenameAndPinTravelAsThreadMetadataUpdates() {
        let rename = OrchestrationCommands.rename(
            threadID: "thread-1",
            title: "Renamed",
            commandID: "command-rename"
        )
        XCTAssertEqual(rename["type"]?.stringValue, "thread.metadata.update")
        XCTAssertEqual(rename["threadId"]?.stringValue, "thread-1")
        XCTAssertEqual(rename["title"]?.stringValue, "Renamed")
        XCTAssertNil(rename["pinned"])

        let pin = OrchestrationCommands.pin(
            threadID: "thread-1",
            pinned: true,
            commandID: "command-pin"
        )
        XCTAssertEqual(pin["type"]?.stringValue, "thread.metadata.update")
        XCTAssertEqual(pin["pinned"], .bool(true))
        XCTAssertNil(pin["title"])

        let unpin = OrchestrationCommands.pin(threadID: "thread-1", pinned: false)
        XCTAssertEqual(unpin["type"]?.stringValue, "thread.metadata.update")
        XCTAssertEqual(unpin["pinned"], .bool(false))
    }

    func testSendTurnDispatchesAMessageWithCreationProvenance() throws {
        let command = try OrchestrationCommands.sendTurn(
            threadID: "thread-1",
            text: "Ship it",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            commandID: "command-send",
            messageID: "message-send"
        )

        XCTAssertEqual(command["type"]?.stringValue, "message.dispatch")
        XCTAssertEqual(command["commandId"]?.stringValue, "command-send")
        XCTAssertEqual(command["threadId"]?.stringValue, "thread-1")
        // The message is flat on the command: there is no `message` envelope,
        // no `role`, and no `createdAt` in this fork's contract.
        XCTAssertEqual(command["messageId"]?.stringValue, "message-send")
        XCTAssertEqual(command["text"]?.stringValue, "Ship it")
        XCTAssertNil(command["message"])
        XCTAssertNil(command["createdAt"])
        XCTAssertNil(command["runtimeMode"])
        XCTAssertNil(command["interactionMode"])
        XCTAssertEqual(command["createdBy"]?.stringValue, "user")
        XCTAssertEqual(command["creationSource"]?.stringValue, "mobile")
        XCTAssertEqual(command["modelSelection"]?["model"]?.stringValue, "gpt-5.4")
        XCTAssertEqual(command["attachments"], .array([]))
        XCTAssertEqual(command["dispatchMode"]?["type"]?.stringValue, "start_immediately")

        let withoutModel = try OrchestrationCommands.sendTurn(threadID: "thread-1", text: "Go")
        XCTAssertNil(withoutModel["modelSelection"])
    }

    func testDispatchModesMatchTheContractUnion() throws {
        let modes: [(MessageDispatchMode, String, String?)] = [
            (.startImmediately, "start_immediately", nil),
            (.queueAfterActive, "queue_after_active", nil),
            (.deferStart, "defer_start", nil),
            (.steerActive(runID: "run-1"), "steer_active", "run-1"),
            (.restartActive(runID: "run-2"), "restart_active", "run-2"),
        ]

        for (mode, type, targetRunID) in modes {
            let command = try OrchestrationCommands.sendTurn(
                threadID: "thread-1",
                text: "Go",
                dispatchMode: mode
            )
            XCTAssertEqual(command["dispatchMode"]?["type"]?.stringValue, type)
            XCTAssertEqual(command["dispatchMode"]?["targetRunId"]?.stringValue, targetRunID)
        }
    }

    /// Attachments reach `message.dispatch` already persisted: the command
    /// carries stored `ChatAttachment` values, never composer uploads.
    func testSendTurnCarriesPersistedAttachmentsUntouched() throws {
        let persisted = JSONValue.object([
            "type": .string("pdf"),
            "id": .string("attachment-1"),
            "name": .string("spec.pdf"),
            "mimeType": .string("application/pdf"),
            "sizeBytes": .number(2048),
        ])

        let command = try OrchestrationCommands.sendTurn(
            threadID: "thread-1",
            text: "Read this",
            attachments: [persisted]
        )

        XCTAssertEqual(command["attachments"], .array([persisted]))
    }

    func testInterruptNamesTheRunItStops() {
        let command = OrchestrationCommands.interrupt(
            threadID: "thread-1",
            runID: "run-7",
            commandID: "command-interrupt"
        )

        XCTAssertEqual(command["type"]?.stringValue, "run.interrupt")
        XCTAssertEqual(command["threadId"]?.stringValue, "thread-1")
        XCTAssertEqual(command["runId"]?.stringValue, "run-7")
        XCTAssertNil(command["turnId"])
        XCTAssertNil(command["reason"])
        XCTAssertNil(command["createdAt"])

        let withReason = OrchestrationCommands.interrupt(
            threadID: "thread-1",
            runID: "run-7",
            reason: "user"
        )
        XCTAssertEqual(withReason["reason"]?.stringValue, "user")
    }

    /// Approvals and user-input answers are the same command, separated only by
    /// which optional field they set.
    func testRuntimeRequestResponsesShareOneCommand() {
        let approval = OrchestrationCommands.respondToApproval(
            threadID: "thread-1",
            requestID: "request-1",
            decision: "acceptForSession",
            commandID: "command-approval"
        )
        XCTAssertEqual(approval["type"]?.stringValue, "runtime-request.respond")
        XCTAssertEqual(approval["requestId"]?.stringValue, "request-1")
        XCTAssertEqual(approval["decision"]?.stringValue, "acceptForSession")
        XCTAssertNil(approval["answers"])
        XCTAssertNil(approval["createdAt"])

        let answered = OrchestrationCommands.respondToUserInput(
            threadID: "thread-1",
            requestID: "request-2",
            answers: ["branch": .string("main")]
        )
        XCTAssertEqual(answered["type"]?.stringValue, "runtime-request.respond")
        XCTAssertEqual(answered["requestId"]?.stringValue, "request-2")
        XCTAssertEqual(answered["answers"]?["branch"]?.stringValue, "main")
        XCTAssertNil(answered["decision"])
    }

    /// `project.create` is a `ProjectMutation` sent over `projects.mutate`, so
    /// it must not grow the fields an orchestration command carries.
    func testProjectCreateMatchesTheProjectMutationContract() throws {
        let command = try OrchestrationCommands.createProject(
            projectID: "project-1",
            title: "T3 Code",
            workspaceRoot: "/work/t3",
            defaultModel: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            createWorkspaceRootIfMissing: true,
            commandID: "command-project"
        )

        XCTAssertEqual(command["type"]?.stringValue, "project.create")
        XCTAssertEqual(command["commandId"]?.stringValue, "command-project")
        XCTAssertEqual(command["projectId"]?.stringValue, "project-1")
        XCTAssertEqual(command["workspaceRoot"]?.stringValue, "/work/t3")
        XCTAssertEqual(command["createWorkspaceRootIfMissing"], .bool(true))
        XCTAssertEqual(
            command["defaultModelSelection"]?["instanceId"]?.stringValue,
            "codex"
        )
        XCTAssertNil(command["createdAt"])
        XCTAssertNil(command["threadId"])
        XCTAssertEqual(RPCMethod.projectsMutate.rawValue, "projects.mutate")
    }

    func testFirstSendCommandCarriesCanonicalBootstrapMetadata() throws {
        let model = ModelSelection(instanceId: "codex", model: "gpt-5.4")
        let input = try OrchestrationCommands.createThreadAndSend(
            threadID: "thread-first-send",
            projectID: "project-1",
            title: "Build the native app",
            text: "Build the native app",
            model: model,
            runtimeMode: .fullAccess,
            commandID: "command-first-send",
            messageID: "message-first-send"
        )

        // Launching is an RPC, not a dispatched command: creating the thread,
        // preparing its workspace and sending the first message are one
        // server-side operation, so the payload has no command `type`.
        XCTAssertNil(input["type"])
        XCTAssertNil(input["bootstrap"])
        XCTAssertNil(input["titleSeed"])
        XCTAssertEqual(RPCMethod.launchThread.rawValue, "orchestration.launchThread")
        XCTAssertEqual(input["commandId"]?.stringValue, "command-first-send")
        XCTAssertEqual(input["creationSource"]?.stringValue, "mobile")
        XCTAssertEqual(input["threadId"]?.stringValue, "thread-first-send")
        XCTAssertEqual(input["projectId"]?.stringValue, "project-1")
        XCTAssertEqual(input["title"]?.stringValue, "Build the native app")
        XCTAssertEqual(input["modelSelection"]?["model"]?.stringValue, "gpt-5.4")
        XCTAssertEqual(input["runtimeMode"]?.stringValue, "full-access")
        XCTAssertEqual(input["interactionMode"]?.stringValue, "default")
        XCTAssertEqual(input["workspaceStrategy"]?["type"]?.stringValue, "root")
        XCTAssertEqual(
            input["initialMessage"]?["messageId"]?.stringValue,
            "message-first-send"
        )
        XCTAssertEqual(
            input["initialMessage"]?["text"]?.stringValue,
            "Build the native app"
        )
        XCTAssertEqual(input["initialMessage"]?["attachments"], .array([]))
        // Omitted rather than false: the server's default is to prepare.
        XCTAssertNil(input["prepareWorkspace"])
    }

    func testFirstSendCanPrepareAWorktreeBeforeDispatchingTheTurn() throws {
        let input = try OrchestrationCommands.createThreadAndSend(
            threadID: "thread-worktree",
            projectID: "project-1",
            title: "Build in isolation",
            text: "Build in isolation",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            branch: "main",
            // A draft can carry a path from an earlier local launch; a worktree
            // launch must never send it, because the server picks the path.
            worktreePath: "/work/stale",
            worktreePreparation: ThreadWorktreePreparation(
                projectCwd: "/work/t3",
                baseBranch: "main",
                branch: "t3code/deadbeef",
                startFromOrigin: true
            )
        )

        let strategy = try XCTUnwrap(input["workspaceStrategy"])
        XCTAssertEqual(strategy["type"]?.stringValue, "worktree")
        XCTAssertEqual(strategy["baseRef"]?.stringValue, "main")
        XCTAssertEqual(strategy["branch"]?.stringValue, "t3code/deadbeef")
        XCTAssertEqual(strategy["startFromOrigin"], .bool(true))
        XCTAssertNil(strategy["worktreePath"])
        XCTAssertNil(strategy["projectCwd"])
        XCTAssertNil(input["worktreePath"])
    }

    func testFirstSendReusesAnExistingWorktreeWhenGivenAPath() throws {
        let input = try OrchestrationCommands.createThreadAndSend(
            projectID: "project-1",
            title: "Continue in place",
            text: "Continue in place",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            branch: "feature",
            worktreePath: "/work/t3-feature",
            prepareWorkspace: false
        )

        let strategy = try XCTUnwrap(input["workspaceStrategy"])
        XCTAssertEqual(strategy["type"]?.stringValue, "existing_worktree")
        XCTAssertEqual(strategy["worktreePath"]?.stringValue, "/work/t3-feature")
        XCTAssertEqual(strategy["branch"]?.stringValue, "feature")
        XCTAssertEqual(input["prepareWorkspace"], .bool(false))
    }

    /// The contract's optional strings are trimmed and non-empty, so a blank
    /// branch has to be left off rather than sent as `""`.
    func testBlankBranchesAreOmittedRatherThanSentEmpty() throws {
        let input = try OrchestrationCommands.createThreadAndSend(
            projectID: "project-1",
            title: "No branch",
            text: "No branch",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            branch: "   "
        )
        XCTAssertNil(input["workspaceStrategy"]?["branch"])

        let created = try OrchestrationCommands.createThread(
            projectID: "project-1",
            title: "No branch",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            branch: "   "
        )
        XCTAssertEqual(created["branch"], .null)
    }

    func testEnvironmentStorePersistsSelectionAndClearsRemovedActiveEnvironment() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-core-\(UUID().uuidString)", isDirectory: true)
        let file = directory.appendingPathComponent("environments.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = EnvironmentStore(fileURL: file)
        let first = Environment(
            id: "one",
            label: "One",
            httpBaseURL: URL(string: "https://one.example")!,
            webSocketBaseURL: URL(string: "wss://one.example")!
        )
        let second = Environment(
            id: "two",
            label: "Two",
            httpBaseURL: URL(string: "https://two.example")!,
            webSocketBaseURL: URL(string: "wss://two.example")!
        )

        try await store.save([first, second])
        try await store.setActiveEnvironment(id: second.id)
        let selected = try await store.activeEnvironmentID()
        XCTAssertEqual(selected, second.id)

        let remaining = try await store.remove(id: second.id)
        let fallback = try await store.activeEnvironmentID()
        XCTAssertEqual(remaining.map(\.id), [first.id])
        XCTAssertEqual(fallback, first.id)
    }

    func testRuntimeReplacesCachedClientWhenSavedEndpointChanges() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-runtime-\(UUID().uuidString)", isDirectory: true)
        let file = directory.appendingPathComponent("environments.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = EnvironmentStore(fileURL: file)
        let first = Environment(
            id: "same-server",
            label: "Studio",
            httpBaseURL: URL(string: "http://192.168.1.10:3773")!,
            webSocketBaseURL: URL(string: "ws://192.168.1.10:3773")!
        )
        let moved = Environment(
            id: "same-server",
            label: "Studio",
            httpBaseURL: URL(string: "http://192.168.1.20:4773")!,
            webSocketBaseURL: URL(string: "ws://192.168.1.20:4773")!
        )
        try await store.save([first])
        try await store.setActiveEnvironment(id: first.id)
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore()
        )

        let firstClientValue = try await runtime.activeClient()
        let firstClient = try XCTUnwrap(firstClientValue)
        try await store.upsert(moved)
        let movedClientValue = try await runtime.activeClient()
        let movedClient = try XCTUnwrap(movedClientValue)
        let movedEnvironment = await movedClient.environment

        XCTAssertFalse(firstClient === movedClient)
        XCTAssertEqual(movedEnvironment.httpBaseURL, moved.httpBaseURL)
        XCTAssertEqual(movedEnvironment.webSocketBaseURL, moved.webSocketBaseURL)
    }

    func testRuntimeRemovesCatalogEntryBeforeDestroyingCredential() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-removal-\(UUID().uuidString)", isDirectory: true)
        let file = directory.appendingPathComponent("environments.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let environment = Environment(
            id: "removable",
            label: "Removable",
            httpBaseURL: URL(string: "https://remove.example")!,
            webSocketBaseURL: URL(string: "wss://remove.example")!
        )
        let store = EnvironmentStore(fileURL: file)
        try await store.save([environment])
        let credentials = RemovalOrderCredentialStore(
            environmentStore: store,
            environmentID: environment.id,
            credential: EnvironmentCredential(accessToken: "secret")
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: credentials
        )

        try await runtime.remove(id: environment.id)

        let catalogContainedEnvironment = await credentials.catalogContainedEnvironmentOnRemoval
        XCTAssertEqual(catalogContainedEnvironment, false)
        let remaining = try await store.load()
        XCTAssertTrue(remaining.isEmpty)
        let credential = await credentials.credential(for: environment.id)
        XCTAssertNil(credential)
    }
}

private actor RemovalOrderCredentialStore: CredentialStore {
    let environmentStore: EnvironmentStore
    let environmentID: String
    var storedCredential: EnvironmentCredential?
    private(set) var catalogContainedEnvironmentOnRemoval: Bool?

    init(
        environmentStore: EnvironmentStore,
        environmentID: String,
        credential: EnvironmentCredential
    ) {
        self.environmentStore = environmentStore
        self.environmentID = environmentID
        storedCredential = credential
    }

    func credential(for environmentID: String) -> EnvironmentCredential? {
        environmentID == self.environmentID ? storedCredential : nil
    }

    func setCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) {
        guard environmentID == self.environmentID else { return }
        storedCredential = credential
    }

    func removeCredential(for environmentID: String) async throws {
        guard environmentID == self.environmentID else { return }
        catalogContainedEnvironmentOnRemoval = try await environmentStore.load()
            .contains(where: { $0.id == environmentID })
        storedCredential = nil
    }
}
