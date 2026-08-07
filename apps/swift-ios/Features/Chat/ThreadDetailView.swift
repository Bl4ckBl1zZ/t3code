import ImageIO
import SwiftUI
import UIKit

public struct ThreadDetailView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @Bindable var model: FeatureRootModel
    let thread: FeatureThread
    let submitMessage: (FeatureMessageSubmission) async -> Bool
    let onNavigateBack: () -> Void
    /// Opening a related thread — a subagent card, a fork divider, a lineage row
    /// — is the navigator's job: this view is inside someone else's stack and
    /// only reports which thread was asked for. `isArchived` routes to the
    /// archive, which is the only place an archived thread can be shown.
    let onOpenRelatedThread: (_ threadID: String, _ isArchived: Bool) -> Void
    private let draftStore: FeatureComposerDraftStore

    @SwiftUI.Environment(\.openURL) private var openURL

    @State private var draft = ""
    @State private var selection: FeatureSelection?
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var isSending = false
    @State private var isLoading = true
    @State private var sendFailed = false
    @State private var didRestoreDraft = false
    @State private var draftSaveTask: Task<Void, Never>?
    @State private var toolSurface: FeatureThreadToolSurface?
    /// The queued run a reorder, edit or cancel is in flight for. One at a time:
    /// two overlapping reorders would race for the same positions.
    @State private var queueBusyRunID: String?
    @FocusState private var composerFocused: Bool

    public init(
        model: FeatureRootModel,
        thread: FeatureThread,
        submitMessage: @escaping (FeatureMessageSubmission) async -> Bool,
        onNavigateBack: @escaping () -> Void = {},
        onOpenRelatedThread: @escaping (String, Bool) -> Void = { _, _ in },
        draftStore: FeatureComposerDraftStore = .shared
    ) {
        self.model = model
        self.thread = thread
        self.submitMessage = submitMessage
        self.onNavigateBack = onNavigateBack
        self.onOpenRelatedThread = onOpenRelatedThread
        self.draftStore = draftStore
    }

    public var body: some View {
        Group {
            if isLoading {
                FeatureThreadOpeningView(isRefreshing: detail != nil)
            } else if let detail {
                timeline(detail)
            } else {
                ContentUnavailableView(
                    "Thread unavailable",
                    systemImage: "exclamationmark.bubble",
                    description: Text("The thread could not be loaded.")
                )
            }
        }
        .background(T3Colors.background)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(false)
        .t3NavigationChrome()
        .toolbar {
            ToolbarItem(placement: .principal) {
                threadHeaderTitle
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    toolSurface = .details
                } label: {
                    Image(systemName: "line.3.horizontal.decrease")
                }
                .accessibilityLabel("Thread details")
                .accessibilityIdentifier("thread-details-button")
            }
            ToolbarItem(placement: .primaryAction) {
                threadActionsMenu
            }
        }
        .task(id: thread.id) {
            let restoreBaseline = composerDraft
            let restoreKey = draftKey
            isLoading = true
            _ = await model.detail(for: thread.id, force: true)
            await restoreDraft(from: restoreBaseline, key: restoreKey)
            isLoading = false
        }
        .onChange(of: draft) { scheduleDraftSave() }
        .onChange(of: attachments) { scheduleDraftSave() }
        .onChange(of: selection) { scheduleDraftSave() }
        .onDisappear {
            model.releaseThread(thread.id)
            persistDraftBeforeLeaving()
        }
        .sheet(item: $toolSurface) { surface in
            NavigationStack {
                switch surface {
                case .details:
                    ThreadDetailsSheet(
                        thread: currentThread,
                        environment: threadEnvironment,
                        project: threadProject,
                        client: model.client,
                        onNavigate: navigateFromDetails,
                        onReconnect: {
                            guard let environmentID = threadEnvironment?.id else { return }
                            Task { _ = await model.activateEnvironment(environmentID) }
                        },
                        // The same projection the transcript renders, so the
                        // sheet's Background Tasks and Lineage sections cannot
                        // disagree with the rows above them.
                        turnItems: detail?.timelineItems.map(\.item) ?? [],
                        relationships: relationships,
                        onMergeBack: mergeBack,
                        onDetachSession: detachSession
                    )
                case let .files(path, line):
                    FeatureFilesView(
                        client: model.client,
                        threadID: thread.id,
                        initialPath: path,
                        initialLine: line
                    )
                case let .review(filePath):
                    FeatureReviewView(
                        client: model.client,
                        threadID: thread.id,
                        selection: model.reviewSelection,
                        initialFilePath: filePath
                    )
                case .sourceControl:
                    FeatureSourceControlView(client: model.client, threadID: thread.id)
                case .terminal:
                    FeatureTerminalView(client: model.client, threadID: thread.id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        toolSurface = nil
                    }
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .alert("Message not sent", isPresented: $sendFailed) {
            Button("OK") {}
        } message: {
            Text("Your draft is still here. Check your connection and try again.")
        }
        .simultaneousGesture(edgeBackGesture)
    }

    private var edgeBackGesture: some Gesture {
        DragGesture(minimumDistance: 18, coordinateSpace: .local)
            .onEnded { value in
                guard horizontalSizeClass == .compact,
                      value.startLocation.x <= 24,
                      value.translation.width >= 72,
                      abs(value.translation.height) <= abs(value.translation.width) * 0.7 else {
                    return
                }
                onNavigateBack()
            }
    }

    private var detail: FeatureThreadDetail? {
        model.details[thread.id]
    }

    private var currentThread: FeatureThread {
        detail?.thread ?? thread
    }

    private var currentSelection: FeatureSelection? {
        guard let providerID = detail?.thread.providerID ?? thread.providerID,
              let modelID = detail?.thread.modelID ?? thread.modelID else { return nil }
        let provider = threadProviders.first { $0.id == providerID }
        let featureModel = provider?.models.first { $0.id == modelID }
        let savedOptions = detail?.thread.modelOptions ?? thread.modelOptions
        return FeatureSelection(
            providerID: providerID,
            modelID: modelID,
            options: savedOptions.isEmpty
                ? featureModel.map(DailyUXModelOptions.defaults) ?? []
                : savedOptions
        )
    }

    private var threadHeaderTitle: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(currentThread.title)
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)

            HStack(spacing: 5) {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.triangle.branch")
                    Text(headerBranch)
                        .lineLimit(1)
                    if let environmentName = currentThread.homeEnvironmentLabel(in: model.snapshot) {
                        Text("·")
                        Text(environmentName)
                            .lineLimit(1)
                    }
                }
                .lineLimit(1)
                .truncationMode(.tail)

                Spacer(minLength: 6)

                // The per-second timeline only exists for the live working
                // duration; idle threads render a static status instead of
                // waking every second forever.
                Group {
                    if currentThread.homeStatus == .working {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            headerStatus(at: context.date)
                        }
                    } else {
                        headerStatus(at: .now)
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            }
            .font(T3Typography.navigationMetadata)
            .foregroundStyle(T3Colors.textTertiary)
        }
        .frame(maxWidth: horizontalSizeClass == .compact ? 260 : 460, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func headerStatus(at now: Date) -> some View {
        HStack(spacing: 5) {
            if let icon = headerStatusIcon {
                Image(systemName: icon)
            }
            if let duration = currentThread.homeWorkingDuration(at: now) {
                Text(duration)
                    .monospaced()
                    .monospacedDigit()
            } else {
                Text(currentThread.homeStatusLabel ?? "Ready")
            }
        }
        .font(T3Typography.status)
        .foregroundStyle(headerStatusColor)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }

    private var threadActionsMenu: some View {
        Menu {
            Section("Workspace") {
                Button { toolSurface = .files(path: nil, line: nil) } label: {
                    Label("Files", systemImage: "folder")
                }
                Button { toolSurface = .review(filePath: nil) } label: {
                    Label("Review changes", systemImage: "doc.text.magnifyingglass")
                }
                Button { toolSurface = .sourceControl } label: {
                    Label("Source Control", systemImage: "arrow.triangle.branch")
                }
                Button { toolSurface = .terminal } label: {
                    Label("Terminal", systemImage: "terminal")
                }
            }
            Section {
                if currentThread.canTogglePin, !currentThread.isArchived {
                    Button {
                        Task {
                            await model.setPinned(
                                thread.id,
                                pinned: currentThread.pinnedAt == nil
                            )
                        }
                    } label: {
                        Label(
                            currentThread.pinnedAt == nil ? "Pin" : "Unpin",
                            systemImage: currentThread.pinnedAt == nil ? "pin" : "pin.slash"
                        )
                    }
                }
                Button {
                    Task { _ = await model.detail(for: thread.id, force: true) }
                } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                Button {
                    Task {
                        await model.setArchived(thread.id, archived: !currentThread.isArchived)
                    }
                } label: {
                    Label(
                        currentThread.isArchived ? "Restore" : "Archive",
                        systemImage: currentThread.isArchived
                            ? "arrow.uturn.backward"
                            : "archivebox"
                    )
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
        }
        .buttonStyle(.plain)
        .foregroundStyle(T3Colors.textSecondary)
        .accessibilityLabel("Thread actions")
    }

    private var headerBranch: String {
        if let branch = currentThread.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
           !branch.isEmpty {
            return branch
        }
        if let path = currentThread.worktreePath,
           !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: path).lastPathComponent
        }
        return "workspace"
    }

    private var headerStatusIcon: String? {
        switch currentThread.homeStatus {
        case .working: "circle.dotted"
        case .done: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .approval, .input, .ready: nil
        }
    }

    private var headerStatusColor: Color {
        switch currentThread.homeStatus {
        case .working: T3Colors.statusRunning
        case .approval: T3Colors.warning
        case .input: T3Colors.statusInput
        case .failed: T3Colors.danger
        case .done: T3Colors.success
        case .ready: T3Colors.textTertiary
        }
    }

    private func timeline(_ detail: FeatureThreadDetail) -> some View {
        let isWorking = detail.thread.state == .working || detail.thread.state == .queued
        return Group {
            if detail.messages.isEmpty, detail.timelineItems.isEmpty, !isWorking {
                ContentUnavailableView(
                    "Ready for a task",
                    systemImage: "sparkles",
                    description: Text("Tell the agent what you want to build.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                FeatureTranscriptCollectionView(
                    threadID: thread.id,
                    // Projected rows name their source thread with a wire id, so
                    // the rollback affordance has to compare against one.
                    wireThreadID: thread.wireID ?? thread.id,
                    onRollback: { target in
                        Task {
                            try? await model.client.rollBackToCheckpoint(
                                threadID: target.threadID,
                                scopeID: target.scopeID,
                                checkpointID: target.checkpointID
                            )
                            _ = await model.detail(for: thread.id, force: true)
                        }
                    },
                    detail: detail,
                    renderUpdate: model.detailRenderUpdates[thread.id],
                    dynamicTypeSize: dynamicTypeSize,
                    isWorking: isWorking,
                    canLoadEarlier: detail.page?.hasMore == true,
                    isLoadingEarlier: detail.page?.isLoading == true,
                    workspaceRoot: threadWorkspaceRoot,
                    alwaysExpandActivity: model.snapshot.settings.alwaysExpandActivity,
                    onLoadEarlier: {
                        Task { await model.loadEarlierTurns(for: thread.id) }
                    },
                    onDismissKeyboard: dismissKeyboard,
                    onOpenThread: openRelatedThread,
                    onOpenFile: openFile,
                    onOpenURL: { openURL($0) },
                    onOpenDiff: openDiff
                )
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            relationshipsBanner
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                queueSurfaces
                composer(detail)
            }
        }
    }

    /// The lineage line above the transcript. A `safeAreaInset` rather than a
    /// row in the feed: it summarises the whole thread, so it has to stay put
    /// while the transcript scrolls under it.
    @ViewBuilder
    private var relationshipsBanner: some View {
        if let relationships, !relationships.isEmpty {
            ThreadRelationshipsBanner(
                model: relationships,
                onOpenThread: onOpenRelatedThread,
                onMerge: mergeBack,
                onDetach: detachSession
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .background(.bar)
        }
    }

    /// Queued runs, above the composer that will add to them.
    ///
    /// `QueuedMessageStripView` is the surface: it lists every queued message
    /// and owns reorder, edit and cancel. `ThreadQueueControlView` reads the
    /// same rows, so showing both unconditionally would print the queue twice —
    /// it appears only when the provider can actually promote a queued message
    /// into a steer, which is the one affordance the strip does not have.
    @ViewBuilder
    private var queueSurfaces: some View {
        let state = queueState
        if !state.queuedRuns.isEmpty {
            VStack(spacing: 8) {
                if state.canPromoteToSteer {
                    ThreadQueueControlView(
                        state: state,
                        busyRunID: queueBusyRunID,
                        onReorder: { target in
                            performQueueAction(runID: target.runID) {
                                try await model.client.reorderQueuedRun(
                                    threadID: thread.id,
                                    runID: target.runID,
                                    beforeRunID: target.beforeRunID
                                )
                            }
                        },
                        onPromoteToSteer: { queuedRunID, targetRunID in
                            performQueueAction(runID: queuedRunID) {
                                try await model.client.promoteQueuedRun(
                                    threadID: thread.id,
                                    queuedRunID: queuedRunID,
                                    targetRunID: targetRunID
                                )
                            }
                        }
                    )
                }

                QueuedMessageStripView(
                    queuedRuns: state.queuedRuns,
                    canReorder: state.canReorder,
                    dispatchingRunID: nil,
                    busyRunID: queueBusyRunID,
                    onReorder: { target in
                        performQueueAction(runID: target.runID) {
                            try await model.client.reorderQueuedRun(
                                threadID: thread.id,
                                runID: target.runID,
                                beforeRunID: target.beforeRunID
                            )
                        }
                    },
                    onEdit: { runID, text in
                        performQueueAction(runID: runID) {
                            try await model.client.editQueuedRun(
                                threadID: thread.id,
                                runID: runID,
                                text: text
                            )
                        }
                    },
                    onDelete: { runID in
                        performQueueAction(runID: runID) {
                            try await model.client.cancelQueuedRun(
                                threadID: thread.id,
                                runID: runID
                            )
                        }
                    }
                )
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
            .background(.bar)
        }
    }

    private func composer(_ detail: FeatureThreadDetail) -> some View {
        FeatureComposerView(
            text: $draft,
            selection: $selection,
            attachments: $attachments,
            providers: threadProviders,
            threadSelection: currentSelection,
            materializesDefaultSelection: false,
            isSending: isSending,
            isWorking: detail.thread.state == .working || detail.thread.state == .queued,
            focused: $composerFocused,
            onSend: send,
            onStop: {
                Task { await model.cancelTurn(threadID: thread.id) }
            },
            pendingApprovals: detail.approvals,
            pendingUserInputs: detail.userInputs,
            isResolvingRequest: model.isPerformingAction,
            powerFeatures: composerPowerFeatures,
            onApprovalDecision: { id, decision in
                Task { await model.resolveApproval(id, decision: decision) }
            },
            onUserInputSubmit: { id, answers in
                Task { await model.resolveUserInput(id, answers: answers) }
            }
        )
        .simultaneousGesture(composerKeyboardDismissGesture)
    }

    private var composerKeyboardDismissGesture: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .local)
            .onChanged { value in
                guard composerFocused,
                      value.translation.height > 8,
                      value.translation.height > abs(value.translation.width) else {
                    return
                }
                dismissKeyboard()
            }
    }

    private var composerPowerFeatures: FeatureComposerPowerFeatures {
        let selectedProviderID = selection?.providerID ?? currentSelection?.providerID
        let provider = threadProviders.first { $0.id == selectedProviderID }
        return FeatureComposerPowerFeatures(
            slashCommands: provider?.slashCommands ?? [],
            skills: provider?.skills ?? [],
            pathSearchScopeID: currentThread.id,
            searchPaths: { query in
                try await model.client.searchThreadFiles(
                    threadID: currentThread.id,
                    query: query,
                    limit: 20
                ).map { entry in
                    FeatureComposerPathEntry(
                        path: entry.path,
                        kind: entry.kind == .directory ? .directory : .file
                    )
                }
            }
        )
    }

    private var threadProviders: [FeatureProvider] {
        DailyUXCreationContext.providers(for: threadProject, in: model.snapshot)
    }

    private var threadProject: FeatureProject? {
        model.snapshot.projects.first { $0.id == currentThread.projectID }
    }

    private var threadEnvironment: FeatureEnvironment? {
        guard let environmentID = currentThread.environmentID ?? threadProject?.environmentID else {
            return nil
        }
        return model.snapshot.environments.first { $0.id == environmentID }
    }

    /// The root a work-log row resolves its file paths against.
    private var threadWorkspaceRoot: String? {
        currentThread.worktreePath ?? threadProject?.path
    }

    // MARK: - Lineage

    /// The thread's lineage, as much of it as the feature layer can see.
    ///
    /// Subagent edges come from the transcript's own `subagent` items, remapped
    /// onto the feature-scoped child thread ids the detail resolved — that
    /// remap is the whole point of ``FeatureThreadDetail/subagentChildThreadIDs``
    /// and it is what makes a card in the timeline and a row in the banner point
    /// at the same thread.
    ///
    /// Fork and transfer edges stay missing: they need
    /// `thread.lineage.parentThreadId` and the projection's context-transfer
    /// table, neither of which `FeatureThreadDetail` carries. So do merge-back
    /// and detach, which need the thread's runs and its provider session.
    private var relationships: ThreadRelationshipsModel? {
        guard let detail else { return nil }
        let subagents = detail.timelineItems.compactMap { projected in
            ThreadRelationshipSubagentLink(turnItem: projected.item).map { link in
                guard let scopedThreadID = detail.subagentChildThreadIDs[link.id] else {
                    return link
                }
                return ThreadRelationshipSubagentLink(
                    id: link.id,
                    childThreadID: scopedThreadID,
                    status: link.status,
                    title: link.title
                )
            }
        }
        guard !subagents.isEmpty else { return nil }

        let current = relationshipShell(currentThread)
        let relatedIDs = Set(subagents.compactMap(\.childThreadID))
        let related = model.snapshot.threads
            .filter { relatedIDs.contains($0.id) && $0.id != current.id }
            .map(relationshipShell)
        return ThreadRelationships.build(
            currentThreadID: current.id,
            currentThread: current,
            threads: [current] + related,
            subagents: subagents
        )
    }

    private func relationshipShell(_ thread: FeatureThread) -> ThreadRelationshipShell {
        // The graph speaks run statuses, which is what `subagentOrbState` reads.
        let status: String = switch thread.state {
        case .working, .queued: "running"
        case .failed: "failed"
        default: "idle"
        }
        return ThreadRelationshipShell(
            id: thread.id,
            title: thread.title,
            status: status,
            parentThreadID: nil,
            relationshipToParent: thread.relationshipToParent,
            forkedFromRunThreadID: nil,
            // Availability only asks whether these are set, and an archived
            // thread has no timestamp on this layer's model.
            archivedAt: thread.isArchived ? "archived" : nil
        )
    }

    private func mergeBack() async -> Bool {
        guard let relationships,
              let targetThreadID = relationships.mergeTargetThreadID,
              let runID = relationships.latestMergeBackRunID else {
            return false
        }
        do {
            try await model.client.mergeThreadBack(
                sourceThreadID: thread.id,
                targetThreadID: targetThreadID,
                runID: runID
            )
        } catch {
            return false
        }
        _ = await model.detail(for: thread.id, force: true)
        return true
    }

    private func detachSession() async {
        try? await model.client.stopThreadSession(threadID: thread.id)
        _ = await model.detail(for: thread.id, force: true)
    }

    // MARK: - Queue

    /// Queued runs waiting behind the running turn.
    ///
    /// Server state, not the phone's outbox: a message sent with dispatch mode
    /// "queue" becomes a run in `queued` status that every client can see.
    ///
    /// The thread's queue, derived by the adapter from the projection.
    private var queueState: ThreadQueueWorkflowState {
        model.details[thread.id]?.workflow.queueState ?? .empty
    }

    /// Runs one queue command, locking the row it targets for its duration and
    /// refreshing afterwards so the list reflects what the server did rather
    /// than what was asked for.
    private func performQueueAction(
        runID: String,
        _ command: @escaping () async throws -> Void
    ) {
        guard queueBusyRunID == nil else { return }
        queueBusyRunID = runID
        Task {
            defer { queueBusyRunID = nil }
            try? await command()
            _ = await model.detail(for: thread.id, force: true)
        }
    }

    /// Sheets stack over the thread, so a row that opens another surface swaps
    /// the presented sheet rather than pushing a second one on top of it.
    private func navigateFromDetails(_ destination: ThreadDetailsDestination) {
        switch destination {
        case .connections:
            toolSurface = nil
            model.setConnectionManagementPresented(true)
        case .files:
            toolSurface = .files(path: nil, line: nil)
        case .review:
            toolSurface = .review(filePath: nil)
        case .sourceControl:
            toolSurface = .sourceControl
        case .terminal:
            toolSurface = .terminal
        case let .thread(id, isArchived):
            toolSurface = nil
            onOpenRelatedThread(id, isArchived)
        }
    }

    /// Opens the file browser on the file a work-log link named, at its line.
    ///
    /// The route is built rather than followed as a URL — this client pushes the
    /// preview itself — but building it is what splits the path into segments,
    /// drops a non-positive line, and discards the activity's own provenance in
    /// favour of the thread whose workspace is on screen.
    private func openFile(_ request: ThreadActivityFileOpenRequest) {
        let route = ThreadActivityFileRoute.build(
            environmentID: threadEnvironment?.id ?? currentThread.environmentID ?? "",
            currentThreadID: thread.id,
            activitySourceThreadID: request.sourceThreadID ?? thread.id,
            relativePath: request.relativePath,
            line: request.line
        )
        let destination = FeatureFilesView.destination(for: route)
        toolSurface = .files(path: destination.path, line: destination.line)
    }

    /// Opens the review on a checkpoint's diff, pointed at one file when a chip
    /// rather than the row was tapped.
    ///
    /// The section is recorded even though nothing reads it yet: this client's
    /// `loadReview` returns the working tree, so a checkpoint's own diff is not
    /// reachable, and the store is where that turn will be waiting when it is.
    private func openDiff(checkpointID: String, filePath: String?) {
        model.reviewSelection.openReview(
            threadID: thread.id,
            sectionID: checkpointID,
            filePath: filePath
        )
        toolSurface = .review(filePath: filePath)
    }

    /// Routes a thread id from a timeline row. Whether the target is archived
    /// decides which stack the navigator pushes onto, and the snapshot is the
    /// only place this view can learn that.
    private func openRelatedThread(_ threadID: String) {
        let isArchived = model.snapshot.threads.first { $0.id == threadID }?.isArchived ?? false
        onOpenRelatedThread(threadID, isArchived)
    }

    private func dismissKeyboard() {
        guard composerFocused else { return }
        composerFocused = false
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private func send() {
        let message = draft
        let pendingAttachments = attachments
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pendingAttachments.isEmpty else {
            return
        }
        draftSaveTask?.cancel()
        isSending = true
        draft = ""
        attachments = []
        composerFocused = false
        Task {
            let sent = await submitMessage(
                FeatureMessageSubmission(
                threadID: thread.id,
                text: message,
                selection: selection,
                attachments: pendingAttachments
                )
            )
            if sent {
                let followUpDraft = composerDraft
                if followUpDraft.text.isEmpty && followUpDraft.attachments.isEmpty {
                    try? await draftStore.removeDraft(for: draftKey)
                } else {
                    try? await draftStore.setDraft(followUpDraft, for: draftKey)
                }
            } else {
                let currentDraft = draft
                let restoredMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
                if currentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft = message
                } else if !restoredMessage.isEmpty {
                    draft = "\(message)\n\(currentDraft)"
                }
                let pendingIDs = Set(pendingAttachments.map(\.id))
                attachments = pendingAttachments + attachments.filter {
                    !pendingIDs.contains($0.id)
                }
                sendFailed = true
                composerFocused = true
            }
            isSending = false
            if !sent {
                persistDraftImmediately()
            }
        }
    }

    private var draftKey: String {
        FeatureComposerDraftStore.threadKey(currentThread)
    }

    @MainActor
    private func restoreDraft(from baseline: FeatureComposerDraft, key: String) async {
        let saved = try? await draftStore.draft(for: key)
        guard !Task.isCancelled else { return }

        let liveDraft = composerDraft
        var restored = FeatureComposerDraftRestoration.merge(
            saved: saved,
            baseline: baseline,
            current: liveDraft
        )
        restored.selection = ThreadComposerModelSelectionPolicy.explicitSelection(
            restored.selection,
            inherited: currentSelection,
            providers: threadProviders
        )
        draft = restored.text
        attachments = restored.attachments
        selection = restored.selection
        didRestoreDraft = true

        // Changes made while the file read or thread refresh was in flight did
        // not pass the didRestoreDraft gate, so enqueue their first save now.
        if liveDraft != baseline {
            scheduleDraftSave()
        }
    }

    private func scheduleDraftSave() {
        guard didRestoreDraft, !isSending else { return }
        draftSaveTask?.cancel()
        let snapshot = composerDraft
        let key = draftKey
        draftSaveTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(220))
                try Task.checkCancellation()
                try await draftStore.setDraft(snapshot, for: key)
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
    }

    private func persistDraftImmediately() {
        guard didRestoreDraft else { return }
        draftSaveTask?.cancel()
        let snapshot = composerDraft
        let key = draftKey
        draftSaveTask = Task {
            try? await draftStore.setDraft(snapshot, for: key)
        }
    }

    private func persistDraftBeforeLeaving() {
        guard didRestoreDraft, !isSending else { return }
        persistDraftImmediately()
    }

    private var composerDraft: FeatureComposerDraft {
        FeatureComposerDraft(
            text: draft,
            attachments: attachments,
            selection: selection
        )
    }

}

