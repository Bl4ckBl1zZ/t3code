import Foundation

public actor T3Client {
    public let environment: Environment
    private let api: EnvironmentAPI
    private let rpc: WebSocketRPCClient

    public init(
        environment: Environment,
        credentialStore: any CredentialStore,
        httpTransport: any HTTPTransport = URLSessionHTTPTransport(),
        webSocketConnector: any WebSocketConnecting = URLSessionWebSocketConnector(),
        managedAuthorization: (any ManagedEnvironmentAuthorizing)? = nil,
        rpcConnectionWaitTimeout: Duration = .seconds(4)
    ) {
        self.environment = environment
        let api = EnvironmentAPI(
            transport: httpTransport,
            credentials: credentialStore,
            managedAuthorization: managedAuthorization
        )
        self.api = api
        self.rpc = WebSocketRPCClient(
            connector: webSocketConnector,
            connectionWaitTimeout: rpcConnectionWaitTimeout
        ) {
            let ticket = try await api.webSocketTicket(for: environment)
            var components = URLComponents(
                url: environment.webSocketBaseURL,
                resolvingAgainstBaseURL: false
            )!
            if components.path.isEmpty || components.path == "/" {
                components.path = "/ws"
            }
            var query = components.queryItems ?? []
            query.removeAll { $0.name == "wsTicket" }
            query.append(URLQueryItem(name: "wsTicket", value: ticket.ticket))
            components.queryItems = query
            guard let url = components.url else { throw PairingURLError.invalidURL }
            return url
        }
    }

    public func connect() async {
        await rpc.start()
    }

    public func disconnect() async {
        await rpc.stop()
    }

    public func liveConnectionActive() async -> Bool {
        await rpc.isConnected()
    }

    public func shellSnapshot(
        timeoutInterval: TimeInterval? = nil
    ) async throws -> OrchestrationV2ShellSnapshot {
        try await api.shellSnapshot(
            for: environment,
            timeoutInterval: timeoutInterval
        )
    }

    /// The archived snapshot is the shell snapshot without an `archivedThreads`
    /// list — its `threads` *are* the archived ones — so the same type decodes
    /// both.
    public func archivedShellSnapshot() async throws -> OrchestrationV2ShellSnapshot {
        try await rpc.request(
            RPCMethod.getArchivedShellSnapshot.rawValue,
            as: OrchestrationV2ShellSnapshot.self
        )
    }

    public func threadSnapshot(
        id: String,
        maxVisibleItems: Int? = nil
    ) async throws -> OrchestrationV2ThreadDetailSnapshot {
        try await api.threadSnapshot(
            id: id,
            environment: environment,
            maxVisibleItems: maxVisibleItems
        )
    }

    public func serverConfig() async throws -> ServerConfigSnapshot {
        try await rpc.request(
            RPCMethod.serverGetConfig.rawValue,
            as: ServerConfigSnapshot.self
        )
    }

    public func serverConfigEvents() async
        -> AsyncThrowingStream<ServerConfigStreamEvent, Error>
    {
        await rpc.subscribe(
            RPCMethod.subscribeServerConfig.rawValue,
            as: ServerConfigStreamEvent.self
        )
    }

    public func clientSessions() async throws -> [AuthClientSession] {
        try await api.clientSessions(for: environment)
    }

    public func authSession() async throws -> AuthSessionState {
        try await api.session(for: environment)
    }

    @discardableResult
    public func revokeClientSession(id: String) async throws -> Bool {
        try await api.revokeClientSession(id: id, environment: environment).revoked
    }

    @discardableResult
    public func revokeOtherClientSessions() async throws -> Int {
        try await api.revokeOtherClientSessions(for: environment).revokedCount
    }

    /// HTTP live-sync fallback. Each iteration is an independent request, so a
    /// transient network loss naturally reconnects without replaying commands.
    public func pollShell(
        every interval: Duration = .seconds(2)
    ) -> AsyncThrowingStream<OrchestrationV2ShellSnapshot, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var lastSequence: Int?
                while !Task.isCancelled {
                    do {
                        let snapshot = try await self.shellSnapshot()
                        if lastSequence != snapshot.snapshotSequence {
                            lastSequence = snapshot.snapshotSequence
                            continuation.yield(snapshot)
                        }
                    } catch is CancellationError {
                        break
                    } catch {
                        // Keep retrying transient HTTP failures. Authentication
                        // failures surface from direct loads and pairing UI.
                    }
                    try? await Task.sleep(for: interval)
                }
                continuation.finish()
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    public func shellEvents(
        after sequence: Int? = nil
    ) async -> AsyncThrowingStream<OrchestrationV2ShellStreamItem, Error> {
        var payload: [String: JSONValue] = ["requestCompletionMarker": .bool(true)]
        if let sequence { payload["afterSequence"] = .number(Double(sequence)) }
        return await rpc.subscribe(
            RPCMethod.subscribeShell.rawValue,
            payload: .object(payload),
            as: OrchestrationV2ShellStreamItem.self
        )
    }

    /// `snapshotMaxVisibleItems` bounds any snapshot frame this subscription
    /// sends. The HTTP snapshot endpoint spells the same idea `maxVisibleItems`.
    public func threadEvents(
        threadID: String,
        after sequence: Int? = nil,
        snapshotMaxVisibleItems: Int? = nil
    ) async -> AsyncThrowingStream<OrchestrationV2ThreadStreamItem, Error> {
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID),
            "requestCompletionMarker": .bool(true),
        ]
        if let sequence { payload["afterSequence"] = .number(Double(sequence)) }
        if let snapshotMaxVisibleItems {
            payload["snapshotMaxVisibleItems"] = .number(Double(snapshotMaxVisibleItems))
        }
        return await rpc.subscribe(
            RPCMethod.subscribeThread.rawValue,
            payload: .object(payload),
            as: OrchestrationV2ThreadStreamItem.self
        )
    }

    /// Sends an orchestration V2 command.
    ///
    /// WebSocket only. This fork's `EnvironmentOrchestrationHttpApi` serves the
    /// shell and thread-snapshot GETs and nothing else, so the HTTP dispatch
    /// fallback that used to sit here could only ever 404 — turning "the socket
    /// is down" into an opaque HTTP error on the way out. Letting `RPCError`
    /// surface keeps the real reason visible, and every caller that needs to
    /// survive an ambiguous send already reconciles against a fresh snapshot.
    @discardableResult
    public func dispatch(_ command: JSONValue) async throws -> DispatchResult {
        try await dispatchOverWebSocket(command)
    }

    /// Sends a message on an existing thread.
    ///
    /// `runtimeMode`/`interactionMode` are deliberately absent: this fork's
    /// `message.dispatch` carries neither. Changing a thread's mode is a
    /// separate `thread.runtime-mode.set` / `thread.interaction-mode.set`
    /// command, so folding a mode into the send would be dropped on the floor.
    @discardableResult
    public func sendTurn(
        threadID: String,
        text: String,
        model: ModelSelection? = nil,
        attachments: [UploadChatAttachment] = [],
        dispatchMode: MessageDispatchMode = .startImmediately,
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString
    ) async throws -> DispatchResult {
        let persisted = try await persistAttachments(
            threadID: threadID,
            messageID: messageID,
            attachments: attachments
        )
        return try await dispatch(
            try OrchestrationCommands.sendTurn(
                threadID: threadID,
                text: text,
                model: model,
                attachments: persisted,
                dispatchMode: dispatchMode,
                commandID: commandID,
                messageID: messageID
            )
        )
    }

    /// Writes composer uploads into the server's attachment store and returns
    /// the persisted `ChatAttachment` values.
    ///
    /// `message.dispatch` and `orchestration.launchThread` both take persisted
    /// attachments — an `id`, no bytes — so inline `dataUrl` uploads have to be
    /// exchanged for stored ones first. This mirrors what `client-runtime` does
    /// before either call.
    public func persistAttachments(
        threadID: String,
        messageID: String,
        attachments: [UploadChatAttachment]
    ) async throws -> [JSONValue] {
        guard !attachments.isEmpty else { return [] }
        let result = try await rpc.request(
            RPCMethod.assetsPersistChatAttachments.rawValue,
            payload: .object([
                "threadId": .string(threadID),
                "messageId": .string(messageID),
                "attachments": .array(attachments.map(\.jsonValue)),
            ]),
            as: JSONValue.self
        )
        guard case let .array(persisted)? = result["attachments"] else {
            throw RPCError.protocolViolation(
                "assets.persistChatAttachments did not return an attachment list."
            )
        }
        return persisted
    }

    @discardableResult
    public func createThread(
        threadID: String = UUID().uuidString,
        projectID: String,
        title: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        branch: String? = nil,
        worktreePath: String? = nil
    ) async throws -> DispatchResult {
        try await dispatch(
            try OrchestrationCommands.createThread(
                threadID: threadID,
                projectID: projectID,
                title: title,
                model: model,
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                branch: branch,
                worktreePath: worktreePath
            )
        )
    }

    /// Creates a thread and starts its first turn.
    ///
    /// This is `orchestration.launchThread` rather than a dispatched command:
    /// creating the thread, provisioning its workspace and dispatching the
    /// first message is one server-side operation in this fork, and its input
    /// is not a member of the command union.
    @discardableResult
    public func createThreadAndSend(
        threadID: String = UUID().uuidString,
        projectID: String,
        title: String,
        text: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        branch: String? = nil,
        worktreePath: String? = nil,
        worktreePreparation: ThreadWorktreePreparation? = nil,
        prepareWorkspace: Bool? = nil,
        attachments: [UploadChatAttachment] = [],
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString
    ) async throws -> ThreadLaunchResult {
        let persisted = try await persistAttachments(
            threadID: threadID,
            messageID: messageID,
            attachments: attachments
        )
        return try await rpc.request(
            RPCMethod.launchThread.rawValue,
            payload: try OrchestrationCommands.createThreadAndSend(
                threadID: threadID,
                projectID: projectID,
                title: title,
                text: text,
                model: model,
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                branch: branch,
                worktreePath: worktreePath,
                worktreePreparation: worktreePreparation,
                prepareWorkspace: prepareWorkspace,
                attachments: persisted,
                commandID: commandID,
                messageID: messageID
            ),
            as: ThreadLaunchResult.self
        )
    }

    private func dispatchOverWebSocket(_ command: JSONValue) async throws -> DispatchResult {
        try await rpc.request(
            RPCMethod.dispatchCommand.rawValue,
            payload: command,
            as: DispatchResult.self
        )
    }

    /// `project.create` is a `ProjectMutation`, not an orchestration command:
    /// it travels over `projects.mutate` and answers with the created project
    /// rather than a dispatch sequence.
    @discardableResult
    public func createProject(
        projectID: String = UUID().uuidString,
        title: String,
        workspaceRoot: String,
        defaultModel: ModelSelection? = nil,
        createWorkspaceRootIfMissing: Bool = false
    ) async throws -> JSONValue {
        try await rpc.request(
            RPCMethod.projectsMutate.rawValue,
            payload: try OrchestrationCommands.createProject(
                projectID: projectID,
                title: title,
                workspaceRoot: workspaceRoot,
                defaultModel: defaultModel,
                createWorkspaceRootIfMissing: createWorkspaceRootIfMissing
            ),
            as: JSONValue.self
        )
    }

    @discardableResult
    public func archive(threadID: String, archived: Bool) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.archive(threadID: threadID, archived: archived))
    }

    @discardableResult
    public func delete(threadID: String) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.deleteThread(threadID: threadID))
    }

    @discardableResult
    public func rename(threadID: String, title: String) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.rename(threadID: threadID, title: title))
    }

    @discardableResult
    public func regenerateTitle(
        threadID: String,
        regenerate: Bool = true,
        commandID: String = UUID().uuidString
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.regenerateTitle(
                threadID: threadID,
                regenerate: regenerate,
                commandID: commandID
            )
        )
    }

    /// Generates the thread's handoff document.
    ///
    /// An RPC rather than a dispatched command: it computes and returns a value
    /// instead of mutating the thread, and the server may spend an AI call on
    /// the summary before answering.
    public func handoffScript(threadID: String) async throws -> HandoffScriptResult {
        try await rpc.request(
            RPCMethod.generateHandoffScript.rawValue,
            payload: .object(["threadId": .string(threadID)]),
            as: HandoffScriptResult.self
        )
    }

    @discardableResult
    public func mergeBack(
        sourceThreadID: String,
        targetThreadID: String,
        runID: String,
        commandID: String = UUID().uuidString
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.mergeBack(
                sourceThreadID: sourceThreadID,
                targetThreadID: targetThreadID,
                runID: runID,
                commandID: commandID
            )
        )
    }

    /// Detaches every named provider session, one command each.
    ///
    /// Each detach derives its command id from the shared gesture id, so a retry
    /// of the whole gesture is deduplicated per session instead of colliding on
    /// a single receipt. Dispatches run in sequence: they mutate one thread's
    /// session set, and a partial failure should stop rather than race ahead.
    public func detachProviderSessions(
        threadID: String,
        providerSessionIDs: [String],
        reason: String? = nil,
        commandID: String = UUID().uuidString
    ) async throws {
        for providerSessionID in providerSessionIDs {
            _ = try await dispatch(
                OrchestrationCommands.detachProviderSession(
                    threadID: threadID,
                    providerSessionID: providerSessionID,
                    reason: reason,
                    commandID: OrchestrationCommands.detachCommandID(
                        commandID: commandID,
                        providerSessionID: providerSessionID
                    )
                )
            )
        }
    }

    @discardableResult
    public func reorderQueuedRun(
        threadID: String,
        runID: String,
        beforeRunID: String?
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.reorderQueuedRun(
                threadID: threadID,
                runID: runID,
                beforeRunID: beforeRunID
            )
        )
    }

    @discardableResult
    public func promoteQueuedRun(
        threadID: String,
        queuedRunID: String,
        targetRunID: String
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.promoteQueuedRun(
                threadID: threadID,
                queuedRunID: queuedRunID,
                targetRunID: targetRunID
            )
        )
    }

    @discardableResult
    public func cancelQueuedRun(
        threadID: String,
        runID: String
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.cancelQueuedRun(threadID: threadID, runID: runID)
        )
    }

    /// Restores the thread's workspace to `checkpointID` within `scopeID`.
    @discardableResult
    public func rollBackToCheckpoint(
        threadID: String,
        scopeID: String,
        checkpointID: String,
        commandID: String = UUID().uuidString
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.checkpointRollback(
                threadID: threadID,
                scopeID: scopeID,
                checkpointID: checkpointID,
                commandID: commandID
            )
        )
    }

    @discardableResult
    public func editQueuedRun(
        threadID: String,
        runID: String,
        text: String
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.editQueuedRun(
                threadID: threadID,
                runID: runID,
                text: text
            )
        )
    }

    /// Interrupts a specific run. V2 has no separate turn identity, and
    /// `run.interrupt` requires the run, so callers resolve the active run
    /// before asking.
    @discardableResult
    public func interrupt(
        threadID: String,
        runID: String,
        reason: String? = nil
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.interrupt(
                threadID: threadID,
                runID: runID,
                reason: reason
            )
        )
    }

    @discardableResult
    public func respondToApproval(
        threadID: String,
        requestID: String,
        decision: String
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.respondToApproval(
                threadID: threadID,
                requestID: requestID,
                decision: decision
            )
        )
    }

    @discardableResult
    public func respondToUserInput(
        threadID: String,
        requestID: String,
        answers: [String: JSONValue]
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.respondToUserInput(
                threadID: threadID,
                requestID: requestID,
                answers: answers
            )
        )
    }

    @discardableResult
    public func settle(threadID: String, settled: Bool) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.settle(threadID: threadID, settled: settled))
    }

    @discardableResult
    public func snooze(threadID: String, until: Date?) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.snooze(threadID: threadID, until: until)
        )
    }

    @discardableResult
    public func pin(threadID: String, pinned: Bool) async throws -> DispatchResult {
        try await dispatch(OrchestrationCommands.pin(threadID: threadID, pinned: pinned))
    }

    public func setWorkInboxRole(threadID: String, role: String?) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.setWorkInboxRole(threadID: threadID, role: role)
        )
    }

    @discardableResult
    public func setRuntimeMode(
        threadID: String,
        mode: RuntimeMode
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.setRuntimeMode(threadID: threadID, mode: mode)
        )
    }

    @discardableResult
    public func setInteractionMode(
        threadID: String,
        mode: InteractionMode
    ) async throws -> DispatchResult {
        try await dispatch(
            OrchestrationCommands.setInteractionMode(threadID: threadID, mode: mode)
        )
    }

    // MARK: Workspace files

    // MARK: - Pull requests
    //
    // Host-backed change-request reads, addressed by `PullRequestRef`
    // (`packages/contracts/src/pullRequest.ts`): the server project id, the
    // repository's display name, and the change request's number on the host.

    public func pullRequestDetail(
        projectID: String,
        repository: String,
        number: Int
    ) async throws -> PullRequestDetail {
        try await rpc.request(
            RPCMethod.pullRequestsDetail.rawValue,
            payload: .object([
                "projectId": .string(projectID),
                "repository": .string(repository),
                "number": .number(Double(number)),
            ]),
            as: PullRequestDetail.self
        )
    }

    public func pullRequestActivity(
        projectID: String,
        repository: String,
        number: Int
    ) async throws -> PullRequestActivity {
        try await rpc.request(
            RPCMethod.pullRequestsActivity.rawValue,
            payload: .object([
                "projectId": .string(projectID),
                "repository": .string(repository),
                "number": .number(Double(number)),
            ]),
            as: PullRequestActivity.self
        )
    }

    // MARK: - Scheduled tasks
    //
    // Environment-scoped, and RPCs rather than orchestration commands: an
    // automation is a row the server owns and answers with, not a mutation of a
    // thread's projection.

    public func scheduledTasks() async throws -> [ScheduledTaskRecord] {
        try await rpc.request(
            RPCMethod.scheduledTasksList.rawValue,
            as: ScheduledTaskListResult.self
        ).tasks
    }

    public func upsertScheduledTask(
        _ input: ScheduledTaskUpsert,
        commandID: String = UUID().uuidString
    ) async throws -> ScheduledTaskRecord {
        try await rpc.request(
            RPCMethod.scheduledTasksUpsert.rawValue,
            payload: try input.jsonValue(commandID: commandID),
            as: ScheduledTaskMutationResult.self
        ).task
    }

    /// Partial update: only the flag moves, so toggling a row cannot revert an
    /// edit made to the same automation somewhere else.
    public func setScheduledTaskEnabled(
        id: String,
        enabled: Bool
    ) async throws -> ScheduledTaskRecord {
        try await rpc.request(
            RPCMethod.scheduledTasksSetEnabled.rawValue,
            payload: .object(["id": .string(id), "enabled": .bool(enabled)]),
            as: ScheduledTaskMutationResult.self
        ).task
    }

    public func runScheduledTaskNow(id: String) async throws -> ScheduledTaskRecord {
        try await rpc.request(
            RPCMethod.scheduledTasksRunNow.rawValue,
            payload: .object(["id": .string(id)]),
            as: ScheduledTaskMutationResult.self
        ).task
    }

    public func deleteScheduledTask(id: String) async throws {
        try await rpc.request(
            RPCMethod.scheduledTasksDelete.rawValue,
            payload: .object(["id": .string(id)])
        )
    }

    // MARK: - Hermes proactive inbox
    //
    // Runs a Hermes gateway performed on its own schedule. Pushed rather than
    // polled: a cron job can finish at any hour, and the server emits the whole
    // snapshot on subscribe and again after every change.

    public func hermesProactiveInboxEvents() async
        -> AsyncThrowingStream<HermesProactiveInboxSnapshot, Error>
    {
        await rpc.subscribe(
            RPCMethod.subscribeHermesProactiveInbox.rawValue,
            payload: .object([:]),
            as: HermesProactiveInboxSnapshot.self
        )
    }

    public func markHermesProactiveNotifications(
        ids: [String],
        status: String
    ) async throws -> HermesProactiveMarkResult {
        try await rpc.request(
            RPCMethod.hermesProactiveMarkNotifications.rawValue,
            payload: .object([
                "notificationIds": .array(ids.map { .string($0) }),
                "status": .string(status),
            ]),
            as: HermesProactiveMarkResult.self
        )
    }

    public func listProjectEntries(cwd: String) async throws -> ProjectEntriesResult {
        try await rpc.request(
            RPCMethod.projectsListEntries.rawValue,
            payload: .object(["cwd": .string(cwd)]),
            as: ProjectEntriesResult.self
        )
    }

    public func searchProjectEntries(
        cwd: String,
        query: String,
        limit: Int = 100
    ) async throws -> ProjectEntriesResult {
        try await rpc.request(
            RPCMethod.projectsSearchEntries.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "query": .string(query),
                "limit": .number(Double(limit)),
            ]),
            as: ProjectEntriesResult.self
        )
    }

    public func readProjectFile(
        cwd: String,
        relativePath: String
    ) async throws -> ProjectReadFileResult {
        try await rpc.request(
            RPCMethod.projectsReadFile.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "relativePath": .string(relativePath),
            ]),
            as: ProjectReadFileResult.self
        )
    }

    public func writeProjectFile(
        cwd: String,
        relativePath: String,
        contents: String
    ) async throws -> ProjectWriteFileResult {
        try await rpc.request(
            RPCMethod.projectsWriteFile.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "relativePath": .string(relativePath),
                "contents": .string(contents),
            ]),
            as: ProjectWriteFileResult.self
        )
    }

    public func browseFilesystem(
        partialPath: String,
        cwd: String? = nil
    ) async throws -> FilesystemBrowseResult {
        var payload: [String: JSONValue] = ["partialPath": .string(partialPath)]
        if let cwd { payload["cwd"] = .string(cwd) }
        return try await rpc.request(
            RPCMethod.filesystemBrowse.rawValue,
            payload: .object(payload),
            as: FilesystemBrowseResult.self
        )
    }

    /// Scans provider transcript directories on this server and returns the
    /// usage summary for an inclusive `[sinceDay, untilDay]` window of
    /// `YYYY-MM-DD` days bucketed in `timeZone` (IANA — an offset would be
    /// wrong across a DST boundary).
    public func getUsageSummary(
        sinceDay: String,
        untilDay: String,
        timeZone: String
    ) async throws -> UsageSummary {
        try await rpc.request(
            RPCMethod.serverGetUsageSummary.rawValue,
            payload: .object([
                "sinceDay": .string(sinceDay),
                "untilDay": .string(untilDay),
                "timeZone": .string(timeZone),
            ]),
            as: UsageSummary.self
        )
    }

    /// Issues a short-lived authenticated URL for a persisted attachment,
    /// workspace preview, or project favicon.
    public func createAssetURL(resource: AssetResource) async throws -> AssetCreateURLResult {
        try await rpc.request(
            RPCMethod.assetsCreateURL.rawValue,
            payload: .object(["resource": resource.jsonValue]),
            as: AssetCreateURLResult.self
        )
    }

    public func resolvedAssetURL(resource: AssetResource) async throws -> URL {
        try await resolvedAsset(resource: resource).url
    }

    public func resolvedAsset(resource: AssetResource) async throws -> ResolvedAssetURL {
        let result = try await createAssetURL(resource: resource)
        guard let url = URL(
            string: result.relativeUrl,
            relativeTo: environment.httpBaseURL
        )?.absoluteURL else {
            throw RPCError.protocolViolation("The server returned an invalid asset URL.")
        }
        return ResolvedAssetURL(
            url: url,
            expiresAt: Date(timeIntervalSince1970: result.expiresAt / 1_000)
        )
    }

    // MARK: VCS and source control

    public func refreshVCSStatus(cwd: String) async throws -> VCSStatus {
        try await rpc.request(
            RPCMethod.vcsRefreshStatus.rawValue,
            payload: .object(["cwd": .string(cwd)]),
            as: VCSStatus.self
        )
    }

    public func vcsStatusEvents(cwd: String) async
        -> AsyncThrowingStream<VCSStatusEvent, Error>
    {
        await rpc.subscribe(
            RPCMethod.subscribeVCSStatus.rawValue,
            payload: .object(["cwd": .string(cwd)]),
            as: VCSStatusEvent.self
        )
    }

    public func listVCSRefs(
        cwd: String,
        query: String? = nil,
        cursor: Int? = nil,
        kind: String? = nil,
        refresh: Bool = false,
        limit: Int = 100
    ) async throws -> VCSRefsResult {
        var payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "refresh": .bool(refresh),
            "limit": .number(Double(limit)),
        ]
        if let query { payload["query"] = .string(query) }
        if let cursor { payload["cursor"] = .number(Double(cursor)) }
        if let kind { payload["refKind"] = .string(kind) }
        return try await rpc.request(
            RPCMethod.vcsListRefs.rawValue,
            payload: .object(payload),
            as: VCSRefsResult.self
        )
    }

    public func pull(cwd: String) async throws -> VCSPullResult {
        try await rpc.request(
            RPCMethod.vcsPull.rawValue,
            payload: .object(["cwd": .string(cwd)]),
            as: VCSPullResult.self
        )
    }

    public func createVCSRef(
        cwd: String,
        name: String,
        switchToRef: Bool = true
    ) async throws -> VCSCreateRefResult {
        try await rpc.request(
            RPCMethod.vcsCreateRef.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "refName": .string(name),
                "switchRef": .bool(switchToRef),
            ]),
            as: VCSCreateRefResult.self
        )
    }

    public func switchVCSRef(cwd: String, name: String) async throws -> VCSSwitchRefResult {
        try await rpc.request(
            RPCMethod.vcsSwitchRef.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "refName": .string(name),
            ]),
            as: VCSSwitchRefResult.self
        )
    }

    public func createWorktree(
        cwd: String,
        refName: String,
        newRefName: String? = nil,
        baseRefName: String? = nil,
        path: String? = nil
    ) async throws -> VCSCreateWorktreeResult {
        var payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "refName": .string(refName),
            "path": path.map(JSONValue.string) ?? .null,
        ]
        if let newRefName { payload["newRefName"] = .string(newRefName) }
        if let baseRefName { payload["baseRefName"] = .string(baseRefName) }
        return try await rpc.request(
            RPCMethod.vcsCreateWorktree.rawValue,
            payload: .object(payload),
            as: VCSCreateWorktreeResult.self
        )
    }

    public func removeWorktree(cwd: String, path: String, force: Bool = false) async throws {
        try await rpc.request(
            RPCMethod.vcsRemoveWorktree.rawValue,
            payload: .object([
                "cwd": .string(cwd),
                "path": .string(path),
                "force": .bool(force),
            ])
        )
    }

    public func initializeVCS(cwd: String, kind: String? = nil) async throws {
        var payload: [String: JSONValue] = ["cwd": .string(cwd)]
        if let kind { payload["kind"] = .string(kind) }
        try await rpc.request(RPCMethod.vcsInitialize.rawValue, payload: .object(payload))
    }

    public func runGitAction(
        cwd: String,
        action: GitStackedAction,
        commitMessage: String? = nil,
        featureBranch: Bool? = nil,
        filePaths: [String]? = nil,
        actionID: String = UUID().uuidString
    ) async throws -> AsyncThrowingStream<GitActionProgressEvent, Error> {
        var payload: [String: JSONValue] = [
            "actionId": .string(actionID),
            "cwd": .string(cwd),
            "action": .string(action.rawValue),
        ]
        if let commitMessage { payload["commitMessage"] = .string(commitMessage) }
        if let featureBranch { payload["featureBranch"] = .bool(featureBranch) }
        if let filePaths { payload["filePaths"] = .array(filePaths.map(JSONValue.string)) }
        // A command stream must fail on disconnect instead of replaying a
        // potentially successful commit or push.
        return await rpc.subscribe(
            RPCMethod.gitRunStackedAction.rawValue,
            payload: .object(payload),
            reconnect: false,
            as: GitActionProgressEvent.self
        )
    }

    public func lookupRepository(
        provider: SourceControlProviderKind,
        repository: String,
        cwd: String? = nil
    ) async throws -> SourceControlRepositoryInfo {
        var payload: [String: JSONValue] = [
            "provider": .string(provider.rawValue),
            "repository": .string(repository),
        ]
        if let cwd { payload["cwd"] = .string(cwd) }
        return try await rpc.request(
            RPCMethod.sourceControlLookup.rawValue,
            payload: .object(payload),
            as: SourceControlRepositoryInfo.self
        )
    }

    public func discoverSourceControl() async throws -> SourceControlDiscoveryResult {
        try await rpc.request(
            RPCMethod.serverDiscoverSourceControl.rawValue,
            payload: .object([:]),
            as: SourceControlDiscoveryResult.self
        )
    }

    public func cloneRepository(
        provider: SourceControlProviderKind? = nil,
        repository: String? = nil,
        remoteURL: String? = nil,
        destinationPath: String,
        cloneProtocol: String? = nil
    ) async throws -> SourceControlCloneResult {
        var payload: [String: JSONValue] = ["destinationPath": .string(destinationPath)]
        if let provider { payload["provider"] = .string(provider.rawValue) }
        if let repository { payload["repository"] = .string(repository) }
        if let remoteURL { payload["remoteUrl"] = .string(remoteURL) }
        if let cloneProtocol { payload["protocol"] = .string(cloneProtocol) }
        return try await rpc.request(
            RPCMethod.sourceControlClone.rawValue,
            payload: .object(payload),
            as: SourceControlCloneResult.self
        )
    }

    public func publishRepository(
        cwd: String,
        provider: SourceControlProviderKind,
        repository: String,
        visibility: String,
        remoteName: String? = nil,
        cloneProtocol: String? = nil
    ) async throws -> SourceControlPublishResult {
        var payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "provider": .string(provider.rawValue),
            "repository": .string(repository),
            "visibility": .string(visibility),
        ]
        if let remoteName { payload["remoteName"] = .string(remoteName) }
        if let cloneProtocol { payload["protocol"] = .string(cloneProtocol) }
        return try await rpc.request(
            RPCMethod.sourceControlPublish.rawValue,
            payload: .object(payload),
            as: SourceControlPublishResult.self
        )
    }

    // MARK: Review

    public func reviewDiffPreview(
        cwd: String,
        baseRef: String? = nil,
        ignoreWhitespace: Bool = false
    ) async throws -> ReviewDiffPreview {
        var payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "ignoreWhitespace": .bool(ignoreWhitespace),
        ]
        if let baseRef { payload["baseRef"] = .string(baseRef) }
        return try await rpc.request(
            RPCMethod.reviewDiffPreview.rawValue,
            payload: .object(payload),
            as: ReviewDiffPreview.self
        )
    }

    public func reviewDiffFileContents(
        cwd: String,
        sourceKind: String,
        changeType: String,
        baseRef: String?,
        headRef: String?,
        oldPath: String,
        newPath: String
    ) async throws -> ReviewDiffFileContents {
        let payload: [String: JSONValue] = [
            "cwd": .string(cwd),
            "sourceKind": .string(sourceKind),
            "changeType": .string(changeType),
            "baseRef": baseRef.map(JSONValue.string) ?? .null,
            "headRef": headRef.map(JSONValue.string) ?? .null,
            "oldPath": .string(oldPath),
            "newPath": .string(newPath),
        ]
        return try await rpc.request(
            RPCMethod.reviewDiffFileContents.rawValue,
            payload: .object(payload),
            as: ReviewDiffFileContents.self
        )
    }

    // MARK: Checkpoint diffs

    /// The patch between two of a thread's turn checkpoints.
    ///
    /// The range is a pair of *turn counts*, not checkpoint ids: the server
    /// resolves each end against the checkpoint whose `appRunOrdinal` matches
    /// (`apps/server/src/checkpointing/CheckpointDiffQuery.ts`). `fromTurnCount`
    /// of 0 is not addressable here — the thread-start checkpoint is a synthetic
    /// baseline the server only materialises for `getFullThreadDiff` — so use
    /// ``fullThreadDiff(threadID:toTurnCount:ignoreWhitespace:)`` for that end.
    ///
    /// `ignoreWhitespace` defaults to false to match this client's working-tree
    /// path (`reviewDiffPreview`); the server's own default when the key is
    /// absent is true, so it is always sent.
    public func turnDiff(
        threadID: String,
        fromTurnCount: Int,
        toTurnCount: Int,
        ignoreWhitespace: Bool = false
    ) async throws -> ThreadTurnDiff {
        try await rpc.request(
            RPCMethod.getTurnDiff.rawValue,
            payload: .object([
                "threadId": .string(threadID),
                "fromTurnCount": .number(Double(fromTurnCount)),
                "toTurnCount": .number(Double(toTurnCount)),
                "ignoreWhitespace": .bool(ignoreWhitespace),
            ]),
            as: ThreadTurnDiff.self
        )
    }

    /// The patch from the thread's starting state up to `toTurnCount`.
    public func fullThreadDiff(
        threadID: String,
        toTurnCount: Int,
        ignoreWhitespace: Bool = false
    ) async throws -> ThreadTurnDiff {
        try await rpc.request(
            RPCMethod.getFullThreadDiff.rawValue,
            payload: .object([
                "threadId": .string(threadID),
                "toTurnCount": .number(Double(toTurnCount)),
                "ignoreWhitespace": .bool(ignoreWhitespace),
            ]),
            as: ThreadTurnDiff.self
        )
    }

    // MARK: Terminal

    public func openTerminal(
        threadID: String,
        terminalID: String,
        cwd: String,
        worktreePath: String? = nil,
        columns: Int? = nil,
        rows: Int? = nil,
        environmentVariables: [String: String]? = nil
    ) async throws -> TerminalSessionSnapshot {
        let payload = try terminalPayload(
            threadID: threadID,
            terminalID: terminalID,
            cwd: cwd,
            worktreePath: worktreePath,
            columns: columns,
            rows: rows,
            environmentVariables: environmentVariables
        )
        return try await rpc.request(
            RPCMethod.terminalOpen.rawValue,
            payload: payload,
            as: TerminalSessionSnapshot.self
        )
    }

    public func attachTerminal(
        threadID: String,
        terminalID: String,
        cwd: String? = nil,
        worktreePath: String? = nil,
        columns: Int? = nil,
        rows: Int? = nil,
        environmentVariables: [String: String]? = nil,
        restartIfNotRunning: Bool = false
    ) async throws -> AsyncThrowingStream<TerminalEvent, Error> {
        var payload = try terminalPayloadObject(
            threadID: threadID,
            terminalID: terminalID,
            cwd: cwd,
            worktreePath: worktreePath,
            columns: columns,
            rows: rows,
            environmentVariables: environmentVariables
        )
        payload["restartIfNotRunning"] = .bool(restartIfNotRunning)
        return await rpc.subscribe(
            RPCMethod.terminalAttach.rawValue,
            payload: .object(payload),
            as: TerminalEvent.self
        )
    }

    public func terminalEvents() async -> AsyncThrowingStream<TerminalEvent, Error> {
        await rpc.subscribe(
            RPCMethod.subscribeTerminalEvents.rawValue,
            as: TerminalEvent.self
        )
    }

    public func terminalMetadataEvents() async
        -> AsyncThrowingStream<TerminalMetadataEvent, Error>
    {
        await rpc.subscribe(
            RPCMethod.subscribeTerminalMetadata.rawValue,
            as: TerminalMetadataEvent.self
        )
    }

    public func writeTerminal(
        threadID: String,
        terminalID: String,
        data: String
    ) async throws {
        try await rpc.request(
            RPCMethod.terminalWrite.rawValue,
            payload: .object([
                "threadId": .string(threadID),
                "terminalId": .string(terminalID),
                "data": .string(data),
            ])
        )
    }

    public func resizeTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws {
        try await rpc.request(
            RPCMethod.terminalResize.rawValue,
            payload: .object([
                "threadId": .string(threadID),
                "terminalId": .string(terminalID),
                "cols": .number(Double(columns)),
                "rows": .number(Double(rows)),
            ])
        )
    }

    public func clearTerminal(threadID: String, terminalID: String) async throws {
        try await rpc.request(
            RPCMethod.terminalClear.rawValue,
            payload: terminalIdentity(threadID: threadID, terminalID: terminalID)
        )
    }

    public func restartTerminal(
        threadID: String,
        terminalID: String,
        cwd: String,
        worktreePath: String? = nil,
        columns: Int,
        rows: Int,
        environmentVariables: [String: String]? = nil
    ) async throws -> TerminalSessionSnapshot {
        let payload = try terminalPayload(
            threadID: threadID,
            terminalID: terminalID,
            cwd: cwd,
            worktreePath: worktreePath,
            columns: columns,
            rows: rows,
            environmentVariables: environmentVariables
        )
        return try await rpc.request(
            RPCMethod.terminalRestart.rawValue,
            payload: payload,
            as: TerminalSessionSnapshot.self
        )
    }

    public func closeTerminal(
        threadID: String,
        terminalID: String? = nil,
        deleteHistory: Bool = false
    ) async throws {
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID),
            "deleteHistory": .bool(deleteHistory),
        ]
        if let terminalID { payload["terminalId"] = .string(terminalID) }
        try await rpc.request(RPCMethod.terminalClose.rawValue, payload: .object(payload))
    }

    private func terminalIdentity(threadID: String, terminalID: String) -> JSONValue {
        .object([
            "threadId": .string(threadID),
            "terminalId": .string(terminalID),
        ])
    }

    private func terminalPayload(
        threadID: String,
        terminalID: String,
        cwd: String?,
        worktreePath: String?,
        columns: Int?,
        rows: Int?,
        environmentVariables: [String: String]?
    ) throws -> JSONValue {
        .object(
            try terminalPayloadObject(
                threadID: threadID,
                terminalID: terminalID,
                cwd: cwd,
                worktreePath: worktreePath,
                columns: columns,
                rows: rows,
                environmentVariables: environmentVariables
            )
        )
    }

    private func terminalPayloadObject(
        threadID: String,
        terminalID: String,
        cwd: String?,
        worktreePath: String?,
        columns: Int?,
        rows: Int?,
        environmentVariables: [String: String]?
    ) throws -> [String: JSONValue] {
        var payload: [String: JSONValue] = [
            "threadId": .string(threadID),
            "terminalId": .string(terminalID),
        ]
        if let cwd { payload["cwd"] = .string(cwd) }
        if let worktreePath {
            payload["worktreePath"] = .string(worktreePath)
        } else if cwd != nil {
            payload["worktreePath"] = .null
        }
        if let columns { payload["cols"] = .number(Double(columns)) }
        if let rows { payload["rows"] = .number(Double(rows)) }
        if let environmentVariables {
            payload["env"] = try JSONValue.encode(environmentVariables)
        }
        return payload
    }
}

