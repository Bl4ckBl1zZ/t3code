import Foundation
import Observation

enum FeatureDetailRenderChange: Equatable {
    case full
    case delta(FeatureDetailDelta)
}

struct FeatureDetailRenderUpdate: Equatable {
    let baseRevision: UInt64
    let revision: UInt64
    let change: FeatureDetailRenderChange
}

/// Where a submission in this device's outbox stands.
public enum FeatureOutboxDelivery: Equatable, Sendable {
    /// Held until its environment is reachable.
    case waiting
    case sending
    /// Refused; stays until the reader retries it.
    case failed
}

@MainActor
@Observable
public final class FeatureRootModel {
    var pendingThreadFileDrops: [String: ThreadFileDropBatch] = [:]

    var pendingPullRequestPrompts: [String: PendingPullRequestPrompt] = [:]

    func stagePullRequestTask(scope: FeaturePullRequestScope, overview: FeaturePullRequestOverview, kind: PullRequestHandoffKind, mode: PullRequestCheckoutMode, selection: PullRequestHandoffSelection? = nil) async throws -> String {
        let prepared: FeaturePullRequestPreparedThread
        if case let .thread(id) = scope, kind != .checkout {
            guard let thread = snapshot.threads.first(where: { $0.id == id }) else { throw FeatureCapabilityUnavailable("The thread is no longer available. Reopen the pull request from its project") }
            prepared = FeaturePullRequestPreparedThread(thread: thread, staleCheckout: false)
        } else {
            guard let preparer = client as? any FeaturePullRequestThreadPreparing else {
                throw FeatureCapabilityUnavailable("Pull request thread preparation")
            }
            prepared = try await preparer.preparePullRequestAgentThread(scope: scope, number: overview.detail.number, expectedURL: overview.detail.url, title: "PR #\(overview.detail.number): \(overview.detail.title)", mode: kind.needsCheckout ? mode : nil)
            upsert(prepared.thread)
        }
        let prompt = PullRequestHandoffPrompt.build(kind: kind, detail: overview.detail, activity: overview.activity, selection: selection)
        pendingPullRequestPrompts[prepared.thread.id] = PendingPullRequestPrompt(text: prompt, warning: prepared.staleCheckout ? "This checkout is not on the pull request's latest commits. Local changes or commits may have prevented it from moving. Review the branch before sending." : nil)
        return prepared.thread.id
    }

    var pendingAssistantCitation: AssistantCitationNavigationRequest?

    public private(set) var snapshot = FeatureSnapshot()
    public private(set) var details: [String: FeatureThreadDetail] = [:]
    /// Advances whenever a Home presentation input changes.
    public private(set) var homePresentationRevision: UInt64 = 0
    /// Advances when a Home-visible thread is inserted, removed, or changed.
    public private(set) var threadCollectionRevision: UInt64 = 0
    /// Advances for any selected-thread metadata, message, approval, or input change.
    public private(set) var detailRevision: UInt64 = 0
    /// The latest detail revision for each loaded thread.
    public private(set) var detailRevisions: [String: UInt64] = [:]
    private(set) var detailRenderUpdates: [String: FeatureDetailRenderUpdate] = [:]
    /// The change request behind each listed thread's branch, keyed by thread
    /// id. Only threads passed to `observeChangeRequests` appear here.
    public private(set) var changeRequestsByThreadID: [String: FeaturePullRequest] = [:]
    public private(set) var isLoading = true
    public private(set) var isPerformingAction = false
    public private(set) var isManagingConnections = false
    /// The failure the root alert shows. Setting it clears `errorTitle`, so a
    /// caller that names what failed sets the message first, then the title.
    public var errorMessage: String? {
        didSet { errorTitle = nil }
    }
    /// What failed, as the alert's title ("Couldn't Archive Thread"). Nil
    /// falls back to a generic title.
    public private(set) var errorTitle: String?
    /// What each thread's review is pointed at. Lives here rather than in the
    /// review screen because the thread feed arms it and the review — presented
    /// later, from a sheet that does not exist yet — spends it.
    public let reviewSelection = ReviewSelectionStore()
    /// The Undo notice for archive, settle, snooze and unpin. Every entry
    /// point goes through the setters below, so each one gets it.
    let threadUndo = ThreadUndoCenter()

    let client: any FeatureClient
    private let outboxStore: FeatureOutboxStore
    public var outboxCount: Int { pendingSubmissionsByID.count }
    public var outboxSubmissions: [FeatureQueuedSubmission] { pendingSubmissionsByID.values.sorted { $0.identity.createdAt < $1.identity.createdAt } }
    private var failedOutboxIDs: Set<String> = []
    private var sendingOutboxIDs: Set<String> = []

    public func outboxStatus(_ submission: FeatureQueuedSubmission) -> String {
        if failedOutboxIDs.contains(submission.id) { return "Send failed · Retry" }
        if sendingOutboxIDs.contains(submission.id) { return submission.attachments.isEmpty ? "Sending" : "Uploading and sending" }
        return "Queued"
    }

    /// The same three states as `outboxStatus`, typed for surfaces that
    /// caption a queued message rather than print a status line.
    public func outboxDelivery(_ submission: FeatureQueuedSubmission) -> FeatureOutboxDelivery {
        if failedOutboxIDs.contains(submission.id) { return .failed }
        if sendingOutboxIDs.contains(submission.id) { return .sending }
        return .waiting
    }

    public func retryOutbox() { failedOutboxIDs.removeAll(); scheduleOutboxDrain() }
    public func cancelOutbox(_ id: String) async {
        guard !sendingOutboxIDs.contains(id), let submission = pendingSubmissionsByID[id] else { return }
        _ = await discardQueuedSubmission(submission)
        failedOutboxIDs.remove(id)
    }
    private var pendingSubmissionsByID: [String: FeatureQueuedSubmission] = [:]
    private var pendingThreadsByID: [String: FeatureThread] = [:]
    private var pendingCompletionSubmissionIDs: Set<String> = []
    private var pendingDiscardSubmissionIDs: Set<String> = []
    private var outboxDrainTask: Task<Void, Never>?
    private var outboxRetryAttempt = 0
    private var outboxGeneration: UInt64 = 0
    private var changeRequestThreadIDs: [String] = []
    private var changeRequestLinks: [String: [FeatureLinkedPullRequest]] = [:]
    private var changeRequestTask: Task<Void, Never>?

    public init(
        client: any FeatureClient,
        outboxStore: FeatureOutboxStore = .shared
    ) {
        self.client = client
        self.outboxStore = outboxStore
    }

    public func start() async {
        do {
            install(try await client.initialSnapshot())
        } catch {
            if !Self.isBenignCancellation(error) {
                reportFailure(error.localizedDescription, title: "Couldn't Load Your Servers")
            }
        }
        await restoreOutbox()
        isLoading = false
        scheduleOutboxDrain()

        for await event in client.events() {
            apply(event)
        }
    }

