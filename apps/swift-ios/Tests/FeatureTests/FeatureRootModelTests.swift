import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Feature root model")
struct FeatureRootModelTests {
    @Test
    func savedServersKeepWorkspaceNavigationAvailableWhileDisconnected() {
        let savedEnvironment = FeatureEnvironment(
            id: "offline-demo",
            name: "Offline demo",
            endpoint: "https://offline.example",
            connectionState: .disconnected
        )
        let snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [savedEnvironment]
        )

        #expect(
            FeatureRootPresentation.showsWorkspace(
                snapshot: snapshot,
                isManagingConnections: true
            )
        )
        #expect(
            FeatureRootPresentation.showsWorkspace(
                snapshot: snapshot,
                isManagingConnections: false
            )
        )
        #expect(
            FeatureRootPresentation.showsWorkspace(
                snapshot: FeatureSnapshot(connection: .init(state: .disconnected)),
                isManagingConnections: true
            )
        )
        #expect(
            !FeatureRootPresentation.showsWorkspace(
                snapshot: FeatureSnapshot(connection: .init(state: .disconnected)),
                isManagingConnections: false
            )
        )
    }

    @Test
    func disconnectEndsConnectionManagement() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "studio",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected,
                    connectionDetail: "Healthy"
                ),
            ]
        )
        let model = testRootModel(client: client)
        await model.reload()
        model.setConnectionManagementPresented(true)

        await model.disconnect()

        #expect(!model.isManagingConnections)
        #expect(model.snapshot.connection.state == .disconnected)
        #expect(model.snapshot.environments.first?.connectionState == .disconnected)
        #expect(model.snapshot.environments.first?.connectionDetail == nil)
    }

    @Test
    func restoredFollowUpWaitsForItsQueuedThreadCreation() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-dependent-outbox-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let threadID = "environment-1::thread::queued-thread"
        let creationIdentity = FeatureSubmissionIdentity(
            threadID: "queued-thread",
            commandID: "create-command",
            messageID: "create-message",
            createdAt: Date(timeIntervalSince1970: 1)
        )
        let creation = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: creationIdentity,
            threadID: threadID,
            text: "Create the task",
            selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [],
            creation: .init(
                projectID: "project-1",
                projectName: "Native",
                workspaceMode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: false
            )
        )
        let followUp = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: .init(
                threadID: "queued-thread",
                commandID: "follow-up-command",
                messageID: "follow-up-message",
                createdAt: Date(timeIntervalSince1970: 2)
            ),
            threadID: threadID,
            text: "And add tests",
            selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: []
        )
        try await store.enqueue(creation)
        try await store.enqueue(followUp)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        client.startTaskError = URLError(.timedOut)
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: store)

        await model.start()
        await model.disconnect()

        let restoredIDs = try await store.submissions().map(\.id)
        #expect(restoredIDs.count == 2)
        #expect(Set(restoredIDs) == Set([creation.id, followUp.id]))
        #expect(client.sendMessageCallCount == 0)
    }

    @Test
    func testPairReloadsConnectedSnapshot() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(connection: .init(state: .disconnected))
        client.snapshotAfterPair = FeatureSnapshot(
            connection: .init(
                state: .connected,
                environmentName: "Studio",
                endpoint: "https://studio.example"
            )
        )
        let oldThread = FeatureThread(id: "same-id", projectID: "old-project", title: "Old")
        client.threadDetail = FeatureThreadDetail(
            thread: oldThread,
            messages: [FeatureMessage(id: "old-message", role: .assistant, text: "Old")]
        )
        let model = testRootModel(client: client)
        _ = await model.detail(for: oldThread.id)

        let result = await model.pair(endpoint: "https://studio.example", token: "pair-token")

        #expect(result)
        #expect(client.pairEndpoint == "https://studio.example")
        #expect(client.pairToken == "pair-token")
        #expect(model.snapshot.connection.state == .connected)
        #expect(model.details.isEmpty)
    }

    @Test
    func failedActivationDoesNotReuseThePriorConnectedSnapshot() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(
                state: .connected,
                environmentName: "Old studio",
                endpoint: "https://old.example"
            ),
            environments: [
                .init(
                    id: "old",
                    name: "Old studio",
                    endpoint: "https://old.example",
                    isActive: true,
                    connectionState: .connected
                ),
                .init(
                    id: "target",
                    name: "Target studio",
                    endpoint: "https://target.example",
                    connectionState: .disconnected
                ),
            ]
        )
        client.activateEnvironmentError = FeatureCapabilityUnavailable("Activation")
        let model = testRootModel(client: client)
        await model.reload()

        let activated = await model.activateEnvironment("target")

        #expect(!activated)
        #expect(client.activatedEnvironmentID == "target")
        #expect(model.snapshot.connection.state == .connected)
        #expect(model.snapshot.environments.first(where: { $0.id == "old" })?.isActive == true)
        #expect(model.snapshot.environments.first(where: { $0.id == "target" })?.isActive == false)
    }

    @Test
    func testCreateThreadOptimisticallyUpsertsIt() async {
        let client = FeatureClientStub()
        let created = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Build native app",
            providerID: "codex",
            modelID: "gpt-5"
        )
        client.createdThread = created
        let model = testRootModel(client: client)

        let result = await model.createThread(
            projectID: "project-1",
            title: created.title,
            selection: .init(providerID: "codex", modelID: "gpt-5")
        )

        #expect(result == created)
        #expect(model.snapshot.threads == [created])
    }

    @Test
    func testSendAddsQueuedMessageBeforeServerEvent() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread"
        )
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            threads: [thread]
        )
        client.threadDetail = FeatureThreadDetail(thread: thread)
        let model = testRootModel(client: client)
        await model.reload()
        _ = await model.detail(for: thread.id)

        let sent = await model.sendMessage(
            threadID: thread.id,
            text: "  ship it  ",
            selection: nil
        )

        #expect(sent)
        #expect(client.sentText == "ship it")
        #expect(model.details[thread.id]?.messages.last?.text == "ship it")
        #expect(model.details[thread.id]?.messages.last?.state == .complete)
    }

    @Test
    func loadingEarlierTurnsPrependsHistoryAndClearsTheCursor() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Long thread"
        )
        let recent = FeatureMessage(
            id: "message-recent",
            role: .assistant,
            text: "Recent",
            createdAt: Date(timeIntervalSince1970: 2)
        )
        let older = FeatureMessage(
            id: "message-older",
            role: .user,
            text: "Older",
            createdAt: Date(timeIntervalSince1970: 1)
        )
        client.threadDetail = FeatureThreadDetail(
            thread: thread,
            messages: [recent],
            page: FeatureThreadPage(beforeCursor: "cursor-1", hasMore: true)
        )
        client.earlierThreadDetail = FeatureThreadDetail(
            thread: thread,
            messages: [older, recent],
            page: FeatureThreadPage(beforeCursor: nil, hasMore: false)
        )
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)

        await model.loadEarlierTurns(for: thread.id)

        #expect(model.details[thread.id]?.messages.map(\.id) == [older.id, recent.id])
        #expect(model.details[thread.id]?.page?.hasMore == false)
        #expect(client.loadEarlierCallCount == 1)
    }

    @Test
    func failedDiscardKeepsTheDurableAndOptimisticSubmission() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-discard-failure-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }

        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread"
        )
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            threads: [thread]
        )
        client.threadDetail = FeatureThreadDetail(thread: thread)
        client.beforeSendMessage = {
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o500))],
                ofItemAtPath: directory.path
            )
        }
        client.sendMessageError = FeatureCapabilityUnavailable("Rejected message")
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.reload()
        _ = await model.detail(for: thread.id)

        let sent = await model.sendMessage(
            threadID: thread.id,
            text: "Keep this queued",
            selection: nil
        )

        #expect(!sent)
        #expect(try await store.submissions().count == 1)
        #expect(model.details[thread.id]?.messages.last?.text == "Keep this queued")
        #expect(model.details[thread.id]?.messages.last?.state == .queued)
    }

    @Test
    func failedDeliveryCleanupKeepsTheDurableAndOptimisticSubmission() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-completion-failure-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }

        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread"
        )
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            threads: [thread]
        )
        client.threadDetail = FeatureThreadDetail(thread: thread)
        client.beforeSendMessage = {
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o500))],
                ofItemAtPath: directory.path
            )
        }
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.reload()
        _ = await model.detail(for: thread.id)

        let sent = await model.sendMessage(
            threadID: thread.id,
            text: "Already delivered",
            selection: nil
        )

        #expect(sent)
        #expect(client.sendMessageCallCount == 1)
        #expect(try await store.submissions().count == 1)
        #expect(model.details[thread.id]?.messages.last?.text == "Already delivered")
        #expect(model.details[thread.id]?.messages.last?.state == .queued)
        #expect(model.errorMessage?.contains("delivered") == true)
    }

    @Test
    func failedEnvironmentOutboxCleanupKeepsPendingState() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-environment-cleanup-failure-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }

        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let identity = FeatureSubmissionIdentity(
            threadID: "queued-thread",
            commandID: "queued-command",
            messageID: "queued-message"
        )
        let submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: identity,
            threadID: "environment-1::thread::queued-thread",
            text: "Create from the outbox",
            selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [],
            creation: .init(
                projectID: "project-1",
                projectName: "Native",
                workspaceMode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: false
            )
        )
        try await store.enqueue(submission)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .disconnected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        client.snapshotAfterEnvironmentRemoval = FeatureSnapshot(
            connection: .init(state: .disconnected)
        )
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.start()
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o500))],
            ofItemAtPath: directory.path
        )

        await model.removeEnvironment("environment-1")

        #expect(client.removedEnvironmentID == "environment-1")
        #expect(model.snapshot.environments.isEmpty)
        #expect(model.snapshot.threads.contains(where: { $0.id == submission.threadID }))
        #expect(try await store.submissions() == [submission])
        #expect(model.errorMessage?.contains("queued messages") == true)
    }

    @Test
    func testNewTaskStartsThreadAndFirstTurnAtomically() async {
        let client = FeatureClientStub()
        let created = FeatureThread(
            id: "thread-atomic",
            projectID: "project-1",
            title: "Ship the native app",
            providerID: "codex",
            modelID: "gpt-5.6-sol"
        )
        client.createdThread = created
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        let model = testRootModel(client: client)
        await model.reload()
        let attachment = FeatureDraftAttachment(
            data: Data([0xFF, 0xD8, 0xFF]),
            filename: "reference.jpg",
            mimeType: "image/jpeg"
        )

        let result = await model.startTask(
            NewTaskRequest(
                projectID: "project-1",
                prompt: "  Ship the native app  ",
                selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
                runtimeMode: .fullAccess,
                interactionMode: .standard,
                workspaceMode: .worktree,
                branch: "main",
                startFromOrigin: true,
                attachments: [attachment]
            )
        )

        #expect(result == created)
        #expect(client.startedPrompt == "Ship the native app")
        #expect(client.startedAttachments.map(\.name) == ["reference.jpg"])
        #expect(client.startedWorkspaceMode == .worktree)
        #expect(client.startedBranch == "main")
        #expect(client.startedWorktreePath == nil)
        #expect(client.startedFromOrigin)
        #expect(client.createThreadCallCount == 0)
        #expect(client.sendMessageCallCount == 0)
        #expect(model.snapshot.threads == [created])
    }

    @Test
    func testArchiveAndDeleteKeepLocalListsConsistent() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        client.createdThread = thread
        let model = testRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setArchived(thread.id, archived: true)
        #expect(model.snapshot.threads[0].isArchived)

        await model.deleteThread(thread.id)
        #expect(model.snapshot.threads.isEmpty)
    }

    @Test
    func testCancelledDetailRefreshKeepsCachedContentWithoutAlert() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let detail = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(id: "message-1", role: .assistant, text: "Still here"),
            ]
        )
        client.threadDetail = detail
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)
        client.loadThreadError = CancellationError()

        let refreshed = await model.detail(for: thread.id, force: true)

        #expect(refreshed == detail)
        #expect(model.errorMessage == nil)
    }

    @Test
    func testResnoozeRefreshesTheOptimisticSnoozeTimestamp() async {
        let client = FeatureClientStub()
        var thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Thread",
            state: .failed
        )
        let oldSnooze = Date.now.addingTimeInterval(-600)
        thread.snoozedAt = oldSnooze
        thread.attentionAt = Date.now.addingTimeInterval(-300)
        client.createdThread = thread
        let model = testRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setSnoozed(
            thread.id,
            until: Date.now.addingTimeInterval(3_600)
        )

        let updated = model.snapshot.threads[0]
        #expect(updated.snoozedAt != oldSnooze)
        #expect(updated.snoozedAt! > updated.attentionAt!)
    }

    @Test
    func testPinOptimisticallyWakesWithoutInventingSettlementOverride() async {
        let client = FeatureClientStub()
        var thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Thread",
            isSettled: true,
            settledAt: .now,
            snoozedUntil: Date.now.addingTimeInterval(3_600),
            snoozedAt: .now
        )
        thread.supportsPinning = true
        client.createdThread = thread
        let model = testRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setPinned(thread.id, pinned: true)

        let updated = model.snapshot.threads[0]
        #expect(updated.pinnedAt != nil)
        #expect(updated.isSettled)
        #expect(!updated.keepsActive)
        #expect(updated.settledAt != nil)
        #expect(updated.snoozedUntil == nil)
    }

    @Test
    func testPinDoesNotMakeAnOrdinaryThreadPermanentlyActive() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Thread"
        )
        client.createdThread = thread
        let model = testRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setPinned(thread.id, pinned: true)
        await model.setPinned(thread.id, pinned: false)

        let updated = model.snapshot.threads[0]
        #expect(updated.pinnedAt == nil)
        #expect(!updated.keepsActive)
    }

    @Test
    func testResolveUserInputForwardsTypedAnswersAndClearsTheRequest() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let request = FeatureUserInput(
            id: "request-1",
            threadID: thread.id,
            questions: []
        )
        client.threadDetail = FeatureThreadDetail(thread: thread, userInputs: [request])
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)

        let answers: [String: FeatureInputAnswer] = [
            "scope": .selections(["Server", "Web"]),
            "note": .text("Ship it"),
        ]
        await model.resolveUserInput(request.id, answers: answers)

        #expect(client.resolvedInputID == request.id)
        #expect(client.resolvedInputAnswers == answers)
        #expect(model.details[thread.id]?.userInputs.isEmpty == true)
    }

    @Test
    func granularThreadEventsMaintainCountsAndCollectionRevision() async {
        let client = FeatureClientStub()
        let project = FeatureProject(
            id: "project-1",
            environmentID: "environment-1",
            name: "Native",
            path: "/native"
        )
        client.snapshot = FeatureSnapshot(projects: [project])
        let model = testRootModel(client: client)
        let thread = FeatureThread(
            id: "thread-1",
            projectID: project.id,
            title: "Stream deltas"
        )

        let run = Task { await model.start() }
        client.emit(.thread(thread))
        client.emit(.thread(thread))
        client.emit(.threadRemoved(id: thread.id))
        let connected = FeatureConnection(state: .connected, environmentName: "Native")
        client.emit(.connection(connected))
        client.emit(.connection(connected))
        client.finishEvents()
        await run.value

        #expect(model.snapshot.threads.isEmpty)
        #expect(model.snapshot.projects[0].threadCount == 0)
        #expect(model.threadCollectionRevision == 2)
        #expect(model.homePresentationRevision == 4)
    }

    @Test
    func environmentScopedCatalogAndPreferencesInvalidateHomePresentation() async {
        let client = FeatureClientStub()
        let model = testRootModel(client: client)
        client.snapshot = FeatureSnapshot(
            providersByEnvironment: [
                "studio": [
                    .init(
                        id: "codex",
                        name: "Codex",
                        models: [.init(id: "gpt-5.6-sol", name: "Sol")]
                    ),
                ],
            ]
        )

        await model.reload()
        let catalogRevision = model.homePresentationRevision
        #expect(catalogRevision == 1)

        client.snapshot.preferencesByEnvironment = [
            "studio": .init(defaultWorkspaceMode: .worktree),
        ]
        await model.reload()

        #expect(model.homePresentationRevision == catalogRevision + 1)
    }

    @Test
    func responseTimeoutKeepsDurableSubmissionQueued() {
        let snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "studio",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ]
        )

        #expect(
            FeatureRootModel.shouldQueue(
                RPCError.responseTimedOut,
                environmentID: "studio",
                snapshot: snapshot
            )
        )
    }

    @Test
    func detailEventsIgnoreDuplicatesAndAdvancePerThreadRevision() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Stream transcript"
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let first = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-1", role: .assistant, text: "Hel")]
        )
        let second = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(id: "message-1", role: .assistant, text: "Hello"),
                FeatureMessage(id: "message-2", role: .user, text: "Ship it"),
            ]
        )
        let model = testRootModel(client: client)

        let run = Task { await model.start() }
        client.emit(.detail(first))
        client.emit(.detail(first))
        client.emit(.detail(second))
        client.finishEvents()
        await run.value

        #expect(model.details[thread.id] == second)
        #expect(model.detailRevision == 2)
        #expect(model.detailRevisions[thread.id] == 2)
    }

    @Test
    func authoritativeAttachmentRetainsLocalPreviewUntilURLHydrates() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Image preview"
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let preview = Data([0x01, 0x02, 0x03])
        let local = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(
                    id: "message-1",
                    role: .user,
                    text: "See image",
                    attachments: [
                        FeatureMessageAttachment(
                            id: "local-attachment",
                            name: "image.jpg",
                            mimeType: "image/jpeg",
                            sizeBytes: 3,
                            previewData: preview
                        ),
                    ]
                ),
            ]
        )
        let authoritative = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(
                    id: "message-1",
                    role: .user,
                    text: "See image",
                    attachments: [
                        FeatureMessageAttachment(
                            id: "server-attachment",
                            name: "image.jpg",
                            mimeType: "image/jpeg",
                            sizeBytes: 3
                        ),
                    ]
                ),
            ]
        )
        let model = testRootModel(client: client)

        let run = Task { await model.start() }
        client.emit(.detail(local))
        client.emit(.detail(authoritative))
        client.finishEvents()
        await run.value

        #expect(model.details[thread.id]?.messages[0].attachments[0].id == "server-attachment")
        #expect(model.details[thread.id]?.messages[0].attachments[0].previewData == preview)
    }

    @Test
    func detailDeltaCarriesAContiguousRenderCursor() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Incremental transcript"
        )
        let firstMessage = FeatureMessage(id: "message-1", role: .assistant, text: "Hel")
        let completedMessage = FeatureMessage(id: "message-1", role: .assistant, text: "Hello")
        let appendedMessage = FeatureMessage(id: "message-2", role: .user, text: "Ship it")
        let first = FeatureThreadDetail(thread: thread, messages: [firstMessage])
        let second = FeatureThreadDetail(
            thread: thread,
            messages: [completedMessage, appendedMessage]
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let model = testRootModel(client: client)

        let run = Task { await model.start() }
        client.emit(.detail(first))
        client.emit(.detailDelta(
            second,
            FeatureDetailDelta(
                changedMessages: [completedMessage, appendedMessage],
                appendedMessageIDs: [appendedMessage.id]
            )
        ))
        client.finishEvents()
        await run.value

        #expect(model.details[thread.id] == second)
        #expect(model.detailRevisions[thread.id] == 2)
        guard let update = model.detailRenderUpdates[thread.id] else {
            Issue.record("Expected an incremental render update")
            return
        }
        #expect(update.baseRevision == 1)
        #expect(update.revision == 2)
        guard case let .delta(delta) = update.change else {
            Issue.record("Expected a detail delta")
            return
        }
        #expect(delta.appendedMessageIDs == [appendedMessage.id])
        #expect(delta.changedMessages == [completedMessage, appendedMessage])
    }

    @Test
    func detailReducerFoldsStreamingTurnItemsInPlace() throws {
        // Streaming an answer emits many turn-item.updated events per second.
        // Folding them in place is what keeps the transcript from stuttering.
        let projection = v2Projection(items: [v2AssistantItem(id: "item-1", text: "Hel")])
        let event = orchestrationEvent(
            type: "turn-item.updated",
            sequence: 12,
            payload: v2AssistantItemJSON(id: "item-1", text: "Hello")
        )

        let reduction = NativeThreadDetailReducer.apply(event, to: projection)

        #expect(reduction.sequence == 12)
        guard case let .updated(updated) = reduction.result else {
            Issue.record("Expected a streaming turn item update")
            return
        }
        #expect(updated.turnItems.count == 1)
        guard case let .assistantMessage(_, text, _) = updated.turnItems[0].payload else {
            Issue.record("Expected an assistant message")
            return
        }
        #expect(text == "Hello")
        // The visible window has to track the same edit, or the row the user is
        // watching would freeze mid-sentence.
        guard case let .assistantMessage(_, visibleText, _) =
            updated.visibleTurnItems[0].item.payload
        else {
            Issue.record("Expected the visible item to update too")
            return
        }
        #expect(visibleText == "Hello")
    }

    @Test
    func detailReducerAppendsTurnItemsThatArriveMidStream() {
        let projection = v2Projection(items: [v2AssistantItem(id: "item-1", text: "One")])
        let event = orchestrationEvent(
            type: "turn-item.updated",
            sequence: 13,
            payload: v2AssistantItemJSON(id: "item-2", text: "Two")
        )

        let reduction = NativeThreadDetailReducer.apply(event, to: projection)

        guard case let .updated(updated) = reduction.result else {
            Issue.record("Expected an appended turn item")
            return
        }
        #expect(updated.turnItems.count == 2)
        #expect(updated.visibleTurnItems.count == 2)
        #expect(updated.visibleTurnItems.last?.position == 1)
    }

    @Test
    func detailReducerTracksRunStatusForTheHeader() {
        let projection = v2Projection(items: [])
        let event = orchestrationEvent(
            type: "run.updated",
            sequence: 20,
            payload: .object([
                "id": .string("run-1"),
                "threadId": .string("thread-v2"),
                "ordinal": .number(1),
                "status": .string("running"),
                // Non-null in the contract, so the reducer's decode requires it.
                "userMessageId": .string("message-1"),
                "requestedAt": .string("2026-07-31T20:00:00.000Z"),
                "startedAt": .string("2026-07-31T20:00:01.000Z"),
                "completedAt": .null,
            ])
        )

        let reduction = NativeThreadDetailReducer.apply(event, to: projection)

        guard case let .updated(updated) = reduction.result else {
            Issue.record("Expected a run update")
            return
        }
        #expect(updated.runs.first?.status == "running")
    }

    @Test
    func structuralEventsRequestAnAuthoritativeSnapshot() {
        // A rollback drops whole runs out of the projection. Guessing at the
        // result would leave the transcript showing discarded work.
        let projection = v2Projection(items: [])
        let event = orchestrationEvent(
            type: "checkpoint.rollback-requested",
            sequence: 3,
            payload: .object(["threadId": .string("thread-v2")])
        )

        #expect(NativeThreadDetailReducer.apply(event, to: projection).result == .refresh)
    }

    @Test
    func unknownEventTypesRequestAnAuthoritativeSnapshotRatherThanBeingDropped() {
        let projection = v2Projection(items: [])
        let event = orchestrationEvent(
            type: "quantum.entangled",
            sequence: 4,
            payload: .object(["threadId": .string("thread-v2")])
        )

        #expect(NativeThreadDetailReducer.apply(event, to: projection).result == .refresh)
    }

    @Test
    func observingAnUnchangedThreadListKeepsTheExistingChangeRequestStream() async throws {
        let client = FeatureClientStub()
        let model = testRootModel(client: client)

        model.observeChangeRequests(threadIDs: ["thread-a", "thread-b"])
        try await waitUntil { client.changeRequestCalls.count == 1 }

        model.observeChangeRequests(threadIDs: ["thread-a", "thread-b"])
        for _ in 0..<10 { await Task.yield() }

        #expect(client.changeRequestCalls.count == 1)
    }

    @Test
    func changeRequestRestartsAreSeededWithRetainedState() async throws {
        let client = FeatureClientStub()
        let model = testRootModel(client: client)
        let merged = FeaturePullRequest(number: 7, title: "Ship it", state: "merged")

        model.observeChangeRequests(threadIDs: ["thread-a", "thread-b"])
        try await waitUntil { client.changeRequestCalls.count == 1 }
        #expect(client.changeRequestCalls[0].seed.isEmpty)

        client.emitChangeRequests(["thread-a": merged])
        try await waitUntil { model.changeRequestsByThreadID["thread-a"] == merged }

        // A membership change restarts the stream. The state the model already
        // holds must ride along as the seed, or the row settled by this merged
        // PR bounces back to Active until the new stream's snapshot arrives —
        // which reorders the list, restarts the stream again, and loops.
        model.observeChangeRequests(threadIDs: ["thread-a", "thread-b", "thread-c"])
        try await waitUntil { client.changeRequestCalls.count == 2 }
        #expect(client.changeRequestCalls[1].seed == ["thread-a": merged])
        #expect(model.changeRequestsByThreadID == ["thread-a": merged])

        // Dropping a thread from observation drops it from the seed too.
        model.observeChangeRequests(threadIDs: ["thread-b", "thread-c"])
        try await waitUntil { client.changeRequestCalls.count == 3 }
        #expect(client.changeRequestCalls[2].seed.isEmpty)
    }

    private func waitUntil(
        _ condition: @MainActor () -> Bool
    ) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("Timed out waiting for the model to apply the emission")
    }
}

