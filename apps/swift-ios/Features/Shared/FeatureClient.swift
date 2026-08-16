import Foundation

/// The app-owned adapter between the native feature layer and T3's WebSocket/Core runtime.
/// Implementations are main-actor isolated so UI state never depends on locking.
@MainActor
public protocol FeatureClient: AnyObject {
    func initialSnapshot() async throws -> FeatureSnapshot
    func events() -> AsyncStream<FeatureEvent>

    func pair(endpoint: String, token: String?) async throws
    func activateEnvironment(id: String) async throws
    func removeEnvironment(id: String) async throws
    func disconnect() async

    func addProject(path: String) async throws
    func createThread(projectID: String, title: String?, selection: FeatureSelection?) async throws -> FeatureThread
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread
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
    ) async throws -> FeatureThread
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
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws -> FeatureThread
    func listWorkspaceBranches(
        projectID: String,
        refresh: Bool
    ) async throws -> [FeatureWorkspaceBranch]
    func renameThread(id: String, title: String) async throws
    /// Asks the server to generate a fresh title. The result arrives through the
    /// thread stream, not this call, so it returns as soon as it is accepted.
    func regenerateThreadTitle(id: String) async throws
    func setThreadArchived(id: String, archived: Bool) async throws
    func setThreadSettled(id: String, settled: Bool) async throws
    func setThreadSnoozed(id: String, until: Date?) async throws
    func setThreadPinned(id: String, pinned: Bool) async throws
    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws
    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws
    /// Persists the model and its options (effort, context window) on the
    /// thread, so the choice follows the thread across devices rather than
    /// living in one device's composer.
    func setModelSelection(id: String, selection: FeatureSelection) async throws
    func deleteThread(id: String) async throws

    func loadThread(id: String) async throws -> FeatureThreadDetail
    func loadEarlierThreadTurns(id: String) async throws -> FeatureThreadDetail?
    func releaseThread(id: String)
    func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async throws
    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws
    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws
    func cancelTurn(threadID: String) async throws
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws
    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws

    /// A prompt-ready document for continuing this thread somewhere else.
    /// Generated server side, so it can take a moment and can come back either
    /// AI-written or from the deterministic fallback.
    func generateHandoffScript(threadID: String) async throws -> String
    /// Folds a fork's work back into the thread it came from, at `runID`.
    func mergeThreadBack(
        sourceThreadID: String,
        targetThreadID: String,
        runID: String
    ) async throws
    /// Detaches every provider session backing the thread, ending the agent
    /// processes without touching the thread's history.
    func stopThreadSession(threadID: String) async throws
    /// Restores the thread's workspace to a checkpoint captured earlier in its
    /// history. `scopeID` and `checkpointID` come from the checkpoint row the
    /// activity inspector resolved; both are required, because a checkpoint id
    /// is only unique inside its scope.
    func rollBackToCheckpoint(
        threadID: String,
        scopeID: String,
        checkpointID: String
    ) async throws

    /// One entry per environment whose server config this client has seen, in
    /// the order the environments are listed.
    ///
    /// Exists because `FeatureSnapshot` carries provider catalogues but not
    /// `t3WorkDirectory`, and without that a T3 Work launch cannot tell its
    /// backing project apart from any other project on the server.
    func workspaceServerConfigs() -> [MobileWorkspaceEnvironmentConfig]

    /// Moves a queued run before `beforeRunID`, or to the end when it is nil.
    func reorderQueuedRun(threadID: String, runID: String, beforeRunID: String?) async throws
    /// Turns a queued message into a steer of the run that is already going.
    func promoteQueuedRun(threadID: String, queuedRunID: String, targetRunID: String) async throws
    func cancelQueuedRun(threadID: String, runID: String) async throws
    func editQueuedRun(threadID: String, runID: String, text: String) async throws

    func saveSettings(_ settings: FeatureSettings) async throws

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry]
    func searchProjectFiles(
        projectID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry]
    func searchThreadFiles(
        threadID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry]
    func readFile(threadID: String, path: String) async throws -> FeatureFileContent
    /// The thread's working tree as it stands now.
    func loadReview(threadID: String) async throws -> FeatureReview
    /// The diff one checkpoint captured, which is a different question from
    /// ``loadReview(threadID:)`` and is answered by a different server call.
    ///
    /// Separate rather than an optional argument on the working-tree call so
    /// that an environment which cannot answer it fails loudly. Handing back
    /// the working tree for a checkpoint would render as if it had worked while
    /// showing changes the checkpoint never captured.
    func loadReview(threadID: String, checkpointID: String) async throws -> FeatureReview
    func loadReviewFileContents(
        threadID: String,
        file: FeatureReviewFile
    ) async throws -> FeatureReviewFileContents?

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus
    /// Streams the change request matching each thread's branch, keyed by
    /// thread id, for the threads a list is currently showing. Rows label
    /// themselves with the PR rather than a generated branch name, and the
    /// server holds one cached status per workspace, so the caller scopes this
    /// to what is on screen instead of every thread it knows about.
    ///
    /// `seed` is what the caller already knows for these threads. A restarted
    /// stream starts from it rather than from nothing, so its early emissions
    /// never claim less than the previous stream had established — a merged PR
    /// parks its row on the Settled shelf, and forgetting it mid-restart
    /// bounced the row back to Active until the fresh snapshot arrived.
    func threadChangeRequests(
        threadIDs: [String],
        seed: [String: FeaturePullRequest]
    ) -> AsyncStream<[String: FeaturePullRequest]>
    /// The host-backed detail (and, where readable, the conversation) for the
    /// change request `number` on the repository this thread's project tracks.
    /// Only offered where the environment reports the `pullRequests` capability.
    func pullRequestOverview(threadID: String, number: Int) async throws
        -> FeaturePullRequestOverview
    func performSourceControlAction(
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus

    func terminalSnapshot(threadID: String, terminalID: String) async throws -> FeatureTerminalSnapshot
    func terminalEvents(threadID: String, terminalID: String) -> AsyncStream<FeatureTerminalSnapshot>
    func terminalSessions(threadID: String) -> AsyncStream<[FeatureTerminalSnapshot]>
    func openTerminal(threadID: String, terminalID: String, columns: Int, rows: Int) async throws
    func writeTerminal(threadID: String, terminalID: String, data: String) async throws
    func resizeTerminal(
        threadID: String,
        terminalID: String,
        columns: Int,
        rows: Int
    ) async throws
    func clearTerminal(threadID: String, terminalID: String) async throws
    func closeTerminal(threadID: String, terminalID: String) async throws
}