private struct FeatureThreadOpeningView: View {
    let isRefreshing: Bool

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.regular)
            Text(isRefreshing ? "Refreshing thread…" : "Loading thread…")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-opening-state")
    }
}

/// A sheet over the thread, and where inside it to land.
///
/// The two workspace surfaces carry a destination because the transcript can
/// deep-link into them: a file link names a file and sometimes a line, and a
/// changed-files chip names one file of a diff. The identity below includes that
/// destination, so opening the same surface at a different place re-presents it
/// rather than reusing a sheet already pointed somewhere else.
private enum FeatureThreadToolSurface: Identifiable {
    case details
    case files(path: String?, line: Int?)
    case review(filePath: String?)
    case sourceControl
    case terminal

    var id: String {
        switch self {
        case .details: "details"
        case let .files(path, line): "files:\(path ?? "")#\(line.map(String.init) ?? "")"
        case let .review(filePath): "review:\(filePath ?? "")"
        case .sourceControl: "sourceControl"
        case .terminal: "terminal"
        }
    }
}

/// Merges a stored draft with edits made while that draft was loading. Each
/// field is restored only if its live value still matches the value captured
/// before the asynchronous read began.
enum FeatureComposerDraftRestoration {
    static func merge(
        saved: FeatureComposerDraft?,
        baseline: FeatureComposerDraft,
        current: FeatureComposerDraft,
        fallbackSelection: FeatureSelection? = nil,
        fallbackWorkspace: FeatureComposerWorkspaceDraft? = nil
    ) -> FeatureComposerDraft {
        FeatureComposerDraft(
            text: current.text == baseline.text
                ? saved?.text ?? ""
                : current.text,
            attachments: current.attachments == baseline.attachments
                ? saved?.attachments ?? []
                : current.attachments,
            selection: current.selection == baseline.selection
                ? saved?.selection ?? fallbackSelection
                : current.selection,
            workspace: mergeWorkspace(
                saved: saved?.workspace ?? fallbackWorkspace,
                baseline: baseline.workspace,
                current: current.workspace
            )
        )
    }