/// Owns persisted environment selection and constructs scoped clients without
/// introducing UI-framework state into Core.
public struct EnvironmentPersistenceError: LocalizedError, Sendable {
    public let operationError: String
    public let rollbackErrors: [String]

    public var errorDescription: String? {
        "\(operationError) Recovery also failed: \(rollbackErrors.joined(separator: "; "))"
    }
}

public actor EnvironmentRuntime {
    public let environmentStore: EnvironmentStore
    public let credentialStore: any CredentialStore
    public nonisolated let supportsManagedAuthorization: Bool
    private let httpTransport: any HTTPTransport
    private let webSocketConnector: any WebSocketConnecting
    private let managedAuthorization: (any ManagedEnvironmentAuthorizing)?
    private var clients: [String: T3Client] = [:]

    public init(
        environmentStore: EnvironmentStore = EnvironmentStore(),
        credentialStore: any CredentialStore = KeychainCredentialStore(),
        httpTransport: any HTTPTransport = URLSessionHTTPTransport(),
        webSocketConnector: any WebSocketConnecting = URLSessionWebSocketConnector(),
        managedAuthorization: (any ManagedEnvironmentAuthorizing)? = nil
    ) {
        self.environmentStore = environmentStore
        self.credentialStore = credentialStore
        self.httpTransport = httpTransport
        self.webSocketConnector = webSocketConnector
        self.managedAuthorization = managedAuthorization
        supportsManagedAuthorization = managedAuthorization != nil
    }

    /// Guards the one-time React Native import so concurrent readers cannot run
    /// it twice on a cold launch.
    private var didAttemptLegacyImport = false

    public func environments() async throws -> [Environment] {
        try await importLegacyEnvironmentsIfNeeded()
        return try await environmentStore.load()
    }

    /// Adopts the React Native client's saved servers on first launch after the
    /// update. Runs here rather than at app start so it is ordered ahead of the
    /// first catalog read no matter which surface asks first.
    private func importLegacyEnvironmentsIfNeeded() async {
        guard !didAttemptLegacyImport else { return }
        didAttemptLegacyImport = true
        await LegacyReactNativeImport.run(
            environmentStore: environmentStore,
            credentialStore: credentialStore
        )
    }

    public func activeEnvironment() async throws -> Environment? {
        let environments = try await environmentStore.load()
        guard !environments.isEmpty else { return nil }
        let activeID = try await environmentStore.activeEnvironmentID()
        return environments.first(where: { $0.id == activeID }) ?? environments[0]
    }

    @discardableResult
    public func activate(id: String) async throws -> T3Client {
        let environments = try await environmentStore.load()
        guard let environment = environments.first(where: { $0.id == id }) else {
            throw RPCError.remote("Environment \(id) is not saved.")
        }
        try await environmentStore.setActiveEnvironment(id: id)
        return await client(for: environment)
    }

    public func activeClient() async throws -> T3Client? {
        guard let environment = try await activeEnvironment() else { return nil }
        return await client(for: environment)
    }

    @discardableResult
    public func pair(url: String, clientLabel: String? = nil) async throws -> T3Client {
        let service = PairingService(
            transport: httpTransport,
            environmentStore: environmentStore,
            credentialStore: credentialStore
        )
        let environment = try await service.pair(url: url, label: clientLabel)
        try await environmentStore.setActiveEnvironment(id: environment.id)
        return await client(for: environment)
    }

    @discardableResult
    public func pair(
        host: String,
        code: String,
        clientLabel: String? = nil
    ) async throws -> T3Client {
        let service = PairingService(
            transport: httpTransport,
            environmentStore: environmentStore,
            credentialStore: credentialStore
        )
        let environment = try await service.pair(host: host, code: code, label: clientLabel)
        try await environmentStore.setActiveEnvironment(id: environment.id)
        return await client(for: environment)
    }

    public func descriptor(at httpBaseURL: URL) async throws -> EnvironmentDescriptor {
        let api = EnvironmentAPI(transport: httpTransport, credentials: credentialStore)
        return try await api.descriptor(at: httpBaseURL)
    }

    /// Persists a fully validated managed environment. Both the environment
    /// metadata and the tagged DPoP credential must agree before either can
    /// replace an existing manual connection with the same server identity.
    @discardableResult
    public func saveManagedEnvironment(
        _ environment: Environment,
        credential: EnvironmentCredential
    ) async throws -> T3Client {
        guard environment.kind == .managedDPoP,
              environment.descriptor?.environmentId == environment.id,
              credential.authorizationMethod == .dpop,
              credential.managedEnvironmentID == environment.id,
              credential.proofKeyThumbprint?.isEmpty == false else {
            throw HTTPError.incompatibleCredential
        }

        let previousEnvironment = try await environmentStore.load()
            .first(where: { $0.id == environment.id })
        let previousActiveID = try await environmentStore.activeEnvironmentID()
        let previousCredential = try await credentialStore.credential(for: environment.id)
        try await credentialStore.setCredential(credential, for: environment.id)
        do {
            try await environmentStore.upsert(environment)
            try await environmentStore.setActiveEnvironment(id: environment.id)
        } catch {
            let operationError = error
            var rollbackErrors: [String] = []
            do {
                if let previousCredential {
                    try await credentialStore.setCredential(
                        previousCredential,
                        for: environment.id
                    )
                } else {
                    try await credentialStore.removeCredential(for: environment.id)
                }
            } catch {
                rollbackErrors.append("credential: \(error.localizedDescription)")
            }
            // EnvironmentStore's individual mutations are actor-atomic. Undo
            // only this record so a concurrent save for another environment
            // cannot be lost while this actor is reentrant across awaits.
            do {
                if let previousEnvironment {
                    _ = try await environmentStore.upsert(previousEnvironment)
                } else {
                    _ = try await environmentStore.remove(id: environment.id)
                }
            } catch {
                rollbackErrors.append("environment catalog: \(error.localizedDescription)")
            }
            do {
                let activeIDAfterFailure = try await environmentStore.activeEnvironmentID()
                if activeIDAfterFailure == environment.id {
                    try await environmentStore.setActiveEnvironment(id: previousActiveID)
                }
            } catch {
                rollbackErrors.append("active environment: \(error.localizedDescription)")
            }
            guard rollbackErrors.isEmpty else {
                throw EnvironmentPersistenceError(
                    operationError: operationError.localizedDescription,
                    rollbackErrors: rollbackErrors
                )
            }
            throw operationError
        }
        return await client(for: environment)
    }

    public func remove(id: String) async throws {
        let previousEnvironment = try await environmentStore.load()
            .first(where: { $0.id == id })
        let previousActiveID = try await environmentStore.activeEnvironmentID()
        // Never leave a catalog entry pointing at a credential that was
        // already destroyed when the catalog write itself fails.
        try await environmentStore.remove(id: id)
        do {
            try await credentialStore.removeCredential(for: id)
        } catch {
            let operationError = error
            var rollbackErrors: [String] = []
            if let previousEnvironment {
                do {
                    _ = try await environmentStore.upsert(previousEnvironment)
                } catch {
                    rollbackErrors.append("environment catalog: \(error.localizedDescription)")
                }
            }
            do {
                try await environmentStore.setActiveEnvironment(id: previousActiveID)
            } catch {
                rollbackErrors.append("active environment: \(error.localizedDescription)")
            }
            guard rollbackErrors.isEmpty else {
                throw EnvironmentPersistenceError(
                    operationError: operationError.localizedDescription,
                    rollbackErrors: rollbackErrors
                )
            }
            throw operationError
        }
        if let client = clients.removeValue(forKey: id) {
            await client.disconnect()
        }
    }

    /// Returns the cached client for a saved environment without changing the
    /// environment used for new projects and threads.
    public func client(for environment: Environment) async -> T3Client {
        if let existing = clients[environment.id] {
            if existing.environment == environment {
                return existing
            }
            // Publish the replacement before disconnecting the stale client.
            // Actor methods are reentrant across that await; removing first
            // allowed a concurrent caller to construct a second replacement.
            let replacement = T3Client(
                environment: environment,
                credentialStore: credentialStore,
                httpTransport: httpTransport,
                webSocketConnector: webSocketConnector,
                managedAuthorization: managedAuthorization
            )
            clients[environment.id] = replacement
            Task { await existing.disconnect() }
            return replacement
        }
        let client = T3Client(
            environment: environment,
            credentialStore: credentialStore,
            httpTransport: httpTransport,
            webSocketConnector: webSocketConnector,
            managedAuthorization: managedAuthorization
        )
        clients[environment.id] = client
        return client
    }

    /// Creates an uncached client for bounded one-shot WebSocket RPCs. Passive
    /// environment probes must not stop or mutate the shared client if that
    /// environment becomes active while the probe is in flight.
    public func ephemeralClient(for environment: Environment) -> T3Client {
        T3Client(
            environment: environment,
            credentialStore: credentialStore,
            httpTransport: httpTransport,
            webSocketConnector: webSocketConnector,
            managedAuthorization: managedAuthorization
        )
    }
}