    /// Points the change-request subscriptions at the threads a list is
    /// showing. Safe to call whenever that list is rebuilt: an unchanged set of
    /// threads keeps the existing subscriptions rather than restarting them.
    public func observeChangeRequests(threadIDs: [String]) {
        let observed = Set(threadIDs)
        let links = Dictionary(uniqueKeysWithValues: snapshot.threads.filter { observed.contains($0.id) }.map { ($0.id, $0.observedPullRequests) })
        guard threadIDs != changeRequestThreadIDs || links != changeRequestLinks else { return }
        let previousLinks = changeRequestLinks
        changeRequestLinks = links
        changeRequestThreadIDs = threadIDs
        changeRequestTask?.cancel()

        changeRequestsByThreadID = changeRequestsByThreadID.filter { observed.contains($0.key) && previousLinks[$0.key] == links[$0.key] }
        guard !threadIDs.isEmpty else {
            changeRequestTask = nil
            return
        }
        // The retained entries seed the new stream so its first emissions carry
        // everything already known; without that, each restart transiently
        // reported nothing, a settled-by-merged-PR row bounced back to Active,
        // the list reordered, and the reorder restarted the stream again — an
        // endless resubscribe loop that shuffled rows between shelves.
        changeRequestTask = Task { @MainActor [weak self, changeRequestsByThreadID] in
            guard let self else { return }
            for await pullRequests in client.threadChangeRequests(
                threadIDs: threadIDs,
                seed: changeRequestsByThreadID
            ) {
                // A cancelled stream can still hold one last emission; applying
                // it would overwrite the replacement stream's fresher state.
                if Task.isCancelled || self.changeRequestThreadIDs != threadIDs || self.changeRequestLinks != links { return }
                self.changeRequestsByThreadID = pullRequests
            }
        }
    }

    public func reload(reason: String = "unspecified") async {
        ConnectionLog.logger.info("[conn] reload reason=\(reason, privacy: .public)")
        do {
            install(try await client.initialSnapshot())
        } catch {
            if !Self.isBenignCancellation(error) {
                reportFailure(error.localizedDescription, title: "Couldn't Refresh")
            }
        }
    }

    public func reloadAfterConnection() async {
        clearDetails()
        await reload(reason: "after-connection")
    }

    public func pair(endpoint: String, token: String?) async -> Bool {
        await perform {
            try await client.pair(endpoint: endpoint, token: token)
            clearDetails()
            install(try await client.initialSnapshot())
        }
    }

    @discardableResult
    public func activateEnvironment(_ id: String) async -> Bool {
        await perform {
            try await client.activateEnvironment(id: id)
            install(try await client.initialSnapshot())
            clearDetails()
        }
    }

    public func removeEnvironment(_ id: String) async {
        await stopOutboxDrain()
        await perform {
            try await client.removeEnvironment(id: id)
            do {
                try await outboxStore.removeAll(environmentID: id)
                removePendingSubmissions(environmentID: id)
            } catch {
                markPendingSubmissionsForDiscard(environmentID: id)
                reportFailure(
                    "Environment removed, but its queued messages could not be cleared: \(error.localizedDescription)",
                    title: "Couldn't Clear Queued Messages"
                )
            }
            install(try await client.initialSnapshot())
            clearDetails()
        }
        scheduleOutboxDrain()
    }

    public func disconnect() async {
        await stopOutboxDrain()
        isManagingConnections = false
        await client.disconnect()
        let disconnectedEnvironments = snapshot.environments.map { environment in
            var environment = environment
            environment.connectionState = .disconnected
            environment.connectionDetail = nil
            return environment
        }
        install(FeatureSnapshot(
            environments: disconnectedEnvironments,
            settings: snapshot.settings
        ))
        clearDetails()
    }

    public func setConnectionManagementPresented(_ isPresented: Bool) {
        isManagingConnections = isPresented
    }

    public func addProject(path: String) async -> Bool {
        await perform(failureTitle: "Couldn't Add Project") {
            try await client.addProject(path: path)
            install(try await client.initialSnapshot())
        }
    }

    public func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async -> FeatureThread? {
        let environment = currentEnvironmentIdentity
        var created: FeatureThread?
        let succeeded = await perform(failureTitle: "Couldn't Create Thread") {
            let thread = try await client.createThread(
                projectID: projectID,
                title: title,
                selection: selection
            )
            guard currentEnvironmentIdentity == environment else {
                throw CancellationError()
            }
            upsert(thread)
            created = thread
        }
        return succeeded ? created : nil
    }

    public func startTask(_ request: NewTaskRequest) async -> FeatureThread? {
        let prompt = request.trimmedPrompt
        guard !prompt.isEmpty || !request.attachments.isEmpty else { return nil }
        guard request.workspaceMode != .worktree || request.branch != nil else { return nil }

        guard let project = snapshot.projects.first(where: { $0.id == request.projectID }) else {
            reportFailure("That project is no longer available.", title: "Couldn't Start Task")
            return nil
        }
        let identity = FeatureSubmissionIdentity()
        let threadID = FeatureScopedID.thread(
            environmentID: project.environmentID,
            wireID: identity.threadID
        )
        let uploads = request.attachments.map(\.upload)
        let queued = FeatureQueuedSubmission(
            environmentID: project.environmentID,
            identity: identity,
            threadID: threadID,
            text: prompt,
            selection: request.selection,
            runtimeMode: request.runtimeMode,
            interactionMode: request.interactionMode,
            attachments: uploads,
            creation: FeatureQueuedCreation(
                projectID: request.projectID,
                projectName: project.name,
                workspaceMode: request.workspaceMode,
                branch: request.branch,
                worktreePath: request.worktreePath,
                startFromOrigin: request.startFromOrigin
            )
        )
        guard await enqueue(queued) else { return nil }
        installPendingCreation(queued, project: project)

        // The durable enqueue is the submission boundary. Delivery continues in
        // the outbox while the user enters the optimistic thread immediately.
        scheduleOutboxDrain()
        return pendingThreadsByID[threadID]
    }

    public func workspaceBranches(
        projectID: String,
        refresh: Bool = false
    ) async throws -> [FeatureWorkspaceBranch] {
        try await client.listWorkspaceBranches(projectID: projectID, refresh: refresh)
    }