    private static func mergeWorkspace(
        saved: FeatureComposerWorkspaceDraft?,
        baseline: FeatureComposerWorkspaceDraft?,
        current: FeatureComposerWorkspaceDraft?
    ) -> FeatureComposerWorkspaceDraft? {
        guard let saved else {
            return current == baseline ? nil : current
        }
        guard let baseline, let current else {
            return current == baseline ? saved : current
        }
        return FeatureComposerWorkspaceDraft(
            mode: current.mode == baseline.mode ? saved.mode : current.mode,
            branch: current.branch == baseline.branch ? saved.branch : current.branch,
            worktreePath: current.worktreePath == baseline.worktreePath
                ? saved.worktreePath
                : current.worktreePath,
            startFromOrigin: current.startFromOrigin == baseline.startFromOrigin
                ? saved.startFromOrigin
                : current.startFromOrigin
        )
    }
}

// MARK: - Timeline feed

/// One row of the transcript.
///
/// The transcript is not a message list. The projection's turn items divide
/// three ways — conversation messages, lifecycle rows (system dividers and
/// related-thread cards), and everything else, which folds into work-log groups
/// — and calendar boundaries add a fourth. Each case carries everything its row
/// renders, so the recycled collection view can decide what changed by comparing
/// entries and nothing else.
enum ThreadTimelineEntry: Identifiable, Equatable {
    case message(FeatureMessage)
    case lifecycle(Lifecycle)
    case workLog(WorkLog)
    case dayDivider(id: String, date: Date)