public enum RPCMethod: String, Sendable {
    case serverProbe = "server.probe"
    case serverGetConfig = "server.getConfig"
    case dispatchCommand = "orchestration.dispatchCommand"
    case launchThread = "orchestration.launchThread"
    case generateHandoffScript = "orchestration.generateHandoffScript"
    case getTurnDiff = "orchestration.getTurnDiff"
    case getFullThreadDiff = "orchestration.getFullThreadDiff"
    case getArchivedShellSnapshot = "orchestration.getArchivedShellSnapshot"
    case subscribeShell = "orchestration.subscribeShell"
    case subscribeThread = "orchestration.subscribeThread"
    case projectsMutate = "projects.mutate"
    case projectsListEntries = "projects.listEntries"
    case projectsSearchEntries = "projects.searchEntries"
    case projectsReadFile = "projects.readFile"
    case projectsWriteFile = "projects.writeFile"
    case filesystemBrowse = "filesystem.browse"
    case assetsCreateURL = "assets.createUrl"
    case serverGetUsageSummary = "server.getUsageSummary"
    case assetsPersistChatAttachments = "assets.persistChatAttachments"
    case subscribeServerConfig
    case serverDiscoverSourceControl = "server.discoverSourceControl"
    case subscribeVCSStatus = "subscribeVcsStatus"
    case vcsPull = "vcs.pull"
    case vcsRefreshStatus = "vcs.refreshStatus"
    case vcsListRefs = "vcs.listRefs"
    case vcsCreateRef = "vcs.createRef"
    case vcsSwitchRef = "vcs.switchRef"
    case vcsCreateWorktree = "vcs.createWorktree"
    case vcsRemoveWorktree = "vcs.removeWorktree"
    case vcsInitialize = "vcs.init"
    case gitRunStackedAction = "git.runStackedAction"
    case sourceControlLookup = "sourceControl.lookupRepository"
    case sourceControlClone = "sourceControl.cloneRepository"
    case sourceControlPublish = "sourceControl.publishRepository"
    case pullRequestsDetail = "pullRequests.detail"
    case pullRequestsActivity = "pullRequests.activity"
    case reviewDiffPreview = "review.getDiffPreview"
    case reviewDiffFileContents = "review.getDiffFileContents"
    case terminalOpen = "terminal.open"
    case terminalAttach = "terminal.attach"
    case terminalWrite = "terminal.write"
    case terminalResize = "terminal.resize"
    case terminalClear = "terminal.clear"
    case terminalRestart = "terminal.restart"
    case terminalClose = "terminal.close"
    case subscribeTerminalEvents
    case subscribeTerminalMetadata
    case scheduledTasksList = "scheduledTasks.list"
    case scheduledTasksUpsert = "scheduledTasks.upsert"
    case scheduledTasksSetEnabled = "scheduledTasks.setEnabled"
    case scheduledTasksDelete = "scheduledTasks.delete"
    case scheduledTasksRunNow = "scheduledTasks.runNow"
    case hermesProactiveMarkNotifications = "hermesProactive.markNotifications"
    case subscribeHermesProactiveInbox = "hermesProactive.subscribeInbox"
}