public extension FeatureClient {
    func loadEarlierThreadTurns(id _: String) async throws -> FeatureThreadDetail? {
        nil
    }
}

public extension FeatureClient {
    func events() -> AsyncStream<FeatureEvent> {
        AsyncStream { continuation in continuation.finish() }
    }

    func activateEnvironment(id: String) async throws {}
    func removeEnvironment(id: String) async throws {}
    func disconnect() async {}
    func addProject(path: String) async throws {}
    func releaseThread(id: String) {}
    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws {}

    /// Keeps simple text-only callers source-compatible while the typed API
    /// preserves multi-select answers as arrays.
    func resolveUserInput(id: String, answers: [String: String]) async throws {
        try await resolveUserInput(
            id: id,
            answers: answers.mapValues(FeatureInputAnswer.text)
        )
    }
    func setThreadSettled(id: String, settled: Bool) async throws {}
    func setThreadSnoozed(id: String, until: Date?) async throws {}
    func setThreadPinned(id: String, pinned: Bool) async throws {}
    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws {}
    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws {}
    func setModelSelection(id: String, selection: FeatureSelection) async throws {}

    func generateHandoffScript(threadID: String) async throws -> String {
        throw FeatureCapabilityUnavailable("Handoff script")
    }

    func regenerateThreadTitle(id: String) async throws {
        throw FeatureCapabilityUnavailable("Title regeneration")
    }

    func mergeThreadBack(
        sourceThreadID: String,
        targetThreadID: String,
        runID: String
    ) async throws {
        throw FeatureCapabilityUnavailable("Merge back")
    }

    func stopThreadSession(threadID: String) async throws {
        throw FeatureCapabilityUnavailable("Stop session")
    }

    func rollBackToCheckpoint(
        threadID: String,
        scopeID: String,
        checkpointID: String
    ) async throws {
        throw FeatureCapabilityUnavailable("Checkpoint rollback")
    }

    /// No server config, so no Work checkout: T3 Work reports itself
    /// unavailable rather than attaching a conversation to an arbitrary project.
    func workspaceServerConfigs() -> [MobileWorkspaceEnvironmentConfig] {
        []
    }