@MainActor
private func testRootModel(client: FeatureClientStub) -> FeatureRootModel {
    FeatureRootModel(
        client: client,
        outboxStore: FeatureOutboxStore(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("t3-root-outbox-\(UUID().uuidString).json")
        )
    )
}

private func orchestrationEvent(
    type: String,
    sequence: Int,
    payload: JSONValue
) -> JSONValue {
    .object([
        "type": .string(type),
        "sequence": .number(Double(sequence)),
        "occurredAt": .string("2026-07-31T20:00:02.000Z"),
        "payload": payload,
    ])
}

private func v2AssistantItemJSON(id: String, text: String) -> JSONValue {
    .object([
        "id": .string(id),
        "threadId": .string("thread-v2"),
        "runId": .string("run-1"),
        "nodeId": .null,
        "providerThreadId": .null,
        "providerTurnId": .null,
        "nativeItemRef": .null,
        "parentItemId": .null,
        "ordinal": .number(0),
        "status": .string("running"),
        "title": .null,
        "startedAt": .string("2026-07-31T20:00:00.000Z"),
        "completedAt": .null,
        "updatedAt": .string("2026-07-31T20:00:01.000Z"),
        "type": .string("assistant_message"),
        "messageId": .string("message-" + id),
        "text": .string(text),
        "streaming": .bool(true),
    ])
}