/// One Hermes run that happened without a T3 turn, as
/// `packages/contracts/src/hermesProactive.ts` reports it. `threadId` is absent
/// when the gateway never told T3 which session the job runs in, so a row is
/// not always openable.
public struct HermesProactiveNotification: Decodable, Equatable, Sendable, Identifiable {
    public let notificationId: String
    public let eventId: String
    public let workItemId: String
    public let projectId: String?
    public let threadId: String?
    public let title: String
    public let body: String
    /// `unread`, `read`, or `dismissed`. Kept as the wire string so a status a
    /// future server adds cannot fail the whole list.
    public let status: String
    public let createdAt: String
    public let updatedAt: String

    public var id: String { notificationId }
}

public struct HermesProactiveInboxSnapshot: Decodable, Equatable, Sendable {
    public let notifications: [HermesProactiveNotification]
    public let unreadCount: Int
    /// Notifications the server's delivery outbox gave up on. Reported rather
    /// than hidden, so a broken delivery path does not read as a quiet inbox.
    public let deadLetterCount: Int
}

public struct HermesProactiveMarkResult: Decodable, Equatable, Sendable {
    public let updated: Int
    public let snapshot: HermesProactiveInboxSnapshot
}

/// A persisted automation, as `packages/contracts/src/scheduledTask.ts` reports
/// it. Only the fields a client acts on are modelled; the launch settings it
/// does not edit are kept verbatim as `workspaceStrategy` so an edit round-trips
/// whatever another surface configured.
public struct ScheduledTaskRecord: Decodable, Equatable, Sendable, Identifiable {
    /// `ScheduledTaskSchedule`. The read model still accepts sub-minute legacy
    /// interval rows, so nothing is validated on the way in.
    public enum Schedule: Decodable, Equatable, Sendable {
        case interval(everyMs: Int)
        /// A wall-clock "HH:MM" the server resolves in its own zone. Absent
        /// weekdays mean every day.
        case fixedTime(timeOfDay: String, weekdays: [Int]?)