    func reorderQueuedRun(
        threadID: String,
        runID: String,
        beforeRunID: String?
    ) async throws {
        throw FeatureCapabilityUnavailable("Queue reordering")
    }

    func promoteQueuedRun(
        threadID: String,
        queuedRunID: String,
        targetRunID: String
    ) async throws {
        throw FeatureCapabilityUnavailable("Queue promotion")
    }

    func cancelQueuedRun(threadID: String, runID: String) async throws {
        throw FeatureCapabilityUnavailable("Queue cancellation")
    }

    func editQueuedRun(threadID: String, runID: String, text: String) async throws {
        throw FeatureCapabilityUnavailable("Queued message editing")
    }

    func loadReviewFileContents(
        threadID: String,
        file: FeatureReviewFile
    ) async throws -> FeatureReviewFileContents? {
        nil
    }

    func listWorkspaceBranches(
        projectID: String,
        refresh: Bool
    ) async throws -> [FeatureWorkspaceBranch] {
        []
    }

    /// Legacy clients still create in the current checkout. Native clients
    /// override this overload to prepare worktrees atomically with the first turn.
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
        try await createThreadAndSend(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            attachments: attachments
        )
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        let thread = try await createThread(
            projectID: projectID,
            title: prompt,
            selection: selection
        )
        try await sendMessage(
            threadID: thread.id,
            text: prompt,
            selection: selection,
            attachments: attachments
        )
        return thread
    }

    /// Clients that understand stable command identities override this method.
    /// The compatibility path remains functional but cannot guarantee
    /// idempotence across a process death after an ambiguous network failure.
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
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws -> FeatureThread {
        try await createThreadAndSend(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            workspaceMode: workspaceMode,
            branch: branch,
            worktreePath: worktreePath,
            startFromOrigin: startFromOrigin,
            attachments: attachments
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws {
        guard attachments.isEmpty else {
            throw FeatureCapabilityUnavailable("Image attachments")
        }
        try await sendMessage(threadID: threadID, text: text, selection: selection)
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment],
        identity: FeatureSubmissionIdentity
    ) async throws {
        try await sendMessage(
            threadID: threadID,
            text: text,
            selection: selection,
            attachments: attachments
        )
    }

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry] {
        throw FeatureCapabilityUnavailable("Files")
    }

    func searchProjectFiles(
        projectID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        throw FeatureCapabilityUnavailable("File search")
    }

    func searchThreadFiles(
        threadID: String,
        query: String,
        limit: Int
    ) async throws -> [FeatureFileEntry] {
        throw FeatureCapabilityUnavailable("File search")
    }

    func readFile(threadID: String, path: String) async throws -> FeatureFileContent {
        throw FeatureCapabilityUnavailable("File preview")
    }

    func loadReview(threadID: String) async throws -> FeatureReview {
        throw FeatureCapabilityUnavailable("Review")
    }

    func loadReview(threadID: String, checkpointID: String) async throws -> FeatureReview {
        throw FeatureCapabilityUnavailable("Checkpoint diff")
    }

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus {
        throw FeatureCapabilityUnavailable("Source control")
    }

    func threadChangeRequests(
        threadIDs _: [String],
        seed _: [String: FeaturePullRequest]
    ) -> AsyncStream<[String: FeaturePullRequest]> {
        AsyncStream { $0.finish() }
    }

    func pullRequestOverview(threadID _: String, number _: Int) async throws
        -> FeaturePullRequestOverview
    {
        throw FeatureCapabilityUnavailable("Pull requests")
    }

    func performSourceControlAction(
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus {
        throw FeatureCapabilityUnavailable("Source control actions")
    }

    func terminalSnapshot(threadID: String, terminalID _: String) async throws -> FeatureTerminalSnapshot {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func terminalEvents(threadID: String, terminalID _: String) -> AsyncStream<FeatureTerminalSnapshot> {
        AsyncStream { $0.finish() }
    }

    func terminalSessions(threadID _: String) -> AsyncStream<[FeatureTerminalSnapshot]> {
        AsyncStream { $0.finish() }
    }

    func openTerminal(
        threadID: String,
        terminalID _: String,
        columns: Int,
        rows: Int
    ) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func writeTerminal(threadID: String, terminalID _: String, data: String) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func resizeTerminal(
        threadID: String,
        terminalID _: String,
        columns: Int,
        rows: Int
    ) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func clearTerminal(threadID: String, terminalID _: String) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func closeTerminal(threadID: String, terminalID _: String) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }
}