private func v2AssistantItem(id: String, text: String) -> OrchestrationV2TurnItem {
    let data = try! JSONEncoder.t3.encode(v2AssistantItemJSON(id: id, text: text))
    return try! JSONDecoder.t3.decode(OrchestrationV2TurnItem.self, from: data)
}

private func v2Projection(
    items: [OrchestrationV2TurnItem]
) -> OrchestrationV2ThreadProjection {
    OrchestrationV2ThreadProjection(
        thread: OrchestrationV2AppThread(
            id: "thread-v2",
            projectId: "project-1",
            createdBy: "user",
            creationSource: "mobile",
            title: "Native detail stream",
            titleRevision: nil,
            titleOrigin: nil,
            providerInstanceId: "codex",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: "main",
            worktreePath: "/native",
            activeProviderThreadId: nil,
            historyOrigin: nil,
            lineage: OrchestrationV2AppThreadLineage(
                parentThreadId: nil,
                relationshipToParent: nil,
                rootThreadId: "thread-v2"
            ),
            forkedFrom: nil,
            createdAt: "2026-07-31T20:00:00.000Z",
            updatedAt: "2026-07-31T20:00:00.000Z",
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
        turnItems: items,
        visibleTurnItems: items.enumerated().map { index, item in
            OrchestrationV2ProjectedTurnItem(
                position: index,
                visibility: .local,
                sourceThreadId: "thread-v2",
                sourceItemId: item.id,
                item: item
            )
        },
        truncatedVisibleItemCount: nil,
        updatedAt: "2026-07-31T20:00:00.000Z"
    )
}

@MainActor
private final class FeatureClientStub: FeatureClient {
    private let eventStream: AsyncStream<FeatureEvent>
    private let eventContinuation: AsyncStream<FeatureEvent>.Continuation
    var snapshot = FeatureSnapshot()
    var snapshotAfterPair: FeatureSnapshot?
    var snapshotAfterEnvironmentRemoval: FeatureSnapshot?
    var createdThread = FeatureThread(id: "created", projectID: "project", title: "Created")
    var threadDetail: FeatureThreadDetail?
    var earlierThreadDetail: FeatureThreadDetail?
    var pairEndpoint: String?
    var pairToken: String?
    var sentText: String?
    var startedPrompt: String?
    var startedAttachments: [FeatureUploadAttachment] = []
    var startedWorkspaceMode: FeatureWorkspaceMode?
    var startedBranch: String?
    var startedWorktreePath: String?
    var startedFromOrigin = false
    var createThreadCallCount = 0
    var sendMessageCallCount = 0
    var startTaskError: (any Error)?
    var sendMessageError: (any Error)?
    var activateEnvironmentError: (any Error)?
    var activatedEnvironmentID: String?
    var removedEnvironmentID: String?
    var beforeSendMessage: (() throws -> Void)?
    var loadThreadError: (any Error)?
    var loadEarlierCallCount = 0
    var resolvedInputID: String?
    var resolvedInputAnswers: [String: FeatureInputAnswer]?
    var changeRequestCalls: [(threadIDs: [String], seed: [String: FeaturePullRequest])] = []
    private var changeRequestContinuations: [AsyncStream<[String: FeaturePullRequest]>.Continuation] = []

    func threadChangeRequests(
        threadIDs: [String],
        seed: [String: FeaturePullRequest]
    ) -> AsyncStream<[String: FeaturePullRequest]> {
        changeRequestCalls.append((threadIDs: threadIDs, seed: seed))
        let pair = AsyncStream<[String: FeaturePullRequest]>.makeStream()
        changeRequestContinuations.append(pair.continuation)
        return pair.stream
    }

    /// Emits on the most recently opened change-request stream.
    func emitChangeRequests(_ value: [String: FeaturePullRequest]) {
        changeRequestContinuations.last?.yield(value)
    }

    init() {
        let pair = AsyncStream<FeatureEvent>.makeStream()
        eventStream = pair.stream
        eventContinuation = pair.continuation
    }

    func events() -> AsyncStream<FeatureEvent> {
        eventStream
    }

    func emit(_ event: FeatureEvent) {
        eventContinuation.yield(event)
    }

    func finishEvents() {
        eventContinuation.finish()
    }

    func initialSnapshot() async throws -> FeatureSnapshot {
        if removedEnvironmentID != nil, let snapshotAfterEnvironmentRemoval {
            return snapshotAfterEnvironmentRemoval
        }
        if pairEndpoint != nil, let snapshotAfterPair {
            return snapshotAfterPair
        }
        return snapshot
    }

    func pair(endpoint: String, token: String?) async throws {
        pairEndpoint = endpoint
        pairToken = token
    }

    func activateEnvironment(id: String) async throws {
        activatedEnvironmentID = id
        if let activateEnvironmentError { throw activateEnvironmentError }
    }

    func removeEnvironment(id: String) async throws {
        removedEnvironmentID = id
    }

    func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async throws -> FeatureThread {
        createThreadCallCount += 1
        return createdThread
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        if let startTaskError { throw startTaskError }
        startedPrompt = prompt
        startedAttachments = attachments
        return createdThread
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        if let startTaskError { throw startTaskError }
        startedPrompt = prompt
        startedAttachments = attachments
        startedWorkspaceMode = workspaceMode
        startedBranch = branch
        startedWorktreePath = worktreePath
        startedFromOrigin = startFromOrigin
        return createdThread
    }

    func renameThread(id: String, title: String) async throws {}
    func setThreadArchived(id: String, archived: Bool) async throws {}
    func deleteThread(id: String) async throws {}

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        if let loadThreadError {
            throw loadThreadError
        }
        if let threadDetail {
            return threadDetail
        }
        return FeatureThreadDetail(thread: createdThread)
    }

    func loadEarlierThreadTurns(id: String) async throws -> FeatureThreadDetail? {
        loadEarlierCallCount += 1
        return earlierThreadDetail
    }

    func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async throws {
        sendMessageCallCount += 1
        try beforeSendMessage?()
        if let sendMessageError { throw sendMessageError }
        sentText = text
    }

    func cancelTurn(threadID: String) async throws {}
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {}
    func resolveUserInput(
        id: String,
        answers: [String: FeatureInputAnswer]
    ) async throws {
        resolvedInputID = id
        resolvedInputAnswers = answers
    }
    func saveSettings(_ settings: FeatureSettings) async throws {}
}