        private enum CodingKeys: String, CodingKey {
            case type, everyMs, timeOfDay, weekdays
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            switch try container.decode(String.self, forKey: .type) {
            case "interval":
                self = .interval(everyMs: try container.decode(Int.self, forKey: .everyMs))
            case "fixed_time":
                self = .fixedTime(
                    timeOfDay: try container.decode(String.self, forKey: .timeOfDay),
                    weekdays: try container.decodeIfPresent([Int].self, forKey: .weekdays)
                )
            case let type:
                throw DecodingError.dataCorruptedError(
                    forKey: .type,
                    in: container,
                    debugDescription: "Unknown scheduled task schedule type \(type)"
                )
            }
        }

        public var jsonValue: JSONValue {
            switch self {
            case let .interval(everyMs):
                .object([
                    "type": .string("interval"),
                    "everyMs": .number(Double(everyMs)),
                ])
            case let .fixedTime(timeOfDay, weekdays):
                if let weekdays {
                    .object([
                        "type": .string("fixed_time"),
                        "timeOfDay": .string(timeOfDay),
                        "weekdays": .array(weekdays.map { .number(Double($0)) }),
                    ])
                } else {
                    .object([
                        "type": .string("fixed_time"),
                        "timeOfDay": .string(timeOfDay),
                    ])
                }
            }
        }
    }