    struct Lifecycle: Equatable {
        let id: String
        /// More than one only for a merged run of related-thread cards, which
        /// share a single card surface rather than stacking identical boxes.
        let rows: [OrchestrationV2ProjectedTurnItem]
        /// Handoff rows recover the model that was speaking before the handoff
        /// from run history.
        let runs: [LifecycleTimelineRun]
        /// Projected-item id to the feature-scoped id of the thread a subagent
        /// spawned, which is what makes its card tappable.
        let childThreadIDs: [String: String]
        let date: Date?
    }

    struct WorkLog: Equatable {
        let id: String
        let rows: [ThreadWorkLogRow]
        /// Relational support keyed by projected-item id, read by the inspector
        /// a row opens.
        let support: [String: ThreadActivityItemSupport]
        let date: Date?
    }

    var id: String {
        switch self {
        case let .message(message): "message:\(message.id)"
        case let .lifecycle(lifecycle): lifecycle.id
        case let .workLog(workLog): workLog.id
        case let .dayDivider(id, _): id
        }
    }

    /// When the entry happened, for day bucketing. Nil when the timestamp did
    /// not parse, which drops the divider rather than the row under it.
    var date: Date? {
        switch self {
        case let .message(message): message.createdAt
        case let .lifecycle(lifecycle): lifecycle.date
        case let .workLog(workLog): workLog.date
        case let .dayDivider(_, date): date
        }
    }
}

/// Turns a thread detail into the rows the transcript renders.
///
/// Ports `buildThreadFeed` from apps/mobile/src/lib/threadActivity.ts so both
/// clients divide the same projection the same way: classify each item, fold
/// contiguous work into groups, merge adjacent related-thread cards, then split
/// by calendar day.
enum ThreadTimelineFeed {
    static func entries(
        for detail: FeatureThreadDetail,
        calendar: Calendar = .current
    ) -> [ThreadTimelineEntry] {
        entries(
            timelineItems: detail.timelineItems,
            messages: detail.messages,
            runs: detail.timelineRuns,
            support: detail.itemSupport,
            subagentChildThreadIDs: detail.subagentChildThreadIDs,
            calendar: calendar
        )
    }

    static func entries(
        timelineItems: [OrchestrationV2ProjectedTurnItem],
        messages: [FeatureMessage],
        runs: [LifecycleTimelineRun] = [],
        support: [String: ThreadActivityItemSupport] = [:],
        subagentChildThreadIDs: [String: String] = [:],
        calendar: Calendar = .current
    ) -> [ThreadTimelineEntry] {
        var messagesByID: [String: FeatureMessage] = [:]
        messagesByID.reserveCapacity(messages.count)
        for message in messages { messagesByID[message.id] = message }

        var entries: [ThreadTimelineEntry] = []
        var openWork: [ThreadWorkLogRow] = []
        var openLifecycle: [OrchestrationV2ProjectedTurnItem] = []

        func closeWork() {
            guard !openWork.isEmpty else { return }
            for group in ThreadWorkLogRow.groups(openWork) {
                var groupSupport: [String: ThreadActivityItemSupport] = [:]
                for row in group where support[row.projectedItem.id] != nil {
                    groupSupport[row.projectedItem.id] = support[row.projectedItem.id]
                }
                entries.append(
                    .workLog(
                        ThreadTimelineEntry.WorkLog(
                            id: "work:\(group[0].id)",
                            rows: group,
                            support: groupSupport,
                            date: ThreadTimelineDay.date(fromISO8601: group[0].createdAt)
                        )
                    )
                )
            }
            openWork.removeAll(keepingCapacity: true)
        }

        func closeLifecycle() {
            guard !openLifecycle.isEmpty else { return }
            for group in ThreadTimelineGrouping.mergeRelatedThreadCardRuns(openLifecycle) {
                var childThreadIDs: [String: String] = [:]
                for row in group.elements {
                    guard case let .subagent(subagentID, _, _, _, _, _, _, _) = row.item.payload,
                          let childThreadID = subagentChildThreadIDs[subagentID] else {
                        continue
                    }
                    childThreadIDs[row.id] = childThreadID
                }
                entries.append(
                    .lifecycle(
                        ThreadTimelineEntry.Lifecycle(
                            // The merge already anchors a run's id on its first
                            // member, so this stays stable as later cards join.
                            id: "lifecycle:\(group.id)",
                            rows: group.elements,
                            runs: runs,
                            childThreadIDs: childThreadIDs,
                            date: itemDate(group.first.item)
                        )
                    )
                )
            }
            openLifecycle.removeAll(keepingCapacity: true)
        }

        for projected in timelineItems {
            let item = projected.item
            if item.type == "user_message" || item.type == "assistant_message" {
                // An empty bubble is not a row — an assistant message before its
                // first token, say — and skipping it must not split the work
                // group it sits inside.
                guard let message = messagesByID[item.id], !message.isEmptyBubble else { continue }
                closeWork()
                closeLifecycle()
                entries.append(.message(message))
                continue
            }
            if ThreadLifecycle.isLifecycleTimelineItem(item) {
                closeWork()
                openLifecycle.append(projected)
                continue
            }
            closeLifecycle()
            openWork.append(ThreadWorkLogRow.make(projected))
        }
        closeWork()
        closeLifecycle()

        // Optimistic sends have no projected item yet, and a client that carries
        // no projection at all has only messages. Both arrive here as plain
        // message rows, which is what keeps a just-sent bubble on screen.
        let projectedItemIDs = Set(timelineItems.map(\.item.id))
        for message in messages
        where !projectedItemIDs.contains(message.id) && !message.isEmptyBubble {
            entries.append(.message(message))
        }

        // A duplicate identifier is fatal to a diffable data source, so identity
        // is enforced here rather than trusted.
        var seenIDs = Set<String>()
        entries = entries.filter { seenIDs.insert($0.id).inserted }

        return insertingDayDividers(entries, calendar: calendar)
    }

    private static func itemDate(_ item: OrchestrationV2TurnItem) -> Date? {
        ThreadTimelineDay.date(fromISO8601: item.base.startedAt ?? item.base.updatedAt)
    }

    /// Divider ids are anchored on the entry below them, which is both unique
    /// and stable as the feed grows.
    private static func insertingDayDividers(
        _ entries: [ThreadTimelineEntry],
        calendar: Calendar
    ) -> [ThreadTimelineEntry] {
        let dividerIndexes = Set(
            ThreadTimelineDay.dividerIndexes(entries, calendar: calendar) { $0.date }
        )
        guard !dividerIndexes.isEmpty else { return entries }
        var result: [ThreadTimelineEntry] = []
        result.reserveCapacity(entries.count + dividerIndexes.count)
        for (index, entry) in entries.enumerated() {
            if dividerIndexes.contains(index), let date = entry.date {
                result.append(.dayDivider(id: "day-divider:\(entry.id)", date: date))
            }
            result.append(entry)
        }
        return result
    }
}