    public func renameThread(_ id: String, title: String) async {
        let environment = currentEnvironmentIdentity
        await perform(failureTitle: "Couldn't Rename Thread") {
            try await client.renameThread(id: id, title: title)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.title = title }
        }
    }

    @discardableResult
    public func setArchived(_ id: String, archived: Bool) async -> Bool {
        let environment = currentEnvironmentIdentity
        let claim = archived ? threadUndo.begin(.archive, threadID: id) : nil
        if !archived { threadUndo.invalidate(.archive, threadID: id) }
        let succeeded = await perform(failureTitle: archived ? "Couldn't Archive Thread" : "Couldn't Restore Thread") {
            try await client.setThreadArchived(id: id, archived: archived)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.isArchived = archived }
        }
        offerUndo(claim, succeeded: succeeded, action: .archived) { model in
            await model.setArchived(id, archived: false)
        }
        return succeeded
    }

    /// A settle clears the pin but keeps its slot and any snooze, so undoing
    /// it reopens the thread and re-pins it in place; it never re-snoozes.
    @discardableResult
    public func setSettled(_ id: String, settled: Bool) async -> Bool {
        let environment = currentEnvironmentIdentity
        let pin = pinnedSlot(id)
        let claim: ThreadUndoCenter.Claim?
        if settled {
            // A pending unpin or snooze undo would re-pin a settled thread,
            // which the server refuses.
            threadUndo.invalidate(.pin, threadID: id)
            threadUndo.invalidate(.snooze, threadID: id)
            claim = threadUndo.begin(.settle, threadID: id)
        } else {
            threadUndo.invalidate(.settle, threadID: id)
            claim = nil
        }
        let succeeded = await perform(failureTitle: settled ? "Couldn't Settle Thread" : "Couldn't Reopen Thread") {
            try await client.setThreadSettled(id: id, settled: settled)
            guard currentEnvironmentIdentity == environment else { return }
            let now = Date.now
            mutateThread(id: id) {
                // Mirror the server's re-entry stamp so a reopened row hoists
                // on the tap instead of waiting for the shell stream to land.
                // A thread already pinned active keeps its stamp: reopening it
                // again is not a fresh re-entry and must not reorder the list.
                // Read before `keepsActive` is overwritten below.
                let wasPinnedActive = $0.keepsActive
                $0.isSettled = settled
                $0.keepsActive = !settled
                $0.settledAt = settled ? now : nil
                $0.unsettledAt = settled ? nil : (wasPinnedActive ? $0.unsettledAt : now)
                if settled {
                    $0.pinnedAt = nil
                }
            }
        }
        offerUndo(claim, succeeded: succeeded, action: .settled) { model in
            guard await model.setSettled(id, settled: false), let pin else { return }
            await model.setPinned(id, pinned: true, orderKey: pin.orderKey)
        }
        return succeeded
    }

    /// A snooze clears the pin too, so undoing it wakes the thread and
    /// re-pins it in place.
    @discardableResult
    public func setSnoozed(_ id: String, until: Date?) async -> Bool {
        let environment = currentEnvironmentIdentity
        let pin = pinnedSlot(id)
        let claim: ThreadUndoCenter.Claim?
        if until != nil {
            // The server refuses to pin a snoozed thread.
            threadUndo.invalidate(.pin, threadID: id)
            claim = threadUndo.begin(.snooze, threadID: id)
        } else {
            threadUndo.invalidate(.snooze, threadID: id)
            claim = nil
        }
        let succeeded = await perform(failureTitle: until == nil ? "Couldn't Unsnooze Thread" : "Couldn't Snooze Thread") {
            try await client.setThreadSnoozed(id: id, until: until)
            guard currentEnvironmentIdentity == environment else { return }
            let snoozedAt = until.map { _ in Date.now }
            mutateThread(id: id) {
                $0.snoozedUntil = until
                $0.snoozedAt = snoozedAt
            }
        }
        offerUndo(claim, succeeded: succeeded, action: .snoozed) { model in
            guard await model.setSnoozed(id, until: nil), let pin else { return }
            await model.setPinned(id, pinned: true, orderKey: pin.orderKey)
        }
        return succeeded
    }

    /// A per-thread setting, not a lifecycle move, so it offers no Undo: the
    /// same menu flips it back. Re-sending the current choice keeps the stamp.
    @discardableResult
    public func setAutoSettle(_ id: String, enabled: Bool) async -> Bool {
        let environment = currentEnvironmentIdentity
        return await perform(failureTitle: "Couldn't Update Auto-Settle") {
            try await client.setThreadAutoSettle(id: id, enabled: enabled)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) {
                $0.autoSettleDisabledAt = enabled ? nil : ($0.autoSettleDisabledAt ?? .now)
            }
        }
    }

    /// `orderKey` re-pins at a known slot; undoing an unpin passes the one the
    /// thread held.
    @discardableResult
    public func setPinned(_ id: String, pinned: Bool, orderKey: String? = nil) async -> Bool {
        let environment = currentEnvironmentIdentity
        let previousOrderKey = pinned ? nil : snapshot.threads.first(where: { $0.id == id })?.pinOrderKey
        let claim = pinned ? nil : threadUndo.begin(.pin, threadID: id)
        if pinned { threadUndo.invalidate(.pin, threadID: id) }
        let succeeded = await perform(failureTitle: pinned ? "Couldn't Pin Thread" : "Couldn't Unpin Thread") {
            try await client.setThreadPinned(id: id, pinned: pinned, orderKey: orderKey)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) {
                $0.pinnedAt = pinned ? Date.now : nil
                if pinned {
                    $0.snoozedUntil = nil
                    $0.snoozedAt = nil
                    if let orderKey { $0.pinOrderKey = orderKey }
                } else {
                    $0.pinOrderKey = nil
                }
            }
        }
        offerUndo(claim, succeeded: succeeded, action: .unpinned) { model in
            await model.setPinned(id, pinned: true, orderKey: previousOrderKey)
        }
        return succeeded
    }

    private struct PinnedSlot {
        let orderKey: String?
    }

    /// The pin a settle or snooze is about to clear, so its undo can restore it.
    private func pinnedSlot(_ id: String) -> PinnedSlot? {
        guard let thread = snapshot.threads.first(where: { $0.id == id }), thread.pinnedAt != nil else { return nil }
        return PinnedSlot(orderKey: thread.pinOrderKey)
    }

    /// Shows the Undo notice once a claimed action lands, or releases the
    /// claim when it failed.
    private func offerUndo(
        _ claim: ThreadUndoCenter.Claim?,
        succeeded: Bool,
        action: ThreadUndoCenter.Action,
        undo: @escaping @MainActor (FeatureRootModel) async -> Void
    ) {
        guard let claim else { return }
        guard succeeded else {
            threadUndo.finish(claim)
            return
        }
        threadUndo.offer(claim, action: action) { [weak self] in
            guard let self else { return }
            await undo(self)
        }
    }

    public func setActiveOrder(_ id: String, key: String?) async -> Bool {
        let environment = currentEnvironmentIdentity
        return await perform(failureTitle: "Couldn't Reorder Threads") {
            try await client.setActiveOrder(id: id, key: key)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.activeOrderKey = key }
        }
    }

    public func setRuntimeMode(_ id: String, mode: FeatureRuntimeMode) async {
        let mode = mode.mobileNormalized
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setRuntimeMode(id: id, mode: mode)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.runtimeMode = mode }
        }
    }

    public func setInteractionMode(_ id: String, mode: FeatureInteractionMode) async {
        let mode = mode.mobileNormalized
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setInteractionMode(id: id, mode: mode)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.interactionMode = mode }
        }
    }

    /// Model and effort are thread state, so a pick here is written through
    /// immediately and mirrored into the local thread for the frame before the
    /// server echo arrives.
    public func setModelSelection(_ id: String, selection: FeatureSelection) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setModelSelection(id: id, selection: selection)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) {
                $0.providerID = selection.providerID
                $0.modelID = selection.modelID
                $0.modelOptions = selection.options
            }
        }
    }

    @discardableResult
    public func deleteThread(_ id: String) async -> Bool {
        let environment = currentEnvironmentIdentity
        return await perform(failureTitle: "Couldn't Delete Thread") {
            try await client.deleteThread(id: id)
            guard currentEnvironmentIdentity == environment else { return }
            pendingThreadFileDrops[id] = nil
            removeThread(id: id)
            removeDetail(id: id)
            // A deleted thread is the one thing that should drop a review
            // selection: it survives leaving and re-entering the review.
            reviewSelection.forget(threadID: id)
        }
    }

    /// True while a thread exists only as a queued creation in this device's
    /// outbox. The server has never seen its id, so there is nothing to load
    /// or stream for it until delivery lands.
    public func isAwaitingCreation(_ threadID: String) -> Bool {
        pendingThreadsByID[threadID] != nil
    }

    public func detail(for id: String, force: Bool = false) async -> FeatureThreadDetail? {
        // Asking the server for a thread it has never been told about answers
        // "no such thread", which reads as a deleted thread rather than one
        // still on its way there. The optimistic transcript stands in until
        // `isAwaitingCreation` turns false.
        if isAwaitingCreation(id) {
            return details[id]
        }
        if !force, let cached = details[id] {
            return cached
        }
        let environment = currentEnvironmentIdentity
        do {
            let detail = try await client.loadThread(id: id)
            guard currentEnvironmentIdentity == environment else {
                return details[id]
            }
            store(detail)
            upsert(detail.thread)
            return detail
        } catch {
            if !Self.isBenignCancellation(error) {
                reportFailure(error.localizedDescription, title: "Couldn't Open Thread")
            }
            return details[id]
        }
    }

    public func loadEarlierTurns(for id: String) async {
        guard details[id]?.page?.hasMore == true,
              details[id]?.page?.isLoading != true else { return }
        let environment = currentEnvironmentIdentity
        do {
            guard let detail = try await client.loadEarlierThreadTurns(id: id),
                  currentEnvironmentIdentity == environment else { return }
            store(detail)
        } catch {
            if !Self.isBenignCancellation(error) {
                reportFailure(error.localizedDescription, title: "Couldn't Load Earlier Messages")
            }
        }
    }

    /// Ends any selected-thread transport work when its detail view closes.
    public func releaseThread(_ id: String) {
        client.releaseThread(id: id)
    }

    public func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async -> Bool {
        await sendMessage(
            FeatureMessageSubmission(
                threadID: threadID,
                text: text,
                selection: selection
            )
        )
    }

    public func sendMessage(_ submission: FeatureMessageSubmission) async -> Bool {
        let trimmed = submission.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !submission.attachments.isEmpty else { return false }

        guard let thread = snapshot.threads.first(where: { $0.id == submission.threadID }),
              let environmentID = thread.environmentID else {
            return false
        }
        let identity = FeatureSubmissionIdentity(threadID: thread.wireID ?? thread.id)
        let uploads = submission.attachments.map(\.upload)
        let queued = FeatureQueuedSubmission(
            environmentID: environmentID,
            identity: identity,
            threadID: submission.threadID,
            text: trimmed,
            selection: submission.selection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            attachments: uploads
        )
        guard await enqueue(queued) else { return false }

        // Behind a running turn the server queues the message, and the strip
        // above the composer shows it; the transcript gets it when its run
        // starts. The local row is only for a send the server hasn't taken.
        let waitsInServerQueue = queuesBehindRunningTurn(submission.threadID)
        let optimistic = FeatureMessage(
            id: identity.messageID,
            role: .user,
            text: trimmed,
            createdAt: identity.createdAt,
            state: .queued,
            attachments: submission.attachments.map {
                FeatureMessageAttachment(
                    id: $0.id.uuidString,
                    name: $0.filename,
                    mimeType: $0.mimeType,
                    sizeBytes: $0.byteCount,
                    previewData: $0.thumbnailData
                )
            }
        )
        let showOptimistic = {
            self.mutateDetail(
                id: submission.threadID,
                change: .delta(FeatureDetailDelta(
                    changedMessages: [optimistic],
                    appendedMessageIDs: [optimistic.id]
                ))
            ) {
                $0.messages.append(optimistic)
            }
        }
        if !waitsInServerQueue { showOptimistic() }

        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            try await client.sendMessage(
                threadID: submission.threadID,
                text: trimmed,
                selection: submission.selection,
                attachments: uploads,
                identity: identity
            )
            if !(await completeQueuedSubmission(queued)) {
                scheduleOutboxRetry()
            }
            return true
        } catch {
            if Self.shouldQueue(error, environmentID: environmentID, snapshot: snapshot) {
                // Held on this device instead: the transcript is the only
                // place it shows until delivery.
                if waitsInServerQueue { showOptimistic() }
                if isEnvironmentConnected(environmentID) {
                    scheduleOutboxRetry()
                }
                return true
            }
            let discarded = await discardQueuedSubmission(queued)
            if !discarded {
                scheduleOutboxRetry()
            }
            if discarded, !Self.isBenignCancellation(error) {
                reportFailure(error.localizedDescription, title: "Couldn't Send Message")
            }
            return false
        }
    }

    public func cancelTurn(threadID: String) async {
        await perform {
            try await client.cancelTurn(threadID: threadID)
        }
    }

    public func resolveApproval(_ id: String, decision: FeatureApprovalDecision) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.resolveApproval(id: id, decision: decision)
            guard currentEnvironmentIdentity == environment else { return }
            // Only touch details that actually hold the request; mutateDetail
            // deep-compares each mutated detail and the cache never shrinks.
            for key in Array(details.keys)
                where details[key]?.approvals.contains(where: { $0.id == id }) == true {
                mutateDetail(
                    id: key,
                    change: .delta(FeatureDetailDelta(changedMessages: []))
                ) {
                    $0.approvals.removeAll { $0.id == id }
                }
            }
        }
    }

    public func resolveUserInput(_ id: String, answers: [String: FeatureInputAnswer], attachments: [String: [FeatureUploadAttachment]] = [:], dismiss: Bool = false) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.resolveUserInput(id: id, answers: answers, attachments: attachments, dismiss: dismiss)
            guard currentEnvironmentIdentity == environment else { return }
            for key in Array(details.keys)
                where details[key]?.userInputs.contains(where: { $0.id == id }) == true {
                mutateDetail(
                    id: key,
                    change: .delta(FeatureDetailDelta(changedMessages: []))
                ) {
                    $0.userInputs.removeAll { $0.id == id }
                }
            }
        }
    }

    /// Convenience for callers that only submit free-form or single-select text.
    public func resolveUserInput(_ id: String, answers: [String: String]) async {
        await resolveUserInput(
            id,
            answers: answers.mapValues(FeatureInputAnswer.text)
        )
    }

    @discardableResult
    public func saveSettings(_ settings: FeatureSettings) async -> Bool {
        await perform {
            try await client.saveSettings(settings)
            snapshot.settings = settings
        }
    }

    @discardableResult
    private func perform(
        reportError: Bool = true,
        failureTitle: String? = nil,
        _ operation: () async throws -> Void
    ) async -> Bool {
        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            try await operation()
            return true
        } catch {
            if reportError, !Self.isBenignCancellation(error) {
                reportFailure(error.localizedDescription, title: failureTitle)
            }
            return false
        }
    }

    /// Raises the root alert, titled by what failed.
    public func reportFailure(_ message: String, title: String?) {
        errorMessage = message
        errorTitle = title
    }

    private static func isBenignCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        let message = error.localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return message == "cancelled" || message == "canceled"
    }

    private var currentEnvironmentIdentity: String {
        let active = snapshot.environments.first(where: \.isActive)
        return [
            active?.id,
            active?.endpoint,
            snapshot.connection.endpoint,
        ]
        .compactMap { $0 }
        .joined(separator: "|")
    }

    private func apply(_ event: FeatureEvent) {
        switch event {
        case let .snapshot(value):
            install(value)
        case let .connection(value):
            guard snapshot.connection != value else { return }
            snapshot.connection = value
            homePresentationRevision &+= 1
            if value.state == .connected {
                scheduleOutboxDrain()
            }
        case let .thread(value):
            acknowledgeAuthoritativeThread(value.id)
            upsert(value)
            mutateDetail(
                id: value.id,
                change: .delta(FeatureDetailDelta(changedMessages: []))
            ) {
                $0.thread = value
            }
        case let .threadRemoved(id):
            removeThread(id: id)
            removeDetail(id: id)
            reviewSelection.forget(threadID: id)
        case let .detail(value):
            store(value)
            upsert(value.thread)
        case let .detailDelta(value, delta):
            store(value, delta: delta)
            upsert(value.thread)
        case let .failure(message):
            errorMessage = message
        }
    }

    private func upsert(_ thread: FeatureThread) {
        if let index = snapshot.threads.firstIndex(where: { $0.id == thread.id }) {
            let previous = snapshot.threads[index]
            guard previous != thread else { return }
            snapshot.threads[index] = thread
            if previous.projectID != thread.projectID {
                adjustProjectCount(id: previous.projectID, by: -1)
                adjustProjectCount(id: thread.projectID, by: 1)
            }
        } else {
            snapshot.threads.append(thread)
            adjustProjectCount(id: thread.projectID, by: 1)
        }
        threadCollectionRevision &+= 1
        homePresentationRevision &+= 1
        observeChangeRequests(threadIDs: changeRequestThreadIDs)
    }

    private func removeThread(id: String) {
        guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
        let projectID = snapshot.threads[index].projectID
        snapshot.threads.remove(at: index)
        adjustProjectCount(id: projectID, by: -1)
        threadCollectionRevision &+= 1
        homePresentationRevision &+= 1
    }

    private func adjustProjectCount(id: String, by delta: Int) {
        guard let index = snapshot.projects.firstIndex(where: { $0.id == id }) else { return }
        snapshot.projects[index].threadCount = max(0, snapshot.projects[index].threadCount + delta)
    }

    private func install(_ value: FeatureSnapshot) {
        var value = value
        let authoritativeThreadIDs = Set(value.threads.map(\.id))
        for id in authoritativeThreadIDs {
            acknowledgeAuthoritativeThread(id)
        }
        for pending in pendingThreadsByID.values where !authoritativeThreadIDs.contains(pending.id) {
            value.threads.append(pending)
            if let index = value.projects.firstIndex(where: { $0.id == pending.projectID }) {
                value.projects[index].threadCount += 1
            }
        }

        if snapshot.connection != value.connection
            || snapshot.environments != value.environments
            || snapshot.projects != value.projects
            || snapshot.providers != value.providers
            || snapshot.providersByEnvironment != value.providersByEnvironment
            || snapshot.preferencesByEnvironment != value.preferencesByEnvironment
            || snapshot.threads != value.threads {
            homePresentationRevision &+= 1
        }
        if snapshot.threads != value.threads {
            threadCollectionRevision &+= 1
        }
        snapshot = value
        observeChangeRequests(threadIDs: changeRequestThreadIDs)
        if value.connection.state == .connected
            || value.environments.contains(where: { $0.connectionState == .connected }) {
            scheduleOutboxDrain()
        }
    }

    private func mutateThread(
        id: String,
        _ mutation: (inout FeatureThread) -> Void
    ) {
        if let index = snapshot.threads.firstIndex(where: { $0.id == id }) {
            let previous = snapshot.threads[index]
            mutation(&snapshot.threads[index])
            if snapshot.threads[index] != previous {
                threadCollectionRevision &+= 1
                homePresentationRevision &+= 1
            }
        }
        mutateDetail(
            id: id,
            change: .delta(FeatureDetailDelta(changedMessages: []))
        ) {
            mutation(&$0.thread)
        }
    }

    private func store(_ incoming: FeatureThreadDetail) {
        let incoming = retainingLocalAttachmentPreviews(in: incoming)
        let id = incoming.thread.id
        acknowledgeDeliveredMessages(incoming.messages)
        let prepared = addingPendingMessages(to: incoming)
        let next = details[id].map { current in
            // Rebuilt from parts to reuse unchanged prefixes, so anything the
            // initializer does not take is dropped. The timeline fields have no
            // wire form and are not in CodingKeys, so they have to be carried
            // across explicitly or the transcript would empty itself on the
            // second update.
            var merged = FeatureThreadDetail(
                thread: prepared.thread,
                messages: replacingChangedSuffix(current.messages, with: prepared.messages),
                approvals: replacingChangedSuffix(current.approvals, with: prepared.approvals),
                userInputs: replacingChangedSuffix(current.userInputs, with: prepared.userInputs),
                page: prepared.page
            )
            merged.timelineItems = prepared.timelineItems
            merged.timelineRuns = prepared.timelineRuns
            merged.itemSupport = prepared.itemSupport
            merged.subagentChildThreadIDs = prepared.subagentChildThreadIDs
            merged.workflow = prepared.workflow
            return merged
        } ?? prepared
        guard details[id] != next else { return }
        details[id] = next
        bumpDetailRevision(id: id, change: .full)
    }

    private func store(_ incoming: FeatureThreadDetail, delta: FeatureDetailDelta) {
        let incoming = retainingLocalAttachmentPreviews(in: incoming)
        let id = incoming.thread.id
        acknowledgeDeliveredMessages(incoming.messages)
        let next = addingPendingMessages(to: incoming)
        details[id] = next
        let appended = next.messages.dropFirst(incoming.messages.count).map(\.id)
        let pendingDelta = FeatureDetailDelta(
            changedMessages: delta.changedMessages + next.messages.dropFirst(incoming.messages.count),
            appendedMessageIDs: delta.appendedMessageIDs + appended
        )
        bumpDetailRevision(id: id, change: .delta(pendingDelta))
    }

    private func mutateDetail(
        id: String,
        change: FeatureDetailRenderChange = .full,
        _ mutation: (inout FeatureThreadDetail) -> Void
    ) {
        guard var detail = details[id] else { return }
        let previous = detail
        mutation(&detail)
        guard detail != previous else { return }
        details[id] = detail
        bumpDetailRevision(id: id, change: change)
    }

    private func removeDetail(id: String) {
        guard details.removeValue(forKey: id) != nil else { return }
        bumpDetailRevision(id: id, change: .full)
    }

    private func clearDetails() {
        guard !details.isEmpty else { return }
        details.removeAll()
        detailRevision &+= 1
        detailRevisions.removeAll()
        detailRenderUpdates.removeAll()
    }

    private func bumpDetailRevision(id: String, change: FeatureDetailRenderChange) {
        let baseRevision = detailRevisions[id] ?? 0
        detailRevision &+= 1
        detailRevisions[id] = detailRevision
        detailRenderUpdates[id] = FeatureDetailRenderUpdate(
            baseRevision: baseRevision,
            revision: detailRevision,
            change: change
        )
    }

    private func replacingChangedSuffix<Element: Equatable>(
        _ current: [Element],
        with incoming: [Element]
    ) -> [Element] {
        guard current != incoming else { return current }
        let prefixCount = zip(current, incoming).prefix { pair in
            pair.0 == pair.1
        }.count
        var result = current
        result.replaceSubrange(prefixCount..., with: incoming.dropFirst(prefixCount))
        return result
    }

    private func restoreOutbox() async {
        let submissions: [FeatureQueuedSubmission]
        do {
            submissions = try await outboxStore.submissions()
        } catch {
            reportFailure(
                "Could not restore queued messages: \(error.localizedDescription)",
                title: "Couldn't Restore Queued Messages"
            )
            return
        }

        for submission in submissions {
            if let creation = submission.creation {
                if snapshot.threads.contains(where: { $0.id == submission.threadID }) {
                    await discardRestoredSubmission(submission)
                    continue
                }
                guard let project = snapshot.projects.first(where: {
                    $0.id == creation.projectID && $0.environmentID == submission.environmentID
                }) else {
                    if isEnvironmentConnected(submission.environmentID) {
                        await discardRestoredSubmission(submission)
                    } else {
                        pendingSubmissionsByID[submission.id] = submission
                    }
                    continue
                }
                pendingSubmissionsByID[submission.id] = submission
                installPendingCreation(submission, project: project)
                continue
            }

            guard snapshot.threads.contains(where: { $0.id == submission.threadID }) else {
                if pendingThreadsByID[submission.threadID] != nil {
                    pendingSubmissionsByID[submission.id] = submission
                } else if isEnvironmentConnected(submission.environmentID) {
                    await discardRestoredSubmission(submission)
                } else {
                    pendingSubmissionsByID[submission.id] = submission
                }
                continue
            }
            pendingSubmissionsByID[submission.id] = submission
            if let detail = details[submission.threadID] {
                store(addingPendingMessages(to: detail))
            }
        }
    }

    private func discardRestoredSubmission(_ submission: FeatureQueuedSubmission) async {
        pendingSubmissionsByID[submission.id] = submission
        await discardQueuedSubmission(submission)
    }

    private func enqueue(_ submission: FeatureQueuedSubmission) async -> Bool {
        do {
            try await outboxStore.enqueue(submission)
            pendingSubmissionsByID[submission.id] = submission
            return true
        } catch {
            reportFailure(
                "Could not safely queue this message: \(error.localizedDescription)",
                title: "Couldn't Queue Message"
            )
            return false
        }
    }

    private func installPendingCreation(
        _ submission: FeatureQueuedSubmission,
        project: FeatureProject
    ) {
        guard let creation = submission.creation else { return }
        let provider = provider(
            id: submission.selection?.providerID,
            environmentID: submission.environmentID
        )
        let environmentName = snapshot.environments.first {
            $0.id == submission.environmentID
        }?.name
        let title = submission.text
            .split(whereSeparator: \.isNewline)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let thread = FeatureThread(
            id: submission.threadID,
            wireID: submission.identity.threadID,
            projectID: project.id,
            environmentID: submission.environmentID,
            environmentName: environmentName,
            title: title?.isEmpty == false ? title! : "New task",
            preview: submission.text,
            branch: creation.branch,
            worktreePath: creation.worktreePath,
            createdAt: submission.identity.createdAt,
            updatedAt: submission.identity.createdAt,
            state: .queued,
            providerID: submission.selection?.providerID,
            providerName: provider?.name,
            modelID: submission.selection?.modelID,
            runtimeMode: .fullAccess,
            interactionMode: .standard
        )
        pendingThreadsByID[thread.id] = thread
        upsert(thread)
        store(FeatureThreadDetail(
            thread: thread,
            messages: [queuedMessage(for: submission)]
        ))
    }

    private func provider(id: String?, environmentID: String) -> FeatureProvider? {
        guard let id else { return nil }
        let providers = snapshot.providersByEnvironment?[environmentID] ?? snapshot.providers
        return providers.first { $0.id == id }
    }

    private func queuedMessage(for submission: FeatureQueuedSubmission) -> FeatureMessage {
        FeatureMessage(
            id: submission.identity.messageID,
            role: .user,
            text: submission.text,
            createdAt: submission.identity.createdAt,
            state: .queued,
            attachments: submission.attachments.enumerated().map { index, attachment in
                FeatureMessageAttachment(
                    id: "\(submission.id)-attachment-\(index)",
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.data.count
                )
            }
        )
    }

    private func addingPendingMessages(to incoming: FeatureThreadDetail) -> FeatureThreadDetail {
        let queued = pendingSubmissionsByID.values
            .filter { $0.threadID == incoming.thread.id }
            .sorted { $0.identity.createdAt < $1.identity.createdAt }
        guard !queued.isEmpty else { return incoming }
        var result = incoming
        let existing = Set(result.messages.map(\.id))
        result.messages.append(contentsOf: queued.lazy
            .filter { !existing.contains($0.identity.messageID) }
            .map(queuedMessage(for:)))
        return result
    }

    private func retainingLocalAttachmentPreviews(
        in incoming: FeatureThreadDetail
    ) -> FeatureThreadDetail {
        guard let current = details[incoming.thread.id] else { return incoming }
        let currentMessages = current.messages.reduce(into: [String: FeatureMessage]()) {
            $0[$1.id] = $1
        }
        var result = incoming
        result.messages = incoming.messages.map { message in
            guard let local = currentMessages[message.id], !message.attachments.isEmpty else {
                return message
            }
            var message = message
            message.attachments = message.attachments.enumerated().map { index, attachment in
                guard attachment.previewData == nil else { return attachment }
                let matching = local.attachments.first { candidate in
                    candidate.id == attachment.id
                } ?? (
                    local.attachments.indices.contains(index)
                        ? local.attachments[index]
                        : nil
                )
                guard let previewData = matching?.previewData else { return attachment }
                var attachment = attachment
                attachment.previewData = previewData
                return attachment
            }
            return message
        }
        return result
    }

    private func acknowledgeAuthoritativeThread(_ id: String) {
        guard pendingThreadsByID[id] != nil,
              let submission = pendingSubmissionsByID.values.first(where: {
                  $0.threadID == id && $0.creation != nil
              }) else { return }
        scheduleQueuedSubmissionCompletion(submission)
    }

    private func acknowledgeDeliveredMessages(_ messages: [FeatureMessage]) {
        // Runs on every detail publish; skip the full message-ID scan in the
        // common case where nothing is waiting in the outbox.
        guard !pendingSubmissionsByID.isEmpty else { return }
        // Local optimistic rows reuse the final message ID but are not proof
        // that the server accepted the turn. Only authoritative, non-queued
        // rows can retire a durable outbox entry.
        let messageIDs = Set(messages.lazy
            .filter { $0.state != .queued }
            .map(\.id))
        let delivered = pendingSubmissionsByID.values.filter {
            $0.creation == nil && messageIDs.contains($0.identity.messageID)
        }
        for submission in delivered {
            scheduleQueuedSubmissionCompletion(submission)
        }
    }

    private func scheduleQueuedSubmissionCompletion(_ submission: FeatureQueuedSubmission) {
        guard pendingCompletionSubmissionIDs.insert(submission.id).inserted else { return }
        pendingDiscardSubmissionIDs.remove(submission.id)
        Task { @MainActor [weak self] in
            guard let self else { return }
            if !(await self.completeQueuedSubmission(submission)) {
                self.scheduleOutboxRetry()
            }
        }
    }

    @discardableResult
    private func completeQueuedSubmission(_ submission: FeatureQueuedSubmission) async -> Bool {
        pendingCompletionSubmissionIDs.insert(submission.id)
        pendingDiscardSubmissionIDs.remove(submission.id)
        do {
            try await outboxStore.remove(id: submission.id)
        } catch {
            reportFailure(
                "The message was delivered, but its queued copy could not be cleared: \(error.localizedDescription)",
                title: "Couldn't Clear Queued Message"
            )
            return false
        }
        pendingCompletionSubmissionIDs.remove(submission.id)
        pendingSubmissionsByID.removeValue(forKey: submission.id)
        pendingThreadsByID.removeValue(forKey: submission.threadID)
        markQueuedMessageDelivered(submission)
        outboxRetryAttempt = 0
        return true
    }

    /// A delivered message that landed behind a running turn now lives in the
    /// server's queue, so its local row leaves the transcript rather than
    /// sitting there until the next reload drops it. Only the local row: a
    /// server row with the same id is the real message.
    private func markQueuedMessageDelivered(_ submission: FeatureQueuedSubmission) {
        let messageID = submission.identity.messageID
        if queuesBehindRunningTurn(submission.threadID) {
            mutateDetail(id: submission.threadID) { detail in
                detail.messages.removeAll { $0.id == messageID && $0.state == .queued }
            }
            return
        }
        mutateDetail(
            id: submission.threadID,
            change: .delta(FeatureDetailDelta(changedMessages: []))
        ) { detail in
            guard let index = detail.messages.firstIndex(where: { $0.id == messageID }) else { return }
            detail.messages[index].state = .complete
        }
    }

    /// Whether a message sent now would wait in the server's queue: the server
    /// queues behind any active run. The thread's state stands in when the
    /// detail carries no runs.
    private func queuesBehindRunningTurn(_ threadID: String) -> Bool {
        if let runs = details[threadID]?.workflow.runs,
           ThreadWorkflows.resolveActiveRun(runs: runs) != nil {
            return true
        }
        let state = snapshot.threads.first { $0.id == threadID }?.state
        return state == .working || state == .queued
    }

    @discardableResult
    private func discardQueuedSubmission(_ submission: FeatureQueuedSubmission) async -> Bool {
        pendingCompletionSubmissionIDs.remove(submission.id)
        pendingDiscardSubmissionIDs.insert(submission.id)
        do {
            try await outboxStore.remove(id: submission.id)
        } catch {
            reportFailure(
                "Could not remove the queued message: \(error.localizedDescription)",
                title: "Couldn't Remove Queued Message"
            )
            return false
        }
        pendingDiscardSubmissionIDs.remove(submission.id)
        pendingSubmissionsByID.removeValue(forKey: submission.id)
        let wasPendingCreation = pendingThreadsByID.removeValue(forKey: submission.threadID) != nil
        if wasPendingCreation {
            removeThread(id: submission.threadID)
            removeDetail(id: submission.threadID)
        } else {
            mutateDetail(id: submission.threadID) {
                $0.messages.removeAll { $0.id == submission.identity.messageID }
            }
        }
        return true
    }

    private func removePendingSubmissions(environmentID: String) {
        let removed = pendingSubmissionsByID.values.filter {
            $0.environmentID == environmentID
        }
        for submission in removed {
            pendingCompletionSubmissionIDs.remove(submission.id)
            pendingDiscardSubmissionIDs.remove(submission.id)
            pendingSubmissionsByID.removeValue(forKey: submission.id)
            if pendingThreadsByID.removeValue(forKey: submission.threadID) != nil {
                removeThread(id: submission.threadID)
                removeDetail(id: submission.threadID)
            } else {
                mutateDetail(id: submission.threadID) {
                    $0.messages.removeAll { $0.id == submission.identity.messageID }
                }
            }
        }
    }

    private func markPendingSubmissionsForDiscard(environmentID: String) {
        for submission in pendingSubmissionsByID.values where submission.environmentID == environmentID {
            pendingCompletionSubmissionIDs.remove(submission.id)
            pendingDiscardSubmissionIDs.insert(submission.id)
        }
    }

    private func scheduleOutboxDrain(after delay: Duration = .zero) {
        guard outboxDrainTask == nil, !pendingSubmissionsByID.isEmpty else { return }
        let generation = outboxGeneration
        outboxDrainTask = Task { @MainActor [weak self] in
            if delay > .zero {
                try? await Task.sleep(for: delay)
            }
            guard !Task.isCancelled,
                  let self,
                  self.outboxGeneration == generation else { return }
            let needsRetry = await self.drainOutbox(generation: generation)
            self.outboxDrainTask = nil
            if needsRetry,
               !Task.isCancelled,
               self.outboxGeneration == generation {
                self.scheduleOutboxRetry()
            }
        }
    }

    func waitForCurrentOutboxDelivery() async {
        await outboxDrainTask?.value
    }

    private func stopOutboxDrain() async {
        outboxGeneration &+= 1
        guard let task = outboxDrainTask else { return }
        task.cancel()
        await task.value
        outboxDrainTask = nil
    }

    private func scheduleOutboxRetry() {
        guard outboxDrainTask == nil else { return }
        let seconds = min(16, 1 << min(outboxRetryAttempt, 4))
        outboxRetryAttempt += 1
        scheduleOutboxDrain(after: .seconds(seconds))
    }

    private func drainOutbox(generation: UInt64) async -> Bool {
        let submissions = pendingSubmissionsByID.values.sorted {
            $0.identity.createdAt < $1.identity.createdAt
        }
        var needsRetry = false
        for submission in submissions where pendingSubmissionsByID[submission.id] != nil {
            guard !Task.isCancelled, outboxGeneration == generation else { return false }
            if pendingCompletionSubmissionIDs.contains(submission.id) {
                if !(await completeQueuedSubmission(submission)) {
                    needsRetry = true
                }
                continue
            }
            if pendingDiscardSubmissionIDs.contains(submission.id) {
                if !(await discardQueuedSubmission(submission)) {
                    needsRetry = true
                }
                continue
            }
            var policySnapshot = snapshot
            if pendingThreadsByID[submission.threadID] != nil {
                policySnapshot.threads.removeAll { $0.id == submission.threadID }
            }
            switch FeatureOutboxPolicy.decision(
                for: submission,
                snapshot: policySnapshot,
                pendingCreationThreadIDs: Set(pendingThreadsByID.keys)
            ) {
            case .discard:
                if !(await discardQueuedSubmission(submission)) {
                    needsRetry = true
                }
            case .wait:
                // Connectivity and snapshot events wake the drain immediately.
                // Avoid a permanent timer while the owning device is offline.
                continue
            case .send:
                if failedOutboxIDs.contains(submission.id) { continue }
                sendingOutboxIDs.insert(submission.id)
                defer { sendingOutboxIDs.remove(submission.id) }
                do {
                    guard pendingSubmissionsByID[submission.id] != nil,
                          snapshot.environments.contains(where: {
                              $0.id == submission.environmentID
                          }) else {
                        continue
                    }
                    if let creation = submission.creation {
                        let thread = try await client.createThreadAndSend(
                            projectID: creation.projectID,
                            prompt: submission.text,
                            selection: submission.selection,
                            runtimeMode: submission.runtimeMode,
                            interactionMode: submission.interactionMode,
                            workspaceMode: creation.workspaceMode,
                            branch: creation.branch,
                            worktreePath: creation.worktreePath,
                            startFromOrigin: creation.startFromOrigin,
                            attachments: submission.uploads,
                            identity: submission.identity
                        )
                        guard !Task.isCancelled,
                              outboxGeneration == generation else { return false }
                        // The server's row lands before the optimistic one is
                        // retired. Retiring first leaves the thread in neither
                        // list across the outbox write, and a snapshot arriving
                        // in that gap reads the open thread as deleted.
                        if thread.id != submission.threadID {
                            removeThread(id: submission.threadID)
                            removeDetail(id: submission.threadID)
                        }
                        upsert(thread)
                        if !(await completeQueuedSubmission(submission)) {
                            needsRetry = true
                        }
                    } else {
                        try await client.sendMessage(
                            threadID: submission.threadID,
                            text: submission.text,
                            selection: submission.selection,
                            attachments: submission.uploads,
                            identity: submission.identity
                        )
                        guard !Task.isCancelled,
                              outboxGeneration == generation else { return false }
                        if !(await completeQueuedSubmission(submission)) {
                            needsRetry = true
                        }
                    }
                } catch {
                    if Self.shouldQueue(
                        error,
                        environmentID: submission.environmentID,
                        snapshot: snapshot
                    ) {
                        needsRetry = true
                    } else {
                        failedOutboxIDs.insert(submission.id)
                        reportFailure(error.localizedDescription, title: "Couldn't Send Message")
                    }
                }
            }
        }
        // A second draft may have been submitted while the first upload awaited.
        let attempted = Set(submissions.map(\.id))
        return needsRetry || pendingSubmissionsByID.keys.contains { !attempted.contains($0) }
    }

    private func isEnvironmentConnected(_ environmentID: String) -> Bool {
        guard let environment = snapshot.environments.first(where: { $0.id == environmentID }) else {
            return false
        }
        return environment.connectionState == .connected
            || (environment.isActive && snapshot.connection.state == .connected)
    }

    private static let transientHTTPStatuses: Set<Int> = [408, 429, 502, 503, 504]

    static func shouldQueue(
        _ error: any Error,
        environmentID: String,
        snapshot: FeatureSnapshot
    ) -> Bool {
        if error is CancellationError || error is URLError { return true }
        if let rpcError = error as? RPCError,
           case .responseTimedOut = rpcError {
            return true
        }
        // A signed attachment upload can fail with a gateway or overload status
        // after the socket has already reconnected. Those clear on their own, so
        // the submission waits for the outbox's backoff instead of failing.
        if let httpError = error as? HTTPError,
           case let .status(status, _, _) = httpError,
           Self.transientHTTPStatuses.contains(status) {
            return true
        }
        if let environment = snapshot.environments.first(where: { $0.id == environmentID }) {
            let disconnected = environment.connectionState != .connected
                && !(environment.isActive && snapshot.connection.state == .connected)
            if disconnected { return true }
        }
        let message = error.localizedDescription.lowercased()
        return [
            "cancelled", "canceled", "connection", "network", "offline",
            "socket", "timed out", "timeout", "transport", "not connected",
            "request deadline",
        ].contains { message.contains($0) }
    }
}

private extension FeatureDraftAttachment {
    var upload: FeatureUploadAttachment {
        FeatureUploadAttachment(data: data, name: filename, mimeType: mimeType)
    }
}