    public let id: String
    public let title: String
    public let prompt: String
    public let enabled: Bool
    public let schedule: Schedule
    public let projectId: String
    public let threadId: String?
    /// `OrchestrationV2ThreadLaunchWorkspaceStrategy`, held opaquely: only the
    /// server and the web client act on it, and re-deriving it here would mean
    /// re-deriving a contract this client never inspects.
    public let workspaceStrategy: JSONValue
    public let modelSelection: ModelSelection
    public let runtimeMode: String
    public let interactionMode: String
    public let nextRunAt: String?
    public let lastRunAt: String?
    public let lastRunStatus: String
    public let lastRunError: String?
    public let runCount: Int

    private enum CodingKeys: String, CodingKey {
        case id, title, prompt, enabled, schedule, projectId, threadId
        case workspaceStrategy, modelSelection, runtimeMode, interactionMode
        case nextRunAt, lastRunAt, lastRunStatus, lastRunError, runCount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        prompt = try container.decode(String.self, forKey: .prompt)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        schedule = try container.decode(Schedule.self, forKey: .schedule)
        projectId = try container.decode(String.self, forKey: .projectId)
        threadId = try container.decodeIfPresent(String.self, forKey: .threadId)
        workspaceStrategy = try container.decodeIfPresent(
            JSONValue.self, forKey: .workspaceStrategy
        ) ?? .object(["type": .string("root")])
        modelSelection = try container.decode(ModelSelection.self, forKey: .modelSelection)
        runtimeMode = try container.decodeIfPresent(String.self, forKey: .runtimeMode)
            ?? RuntimeMode.fullAccess.rawValue
        interactionMode = try container.decodeIfPresent(String.self, forKey: .interactionMode)
            ?? InteractionMode.default.rawValue
        nextRunAt = try container.decodeIfPresent(String.self, forKey: .nextRunAt)
        lastRunAt = try container.decodeIfPresent(String.self, forKey: .lastRunAt)
        lastRunStatus = try container.decodeIfPresent(String.self, forKey: .lastRunStatus)
            ?? "never"
        lastRunError = try container.decodeIfPresent(String.self, forKey: .lastRunError)
        runCount = try container.decodeIfPresent(Int.self, forKey: .runCount) ?? 0
    }
}

/// The `scheduledTasks.upsert` input. Create when `id` is nil, update otherwise.
public struct ScheduledTaskUpsert: Equatable, Sendable {
    public var id: String?
    public var title: String
    public var prompt: String
    public var enabled: Bool
    public var schedule: ScheduledTaskRecord.Schedule
    public var projectID: String
    public var threadID: String?
    public var workspaceStrategy: JSONValue
    public var modelSelection: ModelSelection
    public var runtimeMode: String
    public var interactionMode: String
    /// Only set on create: the server attributes the automation to the surface
    /// that made it, and re-sending it on an edit would rewrite that history.
    public var creationSource: String?