private extension FeatureMessage {
    /// Nothing to render: no text and no attachments.
    var isEmptyBubble: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty
    }
}

/// One row of the transcript, rendered.
///
/// Every entry owns 16pt of bottom margin — `ChatTimelineStyle.entrySpacing`,
/// the rhythm the React Native client uses — so the hosting collection view
/// stacks entries with zero spacing between them. Lifecycle rows and dividers
/// carry that margin themselves; messages and work-log groups get it here.
private struct ThreadTimelineEntryView: View {
    let entry: ThreadTimelineEntry
    let currentThreadID: String
    let currentWireThreadID: String
    let onRollback: (ThreadActivityRollbackTarget) -> Void
    let workspaceRoot: String?
    let alwaysExpandActivity: Bool
    let onOpenThread: (String) -> Void
    let onOpenFile: (ThreadActivityFileOpenRequest) -> Void
    let onOpenURL: (URL) -> Void
    let onOpenDiff: (String, String?) -> Void

    var body: some View {
        switch entry {
        case let .message(message):
            FeatureMessageView(message: message)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, ChatTimelineStyle.entrySpacing)

        case let .lifecycle(lifecycle):
            if lifecycle.rows.count > 1 {
                ThreadLifecycleCardGroup(
                    rows: lifecycle.rows,
                    runs: lifecycle.runs,
                    liveChildThreadIDs: lifecycle.childThreadIDs,
                    onOpenThread: onOpenThread
                )
            } else if let row = lifecycle.rows.first {
                ThreadLifecycleRow(
                    row: row,
                    runs: lifecycle.runs,
                    liveChildThreadID: lifecycle.childThreadIDs[row.id],
                    onOpenThread: onOpenThread
                )
            }

        case let .workLog(workLog):
            ThreadWorkLog(
                rows: workLog.rows,
                currentThreadID: currentThreadID,
                currentWireThreadID: currentWireThreadID,
                workspaceRoot: workspaceRoot,
                itemSupport: { workLog.support[$0.id] ?? .empty },
                onOpenThread: onOpenThread,
                onOpenFile: onOpenFile,
                onOpenURL: onOpenURL,
                onOpenDiff: onOpenDiff,
                onRollback: onRollback,
                alwaysExpandActivity: alwaysExpandActivity
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            // The log already ends on 12pt of its own.
            .padding(.bottom, ChatTimelineStyle.entrySpacing - 12)

        case let .dayDivider(_, date):
            TimelineDayDivider(date: date)
        }
    }
}

/// A recycled transcript surface. SwiftUI still owns each entry's rendering,
/// while UIKit keeps offscreen entries out of the active view hierarchy.
private struct FeatureTranscriptCollectionView: UIViewRepresentable {
    private static let workingIndicatorID = "__t3-working-indicator__"
    private static let loadEarlierID = "__t3-load-earlier__"

    private enum Section: Hashable {
        case transcript
    }