    public init(
        id: String? = nil,
        title: String,
        prompt: String,
        enabled: Bool,
        schedule: ScheduledTaskRecord.Schedule,
        projectID: String,
        threadID: String? = nil,
        workspaceStrategy: JSONValue,
        modelSelection: ModelSelection,
        runtimeMode: String = RuntimeMode.fullAccess.rawValue,
        interactionMode: String = InteractionMode.default.rawValue,
        creationSource: String? = nil
    ) {
        self.id = id
        self.title = title
        self.prompt = prompt
        self.enabled = enabled
        self.schedule = schedule
        self.projectID = projectID
        self.threadID = threadID
        self.workspaceStrategy = workspaceStrategy
        self.modelSelection = modelSelection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.creationSource = creationSource
    }

    /// `ScheduledTaskUpsertInput`. `threadId` is optional *and* nullable on the
    /// wire; an explicit null is what clears a pinned thread back to "start a
    /// fresh thread per run", so the key is always present.
    public func jsonValue(commandID: String = UUID().uuidString) throws -> JSONValue {
        var input: [String: JSONValue] = [
            "commandId": .string(commandID),
            "title": .string(title),
            "prompt": .string(prompt),
            "enabled": .bool(enabled),
            "schedule": schedule.jsonValue,
            "projectId": .string(projectID),
            "threadId": threadID.map(JSONValue.string) ?? .null,
            "workspaceStrategy": workspaceStrategy,
            "modelSelection": try .encode(modelSelection),
            "runtimeMode": .string(runtimeMode),
            "interactionMode": .string(interactionMode),
        ]
        if let id { input["id"] = .string(id) }
        if let creationSource {
            input["createdBy"] = .string(OrchestrationCommands.createdBy)
            input["creationSource"] = .string(creationSource)
        }
        return .object(input)
    }
}

private struct ScheduledTaskListResult: Decodable, Sendable {
    let tasks: [ScheduledTaskRecord]
}

private struct ScheduledTaskMutationResult: Decodable, Sendable {
    let task: ScheduledTaskRecord
}

/// How a dispatched message should meet an already-running turn.
///
/// The server resolves `start_immediately` to a queued message when a run is
/// active, so it is the safe default for a client that has not looked at the
/// projection. `steerActive`/`restartActive` are rejected unless the named run
/// is genuinely running, so only callers holding a live projection should send
/// them.
public enum MessageDispatchMode: Equatable, Sendable {
    case startImmediately
    case queueAfterActive
    case deferStart
    case steerActive(runID: String)
    case restartActive(runID: String)

    var jsonValue: JSONValue {
        switch self {
        case .startImmediately:
            .object(["type": .string("start_immediately")])
        case .queueAfterActive:
            .object(["type": .string("queue_after_active")])
        case .deferStart:
            .object(["type": .string("defer_start")])
        case let .steerActive(runID):
            .object(["type": .string("steer_active"), "targetRunId": .string(runID)])
        case let .restartActive(runID):
            .object(["type": .string("restart_active"), "targetRunId": .string(runID)])
        }
    }
}

/// `orchestration.launchThread`'s reply. The full result also carries the new
/// thread's projection; this decodes only the identity so a projection the
/// Swift models cannot yet parse never turns an accepted launch into a failure.
public struct ThreadLaunchResult: Decodable, Equatable, Sendable {
    public let threadId: String
    public let resumed: Bool
}

/// `orchestration.generateHandoffScript`'s reply.
public struct HandoffScriptResult: Decodable, Equatable, Sendable {
    public let script: String
    /// False when the summary came from the deterministic fallback rather than
    /// the AI generator. The document is usable either way.
    public let aiGenerated: Bool

    private enum CodingKeys: String, CodingKey {
        case script, aiGenerated
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        script = try container.decode(String.self, forKey: .script)
        aiGenerated = try container.decodeIfPresent(Bool.self, forKey: .aiGenerated) ?? false
    }
}

/// `ThreadTurnDiff` from `packages/contracts/src/checkpointDiff.ts` — the reply
/// shared by `orchestration.getTurnDiff` and `orchestration.getFullThreadDiff`.
///
/// The echoed range is what makes the patch attributable: the caller asked for
/// a checkpoint, the server answers with the turn counts it actually diffed, so
/// a surface can label the diff with the range it really came from rather than
/// with the one it hoped for.
public struct ThreadTurnDiff: Decodable, Equatable, Sendable {
    public let threadId: String
    public let fromTurnCount: Int
    public let toTurnCount: Int
    public let diff: String

    public init(threadId: String, fromTurnCount: Int, toTurnCount: Int, diff: String) {
        self.threadId = threadId
        self.fromTurnCount = fromTurnCount
        self.toTurnCount = toTurnCount
        self.diff = diff
    }
}

/// Builders for this fork's orchestration V2 command union
/// (`packages/contracts/src/orchestrationV2.ts`).
///
/// Every builder is pure so the emitted JSON can be asserted against the
/// contract in tests, and every one takes its `commandId` so a retry after an
/// ambiguous failure is deduplicated by the server's command receipts instead
/// of enqueuing the work twice.
public enum OrchestrationCommands {
    /// `OrchestrationV2CreationSource`. Everything this client originates is a
    /// phone action, and the server defaults the field to `web` when it is
    /// missing, so it is spelled out on every command that accepts it.
    public static let creationSource = "mobile"
    /// `OrchestrationV2Actor`. Commands from this client are user intent.
    public static let createdBy = "user"

    public static func createThread(
        threadID: String = UUID().uuidString,
        projectID: String,
        title: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        branch: String? = nil,
        worktreePath: String? = nil,
        commandID: String = UUID().uuidString,
        createdAt: String = now()
    ) throws -> JSONValue {
        .object([
            "type": .string("thread.create"),
            "commandId": .string(commandID),
            "createdBy": .string(createdBy),
            "creationSource": .string(creationSource),
            "threadId": .string(threadID),
            "projectId": .string(projectID),
            "title": .string(title),
            "modelSelection": try .encode(model),
            "runtimeMode": .string(runtimeMode.rawValue),
            "interactionMode": .string(interactionMode.rawValue),
            "branch": trimmedOrNull(branch),
            "worktreePath": trimmedOrNull(worktreePath),
            "createdAt": .string(createdAt),
        ])
    }

    /// A `ProjectMutation`, not an orchestration command: it is dispatched
    /// through `projects.mutate` and carries no `createdAt`.
    public static func createProject(
        projectID: String = UUID().uuidString,
        title: String,
        workspaceRoot: String,
        defaultModel: ModelSelection? = nil,
        createWorkspaceRootIfMissing: Bool = false,
        commandID: String = UUID().uuidString
    ) throws -> JSONValue {
        var value: [String: JSONValue] = [
            "type": .string("project.create"),
            "commandId": .string(commandID),
            "projectId": .string(projectID),
            "title": .string(title),
            "workspaceRoot": .string(workspaceRoot),
            "createWorkspaceRootIfMissing": .bool(createWorkspaceRootIfMissing),
        ]
        if let defaultModel {
            value["defaultModelSelection"] = try JSONValue.encode(defaultModel)
        } else {
            value["defaultModelSelection"] = .null
        }
        return .object(value)
    }

    /// `message.dispatch`. `attachments` are already-persisted `ChatAttachment`
    /// values; see `T3Client.persistAttachments`.
    public static func sendTurn(
        threadID: String,
        text: String,
        model: ModelSelection? = nil,
        attachments: [JSONValue] = [],
        dispatchMode: MessageDispatchMode = .startImmediately,
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString
    ) throws -> JSONValue {
        var command: [String: JSONValue] = [
            "type": .string("message.dispatch"),
            "commandId": .string(commandID),
            "createdBy": .string(createdBy),
            "creationSource": .string(creationSource),
            "threadId": .string(threadID),
            "messageId": .string(messageID),
            "text": .string(text),
            "attachments": .array(attachments),
            "dispatchMode": dispatchMode.jsonValue,
        ]
        if let model {
            command["modelSelection"] = try .encode(model)
        }
        return .object(command)
    }

    /// Input for `orchestration.launchThread` — deliberately without a `type`,
    /// because this is an RPC payload rather than a member of the command
    /// union. Thread creation, workspace provisioning and the first message are
    /// one server-side operation here.
    public static func createThreadAndSend(
        threadID: String = UUID().uuidString,
        projectID: String,
        title: String,
        text: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        branch: String? = nil,
        worktreePath: String? = nil,
        worktreePreparation: ThreadWorktreePreparation? = nil,
        prepareWorkspace: Bool? = nil,
        attachments: [JSONValue] = [],
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString
    ) throws -> JSONValue {
        var input: [String: JSONValue] = [
            "commandId": .string(commandID),
            "creationSource": .string(creationSource),
            "threadId": .string(threadID),
            "projectId": .string(projectID),
            "title": .string(title),
            "modelSelection": try .encode(model),
            "runtimeMode": .string(runtimeMode.rawValue),
            "interactionMode": .string(interactionMode.rawValue),
            "workspaceStrategy": workspaceStrategy(
                branch: branch,
                worktreePath: worktreePath,
                worktreePreparation: worktreePreparation
            ),
            "initialMessage": .object([
                "messageId": .string(messageID),
                "text": .string(text),
                "attachments": .array(attachments),
            ]),
        ]
        // Only projectless conversation providers opt out; leaving the key off
        // keeps the server's "prepare the workspace" default.
        if let prepareWorkspace {
            input["prepareWorkspace"] = .bool(prepareWorkspace)
        }
        return .object(input)
    }

    /// `OrchestrationV2ThreadLaunchWorkspaceStrategy`. A worktree launch names
    /// only the base ref and the branch to create: the server picks the path,
    /// which is why a draft's `worktreePath` must not travel with it.
    static func workspaceStrategy(
        branch: String?,
        worktreePath: String?,
        worktreePreparation: ThreadWorktreePreparation?
    ) -> JSONValue {
        if let worktreePreparation {
            var strategy: [String: JSONValue] = [
                "type": .string("worktree"),
                "baseRef": .string(worktreePreparation.baseBranch),
            ]
            if let created = trimmed(worktreePreparation.branch) {
                strategy["branch"] = .string(created)
            }
            if worktreePreparation.startFromOrigin {
                strategy["startFromOrigin"] = .bool(true)
            }
            return .object(strategy)
        }
        if let existing = trimmed(worktreePath) {
            var strategy: [String: JSONValue] = [
                "type": .string("existing_worktree"),
                "worktreePath": .string(existing),
            ]
            if let branch = trimmed(branch) { strategy["branch"] = .string(branch) }
            return .object(strategy)
        }
        var strategy: [String: JSONValue] = ["type": .string("root")]
        if let branch = trimmed(branch) { strategy["branch"] = .string(branch) }
        return .object(strategy)
    }

    public static func archive(
        threadID: String,
        archived: Bool,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        basic(
            type: archived ? "thread.archive" : "thread.unarchive",
            threadID: threadID,
            commandID: commandID
        )
    }

    public static func deleteThread(
        threadID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        basic(type: "thread.delete", threadID: threadID, commandID: commandID)
    }

    public static func rename(
        threadID: String,
        title: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        updateMetadata(
            threadID: threadID,
            commandID: commandID,
            fields: ["title": .string(title)]
        )
    }

    /// `thread.metadata.update` carries every optional thread field; absent
    /// keys are left alone, so each caller sends only what it changes.
    public static func updateMetadata(
        threadID: String,
        commandID: String = UUID().uuidString,
        fields: [String: JSONValue]
    ) -> JSONValue {
        var value: [String: JSONValue] = [
            "type": .string("thread.metadata.update"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
        ]
        for (key, field) in fields { value[key] = field }
        return .object(value)
    }

    public static func interrupt(
        threadID: String,
        runID: String,
        reason: String? = nil,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        var value: [String: JSONValue] = [
            "type": .string("run.interrupt"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "runId": .string(runID),
        ]
        if let reason { value["reason"] = .string(reason) }
        return .object(value)
    }

    /// Approvals and user-input answers are the same command in V2: a response
    /// to a runtime request, distinguished by which optional field it carries.
    public static func respondToApproval(
        threadID: String,
        requestID: String,
        decision: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("runtime-request.respond"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "requestId": .string(requestID),
            "decision": .string(decision),
        ])
    }

    public static func respondToUserInput(
        threadID: String,
        requestID: String,
        answers: [String: JSONValue],
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("runtime-request.respond"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "requestId": .string(requestID),
            "answers": .object(answers),
        ])
    }

    public static func settle(
        threadID: String,
        settled: Bool,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        var value = basic(
            type: settled ? "thread.settle" : "thread.unsettle",
            threadID: threadID,
            commandID: commandID
        )
        if !settled, case var .object(object) = value {
            object["reason"] = .string("user")
            value = .object(object)
        }
        return value
    }

    public static func snooze(
        threadID: String,
        until: Date?,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        if let until {
            return .object([
                "type": .string("thread.snooze"),
                "commandId": .string(commandID),
                "threadId": .string(threadID),
                "snoozedUntil": .string(iso8601.string(from: until)),
            ])
        }
        return .object([
            "type": .string("thread.unsnooze"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "reason": .string("user"),
        ])
    }

    /// Title regeneration is a thread metadata field too: `true` starts an async
    /// regeneration, `false` abandons one already running. The new title arrives
    /// on the thread stream rather than in this command's reply.
    public static func regenerateTitle(
        threadID: String,
        regenerate: Bool = true,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        updateMetadata(
            threadID: threadID,
            commandID: commandID,
            fields: ["regenerateTitle": .bool(regenerate)]
        )
    }

    /// `thread.merge_back`. The mirror of `thread.fork`: it folds a fork's work
    /// back into the thread it came from, naming the run to merge at.
    ///
    /// `createdAt` is optional on this command and deliberately omitted, as it
    /// is in `client-runtime`: the server stamps the merge, and a phone's clock
    /// is the least trustworthy one in the system.
    public static func mergeBack(
        sourceThreadID: String,
        targetThreadID: String,
        runID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("thread.merge_back"),
            "commandId": .string(commandID),
            "createdBy": .string(createdBy),
            "creationSource": .string(creationSource),
            "sourceThreadId": .string(sourceThreadID),
            "targetThreadId": .string(targetThreadID),
            "sourcePoint": .object([
                "type": .string("run"),
                "runId": .string(runID),
            ]),
        ])
    }

    /// `provider-session.detach`. Stopping a thread's session is not one
    /// command: each provider session backing the thread is detached
    /// individually, so the caller iterates the projection's sessions.
    public static func detachProviderSession(
        threadID: String,
        providerSessionID: String,
        reason: String? = nil,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        var value: [String: JSONValue] = [
            "type": .string("provider-session.detach"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "providerSessionId": .string(providerSessionID),
        ]
        if let reason = trimmed(reason) { value["reason"] = .string(reason) }
        return .object(value)
    }

    /// Command id for one session's detach inside a single "stop session"
    /// gesture. Deriving it from the gesture's id keeps a retry idempotent while
    /// keeping the per-session commands distinct — sharing one id would make the
    /// server's receipt dedupe swallow every detach after the first.
    public static func detachCommandID(
        commandID: String,
        providerSessionID: String
    ) -> String {
        "\(commandID):detach:\(providerSessionID)"
    }

    /// `queued-run.reorder`. A nil `beforeRunID` moves the run to the end of the
    /// queue, which is why the key is always present rather than omitted.
    public static func reorderQueuedRun(
        threadID: String,
        runID: String,
        beforeRunID: String?,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("queued-run.reorder"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "runId": .string(runID),
            "beforeRunId": beforeRunID.map(JSONValue.string) ?? .null,
        ])
    }

    /// `queued-message.promote-to-steer`. Turns a message waiting behind the
    /// active run into a steer of that run.
    public static func promoteQueuedRun(
        threadID: String,
        queuedRunID: String,
        targetRunID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("queued-message.promote-to-steer"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "queuedRunId": .string(queuedRunID),
            "targetRunId": .string(targetRunID),
        ])
    }

    /// `checkpoint.rollback`. Both identifiers travel: a checkpoint id is only
    /// unique inside its scope, and the server resolves the rollback target
    /// against the pair.
    public static func checkpointRollback(
        threadID: String,
        scopeID: String,
        checkpointID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("checkpoint.rollback"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "scopeId": .string(scopeID),
            "checkpointId": .string(checkpointID),
        ])
    }

    public static func cancelQueuedRun(
        threadID: String,
        runID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("queued-run.cancel"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "runId": .string(runID),
        ])
    }

    /// `queued-run.edit`. `text` is a plain string on the wire, not a trimmed
    /// non-empty one, so an emptied draft is the caller's call to reject.
    public static func editQueuedRun(
        threadID: String,
        runID: String,
        text: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("queued-run.edit"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "runId": .string(runID),
            "text": .string(text),
        ])
    }

    /// Pinning is a thread metadata field, not a command of its own.
    public static func pin(
        threadID: String,
        pinned: Bool,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        updateMetadata(
            threadID: threadID,
            commandID: commandID,
            fields: ["pinned": .bool(pinned)]
        )
    }

    /// The Work-inbox role is a thread metadata field too. `"chat"` marks a
    /// Hermes conversation as belonging to the Chat surface; nil clears the
    /// role back to an ordinary thread.
    public static func setWorkInboxRole(
        threadID: String,
        role: String?,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        updateMetadata(
            threadID: threadID,
            commandID: commandID,
            fields: ["workInboxRole": role.map(JSONValue.string) ?? .null]
        )
    }

    public static func setRuntimeMode(
        threadID: String,
        mode: RuntimeMode,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("thread.runtime-mode.set"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "runtimeMode": .string(mode.rawValue),
        ])
    }

    public static func setInteractionMode(
        threadID: String,
        mode: InteractionMode,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("thread.interaction-mode.set"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "interactionMode": .string(mode.rawValue),
        ])
    }

    private static func basic(type: String, threadID: String, commandID: String) -> JSONValue {
        .object([
            "type": .string(type),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
        ])
    }

    /// The contract's nullable string fields are `TrimmedNonEmptyString | null`,
    /// so a blank value has to travel as `null` rather than `""`.
    private static func trimmedOrNull(_ value: String?) -> JSONValue {
        trimmed(value).map(JSONValue.string) ?? .null
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value else { return nil }
        let compact = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return compact.isEmpty ? nil : compact
    }

    public static func now() -> String {
        iso8601.string(from: Date())
    }

    /// ISO8601DateFormatter is expensive to construct and thread-safe to use;
    /// `now()` runs as the default argument of nearly every outbound command.
    static let iso8601 = ISO8601DateFormatter()
}