    let threadID: String
    let wireThreadID: String
    let onRollback: (ThreadActivityRollbackTarget) -> Void
    /// The whole detail rather than its rows: building the feed costs O(window),
    /// so it happens inside the coordinator once the revision guard has proved
    /// something actually changed, not on every SwiftUI body evaluation.
    let detail: FeatureThreadDetail
    let renderUpdate: FeatureDetailRenderUpdate?
    let dynamicTypeSize: DynamicTypeSize
    let isWorking: Bool
    let canLoadEarlier: Bool
    let isLoadingEarlier: Bool
    let workspaceRoot: String?
    /// `FeatureSettings.alwaysExpandActivity`, which decides how work-log rows
    /// open. Tracked like the type size below rather than passed through the row
    /// context alone: a preference change has to reconfigure cells that are
    /// already on screen.
    let alwaysExpandActivity: Bool
    let onLoadEarlier: () -> Void
    let onDismissKeyboard: () -> Void
    let onOpenThread: (String) -> Void
    let onOpenFile: (ThreadActivityFileOpenRequest) -> Void
    let onOpenURL: (URL) -> Void
    let onOpenDiff: (String, String?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UICollectionView {
        let collectionView = BottomAnchoredTranscriptCollectionView(
            frame: .zero,
            collectionViewLayout: Self.makeLayout()
        )
        collectionView.backgroundColor = T3Colors.uiBackground
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .onDrag
        collectionView.delaysContentTouches = false
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.isPrefetchingEnabled = true
        collectionView.accessibilityIdentifier = "thread-transcript"
        context.coordinator.connect(to: collectionView)
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        context.coordinator.update(
            threadID: threadID,
            detail: detail,
            renderUpdate: renderUpdate,
            dynamicTypeSize: dynamicTypeSize,
            isWorking: isWorking,
            canLoadEarlier: canLoadEarlier,
            isLoadingEarlier: isLoadingEarlier,
            alwaysExpandActivity: alwaysExpandActivity,
            rowContext: Coordinator.RowContext(
                currentThreadID: threadID,
                currentWireThreadID: wireThreadID,
                onRollback: onRollback,
                workspaceRoot: workspaceRoot,
                alwaysExpandActivity: alwaysExpandActivity,
                onOpenThread: onOpenThread,
                onOpenFile: onOpenFile,
                onOpenURL: onOpenURL,
                onOpenDiff: onOpenDiff
            ),
            onLoadEarlier: onLoadEarlier,
            onDismissKeyboard: onDismissKeyboard,
            in: collectionView
        )
    }

    private static func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { _, environment in
            let width = environment.container.effectiveContentSize.width
            let sideInset = max(18, (width - T3Metrics.readingWidth) / 2)
            let itemSize = NSCollectionLayoutSize(
                widthDimension: .fractionalWidth(1),
                heightDimension: .estimated(120)
            )
            let item = NSCollectionLayoutItem(layoutSize: itemSize)
            let group = NSCollectionLayoutGroup.vertical(
                layoutSize: itemSize,
                subitems: [item]
            )
            let section = NSCollectionLayoutSection(group: group)
            // Zero, deliberately: every entry owns its own bottom margin
            // (`ChatTimelineStyle.entrySpacing`), and a divider that carries 16
            // on top of a section gap would sit at double the RN client's
            // rhythm.
            section.interGroupSpacing = 0
            section.contentInsets = NSDirectionalEdgeInsets(
                top: 18,
                leading: sideInset,
                bottom: 14,
                trailing: sideInset
            )
            return section
        }
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSourcePrefetching, UICollectionViewDelegate {
        private struct MarkdownPrefetch {
            let revision: MarkdownContentRevision
            let task: Task<Void, Never>
        }

        /// Everything a row needs beyond its own entry. Replaced on every
        /// update and never compared, so a fresh closure identity per SwiftUI
        /// body evaluation can't be mistaken for a content change.
        struct RowContext {
            var currentThreadID: String = ""
            var currentWireThreadID: String = ""
            var onRollback: (ThreadActivityRollbackTarget) -> Void = { _ in }
            var workspaceRoot: String?
            var alwaysExpandActivity = false
            var onOpenThread: (String) -> Void = { _ in }
            var onOpenFile: (ThreadActivityFileOpenRequest) -> Void = { _ in }
            var onOpenURL: (URL) -> Void = { _ in }
            var onOpenDiff: (String, String?) -> Void = { _, _ in }
        }

        private var dataSource: UICollectionViewDiffableDataSource<Section, String>?
        private var entriesByID: [String: ThreadTimelineEntry] = [:]
        private var orderedIDs: [String] = []
        private var currentThreadID: String?
        private var currentDetailRevision: UInt64?
        private var currentDynamicTypeSize: DynamicTypeSize?
        private var currentAlwaysExpandActivity = false
        private var currentIsWorking = false
        private var currentCanLoadEarlier = false
        private var currentIsLoadingEarlier = false
        private var markdownPrefetches: [String: MarkdownPrefetch] = [:]
        private var rowContext = RowContext()
        private var onLoadEarlier: (() -> Void)?
        private var onDismissKeyboard: (() -> Void)?

        deinit {
            markdownPrefetches.values.forEach { $0.task.cancel() }
        }

        func connect(to collectionView: UICollectionView) {
            let registration = UICollectionView.CellRegistration<UICollectionViewCell, String> {
                [weak self] cell, _, entryID in
                if entryID == FeatureTranscriptCollectionView.loadEarlierID {
                    cell.contentConfiguration = UIHostingConfiguration {
                        FeatureLoadEarlierTurnsButton(
                            isLoading: self?.currentIsLoadingEarlier == true,
                            onLoad: { self?.onLoadEarlier?() }
                        )
                        .padding(.bottom, ChatTimelineStyle.entrySpacing)
                    }
                    .margins(.all, 0)
                    cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
                    cell.accessibilityIdentifier = "load-earlier-turns"
                    return
                }
                if entryID == FeatureTranscriptCollectionView.workingIndicatorID {
                    cell.contentConfiguration = UIHostingConfiguration {
                        FeatureThreadWorkingIndicator()
                    }
                    .margins(.all, 0)
                    cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
                    cell.accessibilityIdentifier = "thread-working-indicator"
                    return
                }
                guard let self, let entry = entriesByID[entryID] else {
                    cell.contentConfiguration = nil
                    return
                }

                let context = rowContext
                cell.contentConfiguration = UIHostingConfiguration {
                    ThreadTimelineEntryView(
                        entry: entry,
                        currentThreadID: context.currentThreadID,
                        currentWireThreadID: context.currentWireThreadID,
                        onRollback: context.onRollback,
                        workspaceRoot: context.workspaceRoot,
                        alwaysExpandActivity: context.alwaysExpandActivity,
                        onOpenThread: context.onOpenThread,
                        onOpenFile: context.onOpenFile,
                        onOpenURL: context.onOpenURL,
                        onOpenDiff: context.onOpenDiff
                    )
                    // A recycled cell keeps the SwiftUI state of whatever it
                    // rendered last. Keying on the entry drops an expansion
                    // when the cell is reused for a different row, rather than
                    // showing it against the wrong one.
                    .id(entryID)
                }
                .margins(.all, 0)
                cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
                cell.accessibilityIdentifier = "message-cell-\(entryID)"
            }

            dataSource = UICollectionViewDiffableDataSource<Section, String>(
                collectionView: collectionView
            ) { collectionView, indexPath, entryID in
                collectionView.dequeueConfiguredReusableCell(
                    using: registration,
                    for: indexPath,
                    item: entryID
                )
            }
            collectionView.prefetchDataSource = self
            collectionView.delegate = self
        }

        func update(
            threadID: String,
            detail: FeatureThreadDetail,
            renderUpdate: FeatureDetailRenderUpdate?,
            dynamicTypeSize: DynamicTypeSize,
            isWorking: Bool,
            canLoadEarlier: Bool,
            isLoadingEarlier: Bool,
            alwaysExpandActivity: Bool,
            rowContext: RowContext,
            onLoadEarlier: @escaping () -> Void,
            onDismissKeyboard: @escaping () -> Void,
            in collectionView: UICollectionView
        ) {
            guard let dataSource else { return }
            self.rowContext = rowContext
            self.onLoadEarlier = onLoadEarlier
            self.onDismissKeyboard = onDismissKeyboard

            let threadChanged = currentThreadID != threadID
            let typeSizeChanged = currentDynamicTypeSize != dynamicTypeSize
            // Same treatment as the type size: it changes how every row renders
            // rather than what any row contains, so nothing else in this update
            // would report it.
            let expansionPreferenceChanged =
                currentAlwaysExpandActivity != alwaysExpandActivity
            let revisionChanged = currentDetailRevision != renderUpdate?.revision
            let workingChanged = currentIsWorking != isWorking
            let loadEarlierChanged = currentCanLoadEarlier != canLoadEarlier
                || currentIsLoadingEarlier != isLoadingEarlier
            guard threadChanged || typeSizeChanged || expansionPreferenceChanged
                || revisionChanged || workingChanged || loadEarlierChanged else { return }

            // Always the whole feed. An item's shape depends on its neighbours —
            // a new tool call joins the work group above it, a subagent card
            // merges into the run beside it — so a delta that only names changed
            // messages cannot say which rows moved, and applying it would leave
            // stale groups on screen instead of failing loudly.
            let state = entryState(ThreadTimelineFeed.entries(for: detail))
            let newIDs = state.ids
            let idsChanged = state.idsChanged
            let changedIDs = typeSizeChanged || expansionPreferenceChanged
                ? newIDs
                : state.changedIDs

            currentDetailRevision = renderUpdate?.revision
            currentDynamicTypeSize = dynamicTypeSize
            currentAlwaysExpandActivity = alwaysExpandActivity
            currentIsWorking = isWorking
            currentCanLoadEarlier = canLoadEarlier
            currentIsLoadingEarlier = isLoadingEarlier
            guard threadChanged || idsChanged || !changedIDs.isEmpty || workingChanged
                || loadEarlierChanged else { return }

            if threadChanged {
                cancelAllMarkdownPrefetches()
            } else {
                var invalidatedIDs = Set(changedIDs)
                if idsChanged, !state.isAppendOnly {
                    invalidatedIDs.formUnion(Set(orderedIDs).subtracting(newIDs))
                }
                cancelMarkdownPrefetches(for: invalidatedIDs)
            }

            let wasNearBottom = isNearBottom(collectionView)
            let lastIDChanged = orderedIDs.last != newIDs.last || workingChanged
            let isInitialLoad = currentThreadID == nil || threadChanged
            let previousIDs = orderedIDs
            let prependedMessages = !threadChanged
                && newIDs.count > previousIDs.count
                && Array(newIDs.suffix(previousIDs.count)) == previousIDs
            let shouldFollowBottom = isInitialLoad || wasNearBottom
            let prependAnchor = !shouldFollowBottom
                && (prependedMessages || (loadEarlierChanged && !canLoadEarlier))
                ? visibleAnchor(in: collectionView, dataSource: dataSource)
                : nil

            currentThreadID = threadID
            entriesByID = state.entriesByID
            orderedIDs = newIDs
            (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor =
                isInitialLoad || wasNearBottom

            var snapshot: NSDiffableDataSourceSnapshot<Section, String>
            if threadChanged || loadEarlierChanged {
                snapshot = NSDiffableDataSourceSnapshot<Section, String>()
                snapshot.appendSections([.transcript])
                if canLoadEarlier {
                    snapshot.appendItems(
                        [FeatureTranscriptCollectionView.loadEarlierID],
                        toSection: .transcript
                    )
                }
                snapshot.appendItems(newIDs, toSection: .transcript)
            } else if !idsChanged {
                snapshot = dataSource.snapshot()
            } else if state.isAppendOnly {
                snapshot = dataSource.snapshot()
                snapshot.appendItems(state.appendedIDs, toSection: .transcript)
            } else {
                snapshot = NSDiffableDataSourceSnapshot<Section, String>()
                snapshot.appendSections([.transcript])
                if canLoadEarlier {
                    snapshot.appendItems(
                        [FeatureTranscriptCollectionView.loadEarlierID],
                        toSection: .transcript
                    )
                }
                snapshot.appendItems(newIDs, toSection: .transcript)
            }
            if snapshot.indexOfItem(FeatureTranscriptCollectionView.workingIndicatorID) != nil {
                snapshot.deleteItems([FeatureTranscriptCollectionView.workingIndicatorID])
            }
            if isWorking {
                snapshot.appendItems(
                    [FeatureTranscriptCollectionView.workingIndicatorID],
                    toSection: .transcript
                )
            }
            let appendedIDSet = Set(state.appendedIDs)
            var reconfiguredIDs = changedIDs.filter { !appendedIDSet.contains($0) }
            if loadEarlierChanged,
               snapshot.indexOfItem(FeatureTranscriptCollectionView.loadEarlierID) != nil {
                reconfiguredIDs.append(FeatureTranscriptCollectionView.loadEarlierID)
            }
            if !reconfiguredIDs.isEmpty {
                snapshot.reconfigureItems(reconfiguredIDs)
            }

            dataSource.apply(snapshot, animatingDifferences: false) {
                [weak self, weak collectionView] in
                guard let self, let collectionView else { return }
                DispatchQueue.main.async {
                    if shouldFollowBottom {
                        self.scrollToBottom(
                            collectionView,
                            animated: !isInitialLoad && lastIDChanged
                        )
                    } else if let prependAnchor {
                        self.restore(prependAnchor, in: collectionView, dataSource: dataSource)
                    }
                }
            }
        }

        private struct VisibleAnchor {
            let id: String
            let offsetFromViewportTop: CGFloat
        }

        private func visibleAnchor(
            in collectionView: UICollectionView,
            dataSource: UICollectionViewDiffableDataSource<Section, String>
        ) -> VisibleAnchor? {
            for indexPath in collectionView.indexPathsForVisibleItems.sorted() {
                guard let id = dataSource.itemIdentifier(for: indexPath),
                      id != FeatureTranscriptCollectionView.loadEarlierID,
                      id != FeatureTranscriptCollectionView.workingIndicatorID,
                      let attributes = collectionView.layoutAttributesForItem(at: indexPath) else {
                    continue
                }
                return VisibleAnchor(
                    id: id,
                    offsetFromViewportTop: attributes.frame.minY - collectionView.contentOffset.y
                )
            }
            return nil
        }

        private func restore(
            _ anchor: VisibleAnchor,
            in collectionView: UICollectionView,
            dataSource: UICollectionViewDiffableDataSource<Section, String>
        ) {
            collectionView.layoutIfNeeded()
            guard let indexPath = dataSource.indexPath(for: anchor.id),
                  let attributes = collectionView.layoutAttributesForItem(at: indexPath) else {
                return
            }
            let minimumY = -collectionView.adjustedContentInset.top
            let maximumY = max(
                minimumY,
                collectionView.contentSize.height
                    - collectionView.bounds.height
                    + collectionView.adjustedContentInset.bottom
            )
            let targetY = min(
                maximumY,
                max(minimumY, attributes.frame.minY - anchor.offsetFromViewportTop)
            )
            (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = false
            collectionView.setContentOffset(
                CGPoint(x: collectionView.contentOffset.x, y: targetY),
                animated: false
            )
        }

        private struct EntryState {
            let ids: [String]
            let entriesByID: [String: ThreadTimelineEntry]
            let changedIDs: [String]
            let appendedIDs: [String]
            let idsChanged: Bool
            /// The new order is the old one plus a tail, so the snapshot can be
            /// extended rather than rebuilt.
            var isAppendOnly: Bool { !appendedIDs.isEmpty }
        }

        private func entryState(_ entries: [ThreadTimelineEntry]) -> EntryState {
            let ids = entries.map(\.id)
            var updated: [String: ThreadTimelineEntry] = [:]
            updated.reserveCapacity(entries.count)
            for entry in entries { updated[entry.id] = entry }
            let idsChanged = orderedIDs != ids
            return EntryState(
                ids: ids,
                entriesByID: updated,
                changedIDs: ids.filter { entriesByID[$0] != updated[$0] },
                appendedIDs: idsChanged && ids.starts(with: orderedIDs)
                    ? Array(ids.dropFirst(orderedIDs.count))
                    : [],
                idsChanged: idsChanged
            )
        }

        /// The message behind an entry, or nil for a row that renders no
        /// Markdown and therefore has nothing worth warming.
        private func prefetchableMessage(for entryID: String) -> FeatureMessage? {
            guard case let .message(message) = entriesByID[entryID],
                  !message.text.isEmpty,
                  message.state != .streaming,
                  message.role == .user || message.role == .assistant else {
                return nil
            }
            return message
        }

        func collectionView(
            _ collectionView: UICollectionView,
            prefetchItemsAt indexPaths: [IndexPath]
        ) {
            // Through the data source rather than by index: the load-earlier
            // cell shifts every row, so `orderedIDs[indexPath.item]` names the
            // wrong entry as soon as a thread has more history.
            for indexPath in indexPaths {
                guard let entryID = dataSource?.itemIdentifier(for: indexPath),
                      markdownPrefetches[entryID] == nil,
                      let message = prefetchableMessage(for: entryID) else {
                    continue
                }

                let revision = MarkdownContentRevision(message.text)
                guard MarkdownRenderCache.shared.cachedDocument(for: revision) == nil else {
                    continue
                }

                let task = Task { [weak self] in
                    guard !Task.isCancelled else { return }
                    _ = await MarkdownRenderCache.shared.document(for: revision)
                    guard !Task.isCancelled else { return }
                    self?.finishMarkdownPrefetch(messageID: entryID, revision: revision)
                }
                markdownPrefetches[entryID] = MarkdownPrefetch(
                    revision: revision,
                    task: task
                )
            }
        }

        func collectionView(
            _ collectionView: UICollectionView,
            cancelPrefetchingForItemsAt indexPaths: [IndexPath]
        ) {
            let entryIDs = indexPaths.compactMap { dataSource?.itemIdentifier(for: $0) }
            cancelMarkdownPrefetches(for: Set(entryIDs))
        }

        private func finishMarkdownPrefetch(
            messageID: String,
            revision: MarkdownContentRevision
        ) {
            guard markdownPrefetches[messageID]?.revision == revision else { return }
            markdownPrefetches.removeValue(forKey: messageID)
        }

        private func cancelMarkdownPrefetches(for messageIDs: Set<String>) {
            for messageID in messageIDs {
                markdownPrefetches.removeValue(forKey: messageID)?.task.cancel()
            }
        }

        private func cancelAllMarkdownPrefetches() {
            markdownPrefetches.values.forEach { $0.task.cancel() }
            markdownPrefetches.removeAll(keepingCapacity: true)
        }

        private func isNearBottom(_ collectionView: UICollectionView) -> Bool {
            let visibleBottom = collectionView.contentOffset.y
                + collectionView.bounds.height
                - collectionView.adjustedContentInset.bottom
            return collectionView.contentSize.height - visibleBottom < 120
        }

        private func scrollToBottom(
            _ collectionView: UICollectionView,
            animated: Bool
        ) {
            collectionView.layoutIfNeeded()
            let geometry = TranscriptViewportGeometry(
                contentHeight: collectionView.contentSize.height,
                viewportHeight: collectionView.bounds.height,
                topInset: collectionView.adjustedContentInset.top,
                bottomInset: collectionView.adjustedContentInset.bottom
            )
            let target = CGPoint(x: collectionView.contentOffset.x, y: geometry.bottomOffset)
            collectionView.setContentOffset(target, animated: animated)
            (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = true
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            (scrollView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = false
            scrollView.window?.endEditing(false)
            onDismissKeyboard?()
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            guard !decelerate else { return }
            updateBottomAnchor(for: scrollView)
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
            updateBottomAnchor(for: scrollView)
        }

        private func updateBottomAnchor(for scrollView: UIScrollView) {
            guard let collectionView = scrollView as? BottomAnchoredTranscriptCollectionView else {
                return
            }
            collectionView.maintainsBottomAnchor = isNearBottom(collectionView)
        }
    }
}

private struct FeatureLoadEarlierTurnsButton: View {
    let isLoading: Bool
    let onLoad: () -> Void

    var body: some View {
        Button(action: onLoad) {
            HStack(spacing: 7) {
                if isLoading {
                    Image(systemName: "ellipsis")
                        .font(T3Typography.supporting.weight(.semibold))
                }
                Text(isLoading ? "Loading earlier turns…" : "Load earlier turns")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: T3Metrics.minimumTapTarget)
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .accessibilityLabel(isLoading ? "Loading earlier turns" : "Load earlier turns")
    }
}

private struct FeatureThreadWorkingIndicator: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "circle.dotted")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(T3Colors.statusRunning)
                .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: 2) {
                Text("Agent is working")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.statusRunning)
                Text("New output will appear here")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Agent is working. New output will appear here.")
    }
}

struct TranscriptViewportGeometry: Equatable {
    let contentHeight: CGFloat
    let viewportHeight: CGFloat
    let topInset: CGFloat
    let bottomInset: CGFloat

    var bottomOffset: CGFloat {
        max(-topInset, contentHeight - viewportHeight + bottomInset)
    }

    func restoredBottomOffset(
        after previous: Self?,
        maintainsBottomAnchor: Bool,
        isInteracting: Bool
    ) -> CGFloat? {
        guard maintainsBottomAnchor, !isInteracting else {
            return nil
        }

        guard let previous,
              previous.contentHeight > 0,
              previous.viewportHeight > 0 else {
            return contentHeight > 0 && viewportHeight > 0 ? bottomOffset : nil
        }

        let contentChanged = abs(contentHeight - previous.contentHeight) > 0.5
        let viewportChanged = abs(viewportHeight - previous.viewportHeight) > 0.5
            || abs(bottomInset - previous.bottomInset) > 0.5
        guard contentChanged || viewportChanged else { return nil }

        return bottomOffset
    }
}

/// Self-sizing hosted Markdown can change the transcript height after a snapshot finishes,
/// while presenting the keyboard changes the viewport without changing the content at all.
/// Preserve the visual bottom only while the reader is already following the latest turn.
private final class BottomAnchoredTranscriptCollectionView: UICollectionView {
    var maintainsBottomAnchor = false

    private var lastLaidOutGeometry: TranscriptViewportGeometry?
    private var isRestoringBottomAnchor = false

    override func layoutSubviews() {
        super.layoutSubviews()

        let geometry = TranscriptViewportGeometry(
            contentHeight: contentSize.height,
            viewportHeight: bounds.height,
            topInset: adjustedContentInset.top,
            bottomInset: adjustedContentInset.bottom
        )
        defer { lastLaidOutGeometry = geometry }

        guard let bottomY = geometry.restoredBottomOffset(
            after: lastLaidOutGeometry,
            maintainsBottomAnchor: maintainsBottomAnchor,
            isInteracting: isDragging || isDecelerating || isRestoringBottomAnchor
        ) else {
            return
        }
        guard abs(contentOffset.y - bottomY) > 0.5 else { return }

        isRestoringBottomAnchor = true
        contentOffset = CGPoint(x: contentOffset.x, y: bottomY)
        isRestoringBottomAnchor = false
    }
}

private struct FeatureRemoteAttachmentThumbnail: View {
    private struct Request: Hashable {
        let url: URL
        let maximumPixelSize: Int
    }

    @SwiftUI.Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var loadedRequest: Request?
    @State private var failedRequest: Request?

    let url: URL

    var body: some View {
        Group {
            if loadedRequest == request, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if failedRequest == request {
                placeholder(systemImage: "exclamationmark.triangle")
            } else {
                placeholder(systemImage: "photo")
            }
        }
        .accessibilityHidden(true)
        .task(id: request) {
            let activeRequest = request
            do {
                let image = try await FeatureAttachmentThumbnailLoader.image(
                    for: activeRequest.url,
                    maximumPixelSize: activeRequest.maximumPixelSize
                )
                try Task.checkCancellation()
                self.image = image
                loadedRequest = activeRequest
                failedRequest = nil
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                image = nil
                loadedRequest = nil
                failedRequest = activeRequest
            }
        }
    }

    private var request: Request {
        Request(
            url: url,
            maximumPixelSize: min(768, max(190, Int(ceil(190 * displayScale))))
        )
    }

    private func placeholder(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Local preview bytes routed through the shared thumbnail cache so streaming
/// reconfigures of a message with attachments never re-allocate UIImages in
/// body. Decode happens once, off the main thread.
private struct FeatureLocalAttachmentThumbnail: View {
    let attachmentID: String
    let previewData: Data

    @State private var image: UIImage?
    @State private var failed = false

    private var cacheKey: NSString { "local:\(attachmentID)" as NSString }

    var body: some View {
        Group {
            if let image = image ?? FeatureAttachmentThumbnailCache.shared.image(for: cacheKey) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if failed {
                placeholder(systemImage: "exclamationmark.triangle")
            } else {
                placeholder(systemImage: "photo")
            }
        }
        .accessibilityHidden(true)
        .task(id: attachmentID) {
            guard FeatureAttachmentThumbnailCache.shared.image(for: cacheKey) == nil else { return }
            let data = previewData
            let decoded = await Task.detached(priority: .utility) {
                UIImage(data: data)
            }.value
            guard !Task.isCancelled else { return }
            if let decoded {
                FeatureAttachmentThumbnailCache.shared.insert(decoded, for: cacheKey)
                image = decoded
            } else {
                failed = true
            }
        }
    }

    private func placeholder(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private enum FeatureAttachmentThumbnailLoader {
    static func image(for url: URL, maximumPixelSize: Int) async throws -> UIImage {
        let cacheKey = "\(url.absoluteString)#\(maximumPixelSize)" as NSString
        if let cached = FeatureAttachmentThumbnailCache.shared.image(for: cacheKey) {
            return cached
        }

        let (data, response) = try await URLSession.shared.data(from: url)
        try Task.checkCancellation()
        if let response = response as? HTTPURLResponse,
           !(200...299).contains(response.statusCode) {
            throw FeatureAttachmentThumbnailError.invalidResponse
        }

        let image = try await Task.detached(priority: .utility) {
            try downsample(data: data, maximumPixelSize: maximumPixelSize)
        }.value
        try Task.checkCancellation()
        FeatureAttachmentThumbnailCache.shared.insert(image, for: cacheKey)
        return image
    }

    private static func downsample(data: Data, maximumPixelSize: Int) throws -> UIImage {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            throw FeatureAttachmentThumbnailError.decodingFailed
        }

        let thumbnailOptions = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            thumbnailOptions
        ) else {
            throw FeatureAttachmentThumbnailError.decodingFailed
        }
        return UIImage(cgImage: thumbnail)
    }
}

private final class FeatureAttachmentThumbnailCache: @unchecked Sendable {
    static let shared = FeatureAttachmentThumbnailCache()

    private let images = NSCache<NSString, UIImage>()

    private init() {
        images.countLimit = 96
        images.totalCostLimit = 32 * 1_024 * 1_024
    }

    func image(for key: NSString) -> UIImage? {
        images.object(forKey: key)
    }

    func insert(_ image: UIImage, for key: NSString) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        images.setObject(image, forKey: key, cost: cost)
    }
}

private enum FeatureAttachmentThumbnailError: Error {
    case invalidResponse
    case decodingFailed
}

struct FeatureMessageView: View {
    let message: FeatureMessage

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 44)
                VStack(alignment: .leading, spacing: 10) {
                    FeatureMessageAttachmentsView(attachments: message.attachments)
                    if !message.text.isEmpty {
                        MarkdownMessageView(
                            message.text,
                            isStreaming: message.state == .streaming
                        )
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(maxWidth: T3Metrics.readingWidth * 0.88, alignment: .leading)
                .background(
                    T3Colors.subtleStrong,
                    in: UnevenRoundedRectangle(
                        topLeadingRadius: 16,
                        bottomLeadingRadius: 16,
                        bottomTrailingRadius: 4,
                        topTrailingRadius: 16
                    )
                )
            }
            .accessibilityLabel("You")
            .accessibilityValue(accessibilityValue)
            .accessibilityIdentifier("message-\(message.id)")
        case .assistant:
            VStack(alignment: .leading, spacing: 10) {
                if message.state == .streaming {
                    HStack(spacing: 6) {
                        Image(systemName: "circle.dotted")
                        Text("Working")
                    }
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.statusRunning)
                }
                FeatureMessageAttachmentsView(attachments: message.attachments)
                if !message.text.isEmpty {
                    MarkdownMessageView(
                        message.text,
                        isStreaming: message.state == .streaming
                    )
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("message-\(message.id)")
        case .tool:
            DisclosureGroup {
                Text(message.text)
                    .font(T3Typography.tool)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(.top, 8)
            } label: {
                Label(message.toolName ?? "Tool output", systemImage: "terminal")
                    .font(T3Typography.tool.weight(.medium))
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .padding(.vertical, 6)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .accessibilityIdentifier("message-\(message.id)")
        case .system:
            Text(message.text)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .accessibilityIdentifier("message-\(message.id)")
        }
    }

    private var accessibilityValue: String {
        let attachmentSummary = message.attachments.isEmpty
            ? ""
            : "\(message.attachments.count) image attachment"
                + (message.attachments.count == 1 ? "" : "s")
        return [message.text, attachmentSummary]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

private struct FeatureMessageAttachmentsView: View {
    let attachments: [FeatureMessageAttachment]
    @State private var previewedAttachment: FeatureMessageAttachment?

    var body: some View {
        if !attachments.isEmpty {
            LazyVGrid(
                columns: [
                    GridItem(.adaptive(minimum: 118, maximum: 190), spacing: 7),
                ],
                alignment: .leading,
                spacing: 7
            ) {
                ForEach(attachments) { attachment in
                    VStack(alignment: .leading, spacing: 6) {
                        if attachment.mimeType.hasPrefix("image/") {
                            Group {
                                if let previewData = attachment.previewData {
                                    FeatureLocalAttachmentThumbnail(
                                        attachmentID: attachment.id,
                                        previewData: previewData
                                    )
                                } else if let url = attachment.url {
                                    FeatureRemoteAttachmentThumbnail(url: url)
                                } else {
                                    attachmentPlaceholder(systemImage: "photo")
                                }
                            }
                            .frame(height: 160)
                            .frame(maxWidth: .infinity)
                            .background(T3Colors.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }

                        HStack(spacing: 9) {
                            Image(
                                systemName: attachment.mimeType.hasPrefix("image/")
                                    ? "photo"
                                    : "doc"
                            )
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(T3Colors.textSecondary)
                            .frame(width: 30, height: 30)
                            .background(
                                T3Colors.surfaceRaised,
                                in: RoundedRectangle(cornerRadius: 6)
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text(attachment.name)
                                    .font(T3Typography.control)
                                    .lineLimit(1)
                                Text(
                                    ByteCountFormatter.string(
                                        fromByteCount: Int64(attachment.sizeBytes),
                                        countStyle: .file
                                    )
                                )
                                .font(T3Typography.supporting.monospacedDigit())
                                .foregroundStyle(T3Colors.textSecondary)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(7)
                    .overlay {
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(T3Colors.border, lineWidth: 1)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        attachment.mimeType.hasPrefix("image/")
                            ? "Image attachment"
                            : "File attachment"
                    )
                    .accessibilityValue(attachmentAccessibilityValue(attachment))
                    .accessibilityIdentifier("attachment-\(attachment.id)")
                    .accessibilityAddTraits(
                        attachment.mimeType.hasPrefix("image/") && attachment.url != nil
                            ? .isButton
                            : []
                    )
                    .accessibilityHint(
                        attachment.mimeType.hasPrefix("image/") && attachment.url != nil
                            ? "Opens full-screen preview"
                            : ""
                    )
                    .accessibilityAction {
                        if attachment.mimeType.hasPrefix("image/"), attachment.url != nil {
                            previewedAttachment = attachment
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if attachment.mimeType.hasPrefix("image/"), attachment.url != nil {
                            previewedAttachment = attachment
                        }
                    }
                }
            }
            .fullScreenCover(item: $previewedAttachment) { attachment in
                FeatureAttachmentPreview(attachment: attachment)
            }
        }
    }

    private func attachmentPlaceholder(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func attachmentAccessibilityValue(
        _ attachment: FeatureMessageAttachment
    ) -> String {
        let size = ByteCountFormatter.string(
            fromByteCount: Int64(attachment.sizeBytes),
            countStyle: .file
        )
        return "\(attachment.name), \(size)"
    }
}

private struct FeatureAttachmentPreview: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let attachment: FeatureMessageAttachment

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let url = attachment.url {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFit()
                        case .failure:
                            ContentUnavailableView(
                                "Image unavailable",
                                systemImage: "exclamationmark.triangle"
                            )
                        case .empty:
                            ProgressView()
                        @unknown default:
                            ProgressView()
                        }
                    }
                    .padding(12)
                }
            }
            .navigationTitle(attachment.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .t3NavigationChrome()
        }
        .preferredColorScheme(.dark)
    }
}
