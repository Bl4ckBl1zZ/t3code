import SwiftUI
import UIKit

public struct ThreadDetailView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @Bindable var model: FeatureRootModel
    let thread: FeatureThread
    let submitMessage: (FeatureMessageSubmission) async -> Bool
    /// Opening a related thread — a subagent card, a fork divider, a lineage row
    /// — is the navigator's job: this view is inside someone else's stack and
    /// only reports which thread was asked for. `isArchived` routes to the
    /// archive, which is the only place an archived thread can be shown.
    let onOpenRelatedThread: (_ threadID: String, _ isArchived: Bool) -> Void
    /// Leaves this thread once it no longer exists, such as after Delete. The
    /// system back button covers ordinary navigation.
    let onNavigateBack: () -> Void
    @State private var nativeToolIcons = NativeAppToolIconStore()
    @State private var isSwappingDraft = false
    private let draftStore: FeatureComposerDraftStore

    @SwiftUI.Environment(\.openURL) private var openURL

    @State private var lastPullRequestPrompt: String?
    @State private var pullRequestCheckoutWarning: String?
    @State private var citationPreview: AssistantCitation?
    @State private var citationError: String?
    @State private var draft = ""
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var bannerHeight: CGFloat = 0
    /// The glass composer floats over the transcript instead of displacing it,
    /// so the transcript needs its measured height as a bottom content inset.
    @State private var composerHeight: CGFloat = 0
    /// A provider change the user has sent but the server has not yet reflected
    /// in a run. See `pendingHandoffItem`.
    @State private var pendingProviderSwitch: PendingProviderSwitch?
    @State private var isSending = false
    /// Previous/next turn, from the keyboard shortcuts and the transcript's
    /// accessibility actions.
    @State private var turnNavigationRequest = 0
    @State private var scrollToLatestRequest = 0
    /// Something landed below while the reader was scrolled into history.
    @State private var hasActivityBelow = false
    /// The first load of a thread with nothing cached. A cached thread renders
    /// at once and refreshes under the reader, so this never covers content.
    @State private var isLoading = true
    @State private var isRetryingLoad = false
    /// Drives the subtitle's working duration, which only moves by minutes.
    @State private var subtitleNow = Date()
    @State private var isConfirmingUnpin = false
    @State private var pullRequestPreview: PullRequestLinkTarget?
    /// The provider's answer to `/feedback`: the id it filed the report under,
    /// which is the only handle the reader has for quoting it later.
    @State private var feedbackReceipt: String?
    @State private var feedbackFailure: String?
    @State private var workConversationFailure: String?
    @State private var didRestoreDraft = false
    /// This thread was entered while its creation was still in the outbox, so
    /// its optimistic transcript is already on screen and the load that follows
    /// delivery is a swap rather than an opening.
    @State private var openedFromOutbox = false
    @State private var draftSaveTask: Task<Void, Never>?
    @State private var toolSurface: FeatureThreadToolSurface?
    /// A pending checkpoint restore, previewed in a sheet before it commits.
    @State private var restoreRequest: CheckpointRestoreRequest?
    /// The queued run a reorder, edit or cancel is in flight for. One at a time:
    /// two overlapping reorders would race for the same positions.
    @State private var queueBusyRunID: String?
    @FocusState private var composerFocused: Bool
    @State private var readingHistoryThreadID: String?

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

    private var nativeToolIconContext: NativeAppToolIconContext? {
        guard let environmentID = threadEnvironment?.id ?? currentThread.environmentID,
            let client = model.client as? any FeatureNativeAppIconResolving else { return nil }
        return NativeAppToolIconContext(environmentID: environmentID, store: nativeToolIcons, client: client)
    }

    public var body: some View {
        threadContent
        .onChange(of: model.pendingPullRequestPrompts[thread.id]?.id) { consumePullRequestPrompt() }
        .alert("Pull request checkout", isPresented: Binding(get: { pullRequestCheckoutWarning != nil }, set: { if !$0 { pullRequestCheckoutWarning = nil } })) {
            Button("OK") { pullRequestCheckoutWarning = nil }
        } message: { Text(pullRequestCheckoutWarning ?? "") }
        .onChange(of: isSending) { if !isSending { consumePullRequestPrompt() } }
        .onChange(of: isSwappingDraft) { if !isSwappingDraft { consumePullRequestPrompt() } }
    }

    /// The screen and its bars. Split from `threadContent` so neither
    /// modifier chain is long enough to stall the type checker.
    private var threadChrome: some View {
        Group {
            // One branch for loading and loaded, so the bar and composer the
            // reader already sees are not rebuilt when the transcript lands.
            if detail != nil || isLoading {
                timeline(detail ?? FeatureThreadDetail(thread: currentThread), isLoading: detail == nil)
            } else {
                unavailableView
            }
        }
        .background(T3Colors.background)
        .environment(\.nativeAppToolIconContext, nativeToolIconContext)
        .navigationTitle(currentThread.title)
        .navigationBarTitleDisplayMode(.inline)
        .modifier(ThreadHeaderModifier(title: currentThread.title, subtitle: headerSubtitle))
        .t3NavigationChrome()
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    toolSurface = .details
                } label: {
                    Label("Thread Details", systemImage: "info.circle")
                }
                .accessibilityIdentifier("thread-details-button")
                threadActionsMenu
            }
        }
        .background { keyboardShortcuts }
        .confirmationDialog("Unpin this thread?", isPresented: $isConfirmingUnpin, titleVisibility: .visible) {
            Button("Unpin", role: .destructive) { setPinned(false) }
        }
        .sheet(item: $pullRequestPreview) { target in
            if let context = pullRequestContext {
                PullRequestLinkPreview(target: target, context: context)
            }
        }
    }

    private var threadContent: some View {
        threadChrome
        .task(id: "\(currentThread.projectID):\(currentSelection?.providerID ?? ""):\(threadWorkspaceRoot ?? "")") {
            guard let instanceID = currentSelection?.providerID,
                  threadProviders.first(where: { $0.id == instanceID })?.driver == "antigravity" else { return }
            try? await model.client.refreshProviderWorkspace(projectID: currentThread.projectID, instanceID: instanceID, cwd: threadWorkspaceRoot)
        }
        .task(id: draftKey) {
            for await key in await draftStore.discardedDrafts() where key == draftKey {
                draftSaveTask?.cancel()
                draft = ""
                attachments = []
            }
        }
        // Keyed on the creation phase as well as the id: a thread started on
        // this device opens straight from the outbox, and only becomes
        // loadable — transcript and live stream — once its creation reaches
        // the server. That second pass swaps the optimistic transcript for the
        // real one without an opening spinner over content already on screen,
        // and leaves the draft alone so it cannot overwrite what was typed
        // while creation was in flight.
        //
        // A detail cached from an earlier visit renders immediately; the
        // forced refresh then lands in place rather than behind a spinner.
        .task(id: threadLoadPhase) {
            let restoreBaseline = composerDraft
            let restoreKey = draftKey
            openedFromOutbox = openedFromOutbox || model.isAwaitingCreation(thread.id)
            isLoading = detail == nil && !openedFromOutbox
            _ = await model.detail(for: thread.id, force: true)
            if !didRestoreDraft {
                await restoreDraft(from: restoreBaseline, key: restoreKey)
            }
            isLoading = false
        }
        // The subtitle reports the working time in minutes, so it wakes once a
        // minute while a turn runs and never otherwise.
        .task(id: subtitleClockStart) {
            guard let start = subtitleClockStart else { return }
            while !Task.isCancelled {
                subtitleNow = .now
                let intoMinute = Date.now.timeIntervalSince(start).truncatingRemainder(dividingBy: 60)
                try? await Task.sleep(for: .seconds(max(1, 60 - intoMinute)))
            }
        }
        .onChange(of: currentThread.state == .failed) { _, failed in
            if failed { PlatformHapticEngine.shared.play(.error) }
        }
        .onChange(of: hasFailedDelivery) { _, failed in
            if failed { PlatformHapticEngine.shared.play(.error) }
        }
        .onChange(of: composerFocused) { if composerFocused { readingHistoryThreadID = nil } }
        .onChange(of: draft) { scheduleDraftSave() }
        .onChange(of: attachments) { scheduleDraftSave() }
        .onDisappear {
            model.releaseThread(thread.id)
            persistDraftBeforeLeaving()
        }
        .sheet(item: $citationPreview) { citation in
            AssistantCitationPreview(citation: citation) { openCitationSource(citation) }
        }
        .alert("Quote Unavailable", isPresented: Binding(get: { citationError != nil }, set: { if !$0 { citationError = nil } })) {
            Button("OK") { citationError = nil }
        } message: { Text(citationError ?? "") }
        .sheet(item: $restoreRequest) { request in
            CheckpointRestoreSheet(
                request: request,
                isWorking: currentThread.state == .working || currentThread.state == .queued,
                onInterrupt: {
                    Task { await model.cancelTurn(threadID: thread.id) }
                },
                onRestore: {
                    try await model.client.rollBackToCheckpoint(
                        threadID: request.target.threadID,
                        scopeID: request.target.scopeID,
                        checkpointID: request.target.checkpointID
                    )
                    _ = await model.detail(for: thread.id, force: true)
                }
            )
        }
        .sheet(item: $toolSurface) { surface in
            if let tool = surface.tool {
                // A deep link from the transcript: the tool on its own, at the
                // place the link named. From Details the same tools push.
                NavigationStack {
                    workspaceToolView(tool)
                        .t3SheetToolbar(.close)
                }
                .presentationDetents([.large])
            } else {
                ThreadDetailsSheet(
                    thread: currentThread,
                    environment: threadEnvironment,
                    project: threadProject,
                    client: model.client,
                    onExit: exitFromDetails,
                    onReconnect: {
                        guard let environmentID = threadEnvironment?.id else { return }
                        Task { _ = await model.activateEnvironment(environmentID) }
                    },
                    // The project's actions, listed as run rows under
                    // Workspace beside Files and Terminal.
                    scripts: threadProject?.scripts ?? [],
                    onRunScript: runProjectScript,
                    // The same projection the transcript renders, so the
                    // sheet's Background Tasks and Lineage sections cannot
                    // disagree with the rows above them.
                    turnItems: detail?.timelineItems.map(\.item) ?? [],
                    relationships: relationships,
                    onMergeBack: detailsMergeBack,
                    onDetachSession: {
                        try await model.client.stopThreadSession(threadID: thread.id)
                        _ = await model.detail(for: thread.id, force: true)
                    },
                    onTogglePin: {
                        Task {
                            await model.setPinned(
                                thread.id,
                                pinned: currentThread.pinnedAt == nil
                            )
                        }
                    },
                    confirmThreadUnpin: model.snapshot.settings.confirmThreadUnpin,
                    onReload: {
                        _ = await model.detail(for: thread.id, force: true)
                    },
                    onToggleArchive: {
                        // Dismiss first: an archived thread leaves the
                        // stack this sheet is presented over.
                        toolSurface = nil
                        Task {
                            await model.setArchived(
                                thread.id,
                                archived: !currentThread.isArchived
                            )
                        }
                    },
                    onRename: { title in
                        Task { await model.renameThread(thread.id, title: title) }
                    },
                    onDelete: {
                        toolSurface = nil
                        Task {
                            if await model.deleteThread(thread.id) { onNavigateBack() }
                        }
                    },
                    isChatConversation: currentThread.workInboxRole == "chat",
                    isHermesConversation: ModelOptions.isHermesProvider(currentThread.providerID, in: environmentProviders),
                    activeProviderSessionID: detail?.workflow.providerSession?.id,
                    toolView: workspaceToolView
                )
            }
        }
        .alert(
            "Feedback sent",
            isPresented: Binding(
                get: { feedbackReceipt != nil },
                set: { if !$0 { feedbackReceipt = nil } }
            )
        ) {
            Button("Copy ID") {
                UIPasteboard.general.string = feedbackReceipt
                feedbackReceipt = nil
                T3HUD.show("Copied", systemImage: "doc.on.doc")
            }
            Button("Done", role: .cancel) { feedbackReceipt = nil }
        } message: {
            Text(feedbackReceipt.map { "Thread ID: \($0)" } ?? "")
        }
        .alert(
            "Feedback Not Sent",
            isPresented: Binding(
                get: { feedbackFailure != nil },
                set: { if !$0 { feedbackFailure = nil } }
            )
        ) {
            Button("OK") { feedbackFailure = nil }
        } message: {
            Text(feedbackFailure ?? "")
        }
        .alert("Couldn't Start Conversation", isPresented: Binding(get: { workConversationFailure != nil }, set: { if !$0 { workConversationFailure = nil } })) {
            Button("OK") { workConversationFailure = nil }
        } message: { Text(workConversationFailure ?? "") }
    }

    private var detail: FeatureThreadDetail? {
        model.details[thread.id]
    }

    private var currentThread: FeatureThread {
        detail?.thread ?? thread
    }

    /// Identifies what can be loaded for this thread right now. A thread still
    /// queued in the outbox exists only on this device, so the phase changes —
    /// and the load runs — when the server takes it over.
    private var threadLoadPhase: String {
        model.isAwaitingCreation(thread.id) ? "\(thread.id)#queued" : thread.id
    }

    /// The turn in flight, resolved once for the two surfaces that report it:
    /// the composer's status band and the header beside the branch.
    private var workingStatus: ThreadWorkingStatus? {
        guard let detail else { return nil }
        return ThreadWorkingStatus.resolve(
            state: detail.thread.state,
            workingStartedAt: detail.thread.workingStartedAt,
            timelineItems: detail.timelineItems,
            activeRunID: queueState.activeRun?.id,
            isPreparingWorkspace: queueState.activeRun?.status == "preparing",
            activityText: detail.workflow.providerSession.flatMap { session in
                ["stopped", "error"].contains(session.status) ? nil : session.activityText
            }
        )
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

    // MARK: - Header

    private var headerSubtitle: ThreadHeaderSubtitle {
        ThreadHeaderSubtitle.resolve(
            thread: currentThread,
            environmentName: currentThread.homeEnvironmentLabel(in: model.snapshot),
            connection: threadConnectionState,
            now: subtitleNow
        )
    }

    /// When the subtitle's working clock starts, or nil when there is no clock
    /// to keep: the thread is not working, or the server has not said since
    /// when.
    private var subtitleClockStart: Date? {
        currentThread.homeStatus == .working ? currentThread.workingStartedAt : nil
    }

    /// How the thread's environment is reachable right now. The active
    /// environment's socket is authoritative when the aggregate probe has not
    /// caught up with it.
    private var threadConnectionState: FeatureConnection.State? {
        guard let environment = threadEnvironment else { return nil }
        if environment.connectionState == .connected
            || (environment.isActive && model.snapshot.connection.state == .connected) {
            return .connected
        }
        return environment.connectionState
            ?? (environment.isActive ? model.snapshot.connection.state : nil)
    }

    private var isEnvironmentOffline: Bool {
        threadConnectionState == .disconnected
    }

    private var isChatConversation: Bool {
        currentThread.workInboxRole == "chat"
    }

    /// The thread actions a reader reaches for most, one tap from the bar.
    /// Details keeps the full picture behind the info button.
    private var threadActionsMenu: some View {
        Menu {
            if currentThread.supportsPinning != false {
                Section {
                    Button(
                        currentThread.pinnedAt == nil ? "Pin" : "Unpin",
                        systemImage: currentThread.pinnedAt == nil ? "pin" : "pin.slash"
                    ) {
                        if currentThread.pinnedAt != nil, model.snapshot.settings.confirmThreadUnpin {
                            isConfirmingUnpin = true
                        } else {
                            setPinned(currentThread.pinnedAt == nil)
                        }
                    }
                }
            }
            if !isChatConversation {
                Section {
                    Button("Files", systemImage: "folder") { toolSurface = .files(path: nil, line: nil) }
                    Button("Review Changes", systemImage: "doc.text.magnifyingglass") { toolSurface = .review(filePath: nil) }
                    Button("Source Control", systemImage: "arrow.triangle.branch") { toolSurface = .sourceControl }
                    Button("Terminal", systemImage: "terminal") { toolSurface = .terminal(terminalID: nil) }
                }
            }
            if pullRequestContext != nil, !linkedPullRequestTargets.isEmpty {
                Section {
                    ForEach(linkedPullRequestTargets) { target in
                        Button("Pull Request #\(String(target.number))", systemImage: "arrow.triangle.pull") {
                            pullRequestPreview = target
                        }
                    }
                }
            }
            Section {
                if currentThread.supportsSnooze != false,
                   let until = currentThread.snoozedUntil, until > .now {
                    Button("Unsnooze", systemImage: "moon.zzz") {
                        Task { _ = await model.setSnoozed(thread.id, until: nil) }
                    }
                }
                Button("Reload", systemImage: "arrow.clockwise") {
                    Task { _ = await model.detail(for: thread.id, force: true) }
                }
                Button(
                    currentThread.isArchived ? "Unarchive" : "Archive",
                    systemImage: currentThread.isArchived ? "tray.and.arrow.up" : "archivebox"
                ) {
                    Task { await model.setArchived(thread.id, archived: !currentThread.isArchived) }
                }
            }
        } label: {
            Label("Thread Actions", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("thread-actions-menu")
    }

    private func setPinned(_ pinned: Bool) {
        Task { _ = await model.setPinned(thread.id, pinned: pinned) }
    }

    private var pullRequestContext: MarkdownPullRequestContext? {
        threadEnvironment?.supportsPullRequests == true
            ? MarkdownPullRequestContext(threadID: thread.id, client: model.client)
            : nil
    }

    /// Pull requests pinned to the thread, previewed from the actions menu with
    /// the same sheet a link in the transcript opens.
    private var linkedPullRequestTargets: [PullRequestLinkTarget] {
        currentThread.allLinkedPullRequests.compactMap { URL(string: $0.url).flatMap(PullRequestLinkTarget.init) }
    }

    /// Shortcuts a hardware keyboard shows in the iPad command overlay.
    /// Buttons rather than menu items, because a toolbar menu's items only
    /// register while it is open.
    private var keyboardShortcuts: some View {
        Group {
            Button("Thread Details") { toolSurface = .details }
                .keyboardShortcut("i", modifiers: .command)
            Button("Previous Turn") { turnNavigationRequest -= 1 }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("Next Turn") { turnNavigationRequest += 1 }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
            Button("Send Message") { send() }
                .keyboardShortcut(.return, modifiers: .command)
            if currentThread.state == .working || currentThread.state == .queued {
                Button("Stop") { Task { await model.cancelTurn(threadID: thread.id) } }
                    .keyboardShortcut(".", modifiers: .command)
            }
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .accessibilityHidden(true)
    }

    // MARK: - Unavailable

    /// No cached copy and the load failed. The way forward depends on why: an
    /// unreachable environment needs a reconnect, anything else a retry.
    private var unavailableView: some View {
        let environmentName = currentThread.homeEnvironmentLabel(in: model.snapshot)
        return ContentUnavailableView {
            if isEnvironmentOffline, let environmentName {
                Label("\(environmentName) Is Offline", systemImage: "wifi.slash")
            } else {
                Label("Thread Unavailable", systemImage: "exclamationmark.bubble")
            }
        } description: {
            if isEnvironmentOffline {
                Text("Reconnect to load this thread.")
            } else if let environmentName {
                Text("This thread couldn't be loaded from \(environmentName).")
            } else {
                Text("This thread couldn't be loaded.")
            }
        } actions: {
            Button(action: retryLoad) {
                if isRetryingLoad {
                    ProgressView()
                } else {
                    Text(isEnvironmentOffline ? "Reconnect" : "Try Again")
                }
            }
            .t3ProminentButtonStyle()
            .disabled(isRetryingLoad)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func retryLoad() {
        guard !isRetryingLoad else { return }
        isRetryingLoad = true
        Task {
            if isEnvironmentOffline, let environmentID = threadEnvironment?.id {
                _ = await model.activateEnvironment(environmentID)
            }
            _ = await model.detail(for: thread.id, force: true)
            isRetryingLoad = false
        }
    }

    // MARK: - Outbox

    /// Captions for this thread's messages still in the outbox, keyed by the
    /// optimistic message id each submission minted.
    private var outboxCaptions: [String: ThreadMessageCaption] {
        var captions: [String: ThreadMessageCaption] = [:]
        for submission in model.outboxSubmissions where submission.threadID == thread.id {
            captions[submission.identity.messageID] = .outbox(
                model.outboxDelivery(submission),
                hasAttachments: !submission.attachments.isEmpty
            )
        }
        return captions
    }

    private var hasFailedDelivery: Bool {
        model.outboxSubmissions.contains {
            $0.threadID == thread.id && model.outboxDelivery($0) == .failed
        }
    }

    // MARK: - Timeline

    private var isReadingHistory: Bool {
        readingHistoryThreadID == thread.id
    }

    /// The transcript and the chrome that floats over it: the connection and
    /// agents bars under the navigation bar, and the dock — jump to latest,
    /// queue, tasks and composer — over the bottom edge.
    private func timeline(_ detail: FeatureThreadDetail, isLoading: Bool) -> some View {
        ZStack(alignment: .top) {
            transcriptArea(detail, isLoading: isLoading)

            VStack(spacing: 0) {
                if isEnvironmentOffline, let environmentID = threadEnvironment?.id {
                    ThreadConnectionBanner(
                        environmentName: currentThread.homeEnvironmentLabel(in: model.snapshot) ?? "This environment"
                    ) {
                        _ = await model.activateEnvironment(environmentID)
                    }
                }
                relationshipsBanner
            }
            .frame(maxWidth: T3Metrics.readingWidth)
            .frame(maxWidth: .infinity)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: TranscriptBannerHeightKey.self,
                        value: proxy.size.height
                    )
                }
            }
        }
        .onPreferenceChange(TranscriptBannerHeightKey.self) { height in
            bannerHeight = height
        }
        .threadDock {
            T3GlassContainer(spacing: 12) {
                VStack(spacing: 8) {
                    if isReadingHistory, !isLoading {
                        ThreadJumpToLatestButton(hasNewContent: hasActivityBelow) {
                            scrollToLatestRequest += 1
                        }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.trailing, 16)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                    // Measured without the jump button: it floats over rows the
                    // reader has scrolled away from, so it must not move the
                    // transcript's bottom inset.
                    VStack(spacing: 0) {
                        queueSurfaces
                        ComposerTasksView(detail: detail)
                        if currentThread.isArchived {
                            ThreadArchivedBar {
                                await model.setArchived(thread.id, archived: false)
                                PlatformHapticEngine.shared.play(.success)
                            }
                        } else {
                            composer(detail)
                        }
                    }
                    .background {
                        GeometryReader { proxy in
                            Color.clear.preference(
                                key: TranscriptComposerHeightKey.self,
                                value: proxy.size.height
                            )
                        }
                    }
                }
                // One reading column on iPad: the dock shares the transcript's
                // measure instead of spanning the whole detail pane.
                .frame(maxWidth: T3Metrics.readingWidth)
                .frame(maxWidth: .infinity)
                .animation(.snappy, value: isReadingHistory)
            }
        }
        .onPreferenceChange(TranscriptComposerHeightKey.self) { height in
            composerHeight = height
        }
    }

    @ViewBuilder
    private func transcriptArea(_ detail: FeatureThreadDetail, isLoading: Bool) -> some View {
        let isWorking = detail.thread.state == .working || detail.thread.state == .queued
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading thread")
                .accessibilityIdentifier("thread-opening-state")
        } else if detail.messages.isEmpty, detail.timelineItems.isEmpty, !isWorking {
            ContentUnavailableView(
                "Ready for a Task",
                systemImage: "sparkles",
                description: Text("Tell the agent what you want to build.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Squeezed behind the keyboard it only competes with the draft.
            .opacity(composerFocused ? 0 : 1)
            .animation(.easeOut(duration: 0.2), value: composerFocused)
        } else {
            FeatureTranscriptCollectionView(
                threadID: thread.id,
                // Projected rows name their source thread with a wire id, so
                // the rollback affordance has to compare against one.
                wireThreadID: thread.wireID ?? thread.id,
                markdownMedia: MarkdownMediaContext(
                    threadID: thread.id,
                    client: model.client
                ),
                pullRequests: pullRequestContext,
                onRollback: { target in
                    // Preview first, never fire-and-forget: the sheet
                    // shows the computed blast radius, owns progress, and
                    // surfaces failures instead of swallowing them.
                    restoreRequest = CheckpointRestoreRequest.make(
                        target: target,
                        timelineItems: detail.timelineItems
                    )
                },
                detail: detailWithPendingHandoff(detail),
                renderUpdate: model.detailRenderUpdates[thread.id],
                dynamicTypeSize: dynamicTypeSize,
                topContentInset: bannerHeight,
                bottomContentInset: composerHeight,
                canLoadEarlier: detail.page?.hasMore == true,
                isLoadingEarlier: detail.page?.isLoading == true,
                workspaceRoot: threadWorkspaceRoot,
                alwaysExpandActivity: model.snapshot.settings.alwaysExpandActivity,
                outboxCaptions: outboxCaptions,
                onLoadEarlier: {
                    Task { await model.loadEarlierTurns(for: thread.id) }
                },
                onOpenThread: openRelatedThread,
                onOpenFile: openFile,
                onOpenURL: { openURL($0) },
                onOpenDiff: openDiff,
                onRetrySend: { model.retryOutbox() },
                onRetryTurn: retryLastMessage,
                citationNavigation: model.pendingAssistantCitation.flatMap { request in
                    request.citation.threadId == (thread.wireID ?? thread.id) && request.citation.environmentId == threadEnvironment?.id ? request : nil
                },
                onCitationComplete: { request, error in
                    guard model.pendingAssistantCitation?.id == request.id else { return }
                    model.pendingAssistantCitation = nil
                    citationError = error
                },
                onOpenCitation: { citationPreview = $0 },
                citationContext: threadEnvironment?.supportsAssistantCitations == true ? AssistantCitationContext(
                    environmentId: threadEnvironment?.id ?? "", threadId: thread.wireID ?? thread.id,
                    onCite: { citation in
                        guard !isSending else { return }
                        draft += (draft.isEmpty || draft.last?.isWhitespace == true ? "" : " ") + citation.marker
                    }) : nil,
                onUseTemplate: { template in
                    guard !isSending else { return }
                    let prompt = template.prompt
                    if !draft.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix(prompt) {
                        draft += (draft.isEmpty || draft.last?.isWhitespace == true ? "" : " ") + prompt
                    }
                    composerFocused = true
                },
                navigationRequest: turnNavigationRequest,
                scrollToLatestRequest: scrollToLatestRequest,
                onReadingHistoryChanged: { reading in
                    let next = reading ? thread.id : nil
                    if readingHistoryThreadID != next { readingHistoryThreadID = next }
                },
                onActivityBelowChanged: { hasActivity in
                    if hasActivityBelow != hasActivity { hasActivityBelow = hasActivity }
                }
            )
            // The transcript runs on under the glass composer to the screen
            // edge, and on iOS 26 under the glass navigation bar too; the
            // collection view adds both bars back as content insets. Container
            // only, so it still rises for the keyboard.
            .ignoresSafeArea(.container, edges: Self.transcriptBleedEdges)
        }
    }

    /// iOS 26 bars are glass, so the transcript scrolls beneath the top one as
    /// well; earlier systems keep the opaque bar and stop at it.
    private static var transcriptBleedEdges: Edge.Set {
        if #available(iOS 26, *) { [.top, .bottom] } else { .bottom }
    }

    /// Resends the last message the reader wrote, for a turn that failed. Text
    /// only: its attachments already live on the server with the failed turn.
    private func retryLastMessage() {
        guard !isSending,
              let last = detail?.messages.last(where: { $0.role == .user && !$0.isAgentAuthored }),
              !last.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        isSending = true
        Task {
            let sent = await submitMessage(
                FeatureMessageSubmission(threadID: thread.id, text: last.text, selection: currentSelection)
            )
            if !sent { PlatformHapticEngine.shared.play(.error) }
            isSending = false
        }
    }

    /// The working-agents and background-work line above the transcript. An
    /// overlay rather than a row in the feed: it summarises the whole thread, so
    /// it has to stay put while the transcript scrolls under it.
    ///
    /// Visibility and padding belong to the bar itself, because the background
    /// half comes and goes on a clock this view does not run.
    private var relationshipsBanner: some View {
        TranscriptStatusBar(
            relationships: relationships,
            backgroundCommands: backgroundCommands,
            onOpenThread: onOpenRelatedThread,
            onMerge: lineageMergeBack,
            onDetach: lineageDetach
        )
    }

    /// The lineage sheet's merge. Throws so the sheet (the surface on screen
    /// when this runs) can say why it failed.
    private func lineageMergeBack() async throws {
        guard let relationships,
              let targetThreadID = relationships.mergeTargetThreadID,
              let runID = relationships.latestMergeBackRunID else {
            throw ThreadLineageActionUnavailable.nothingToMerge
        }
        try await model.client.mergeThreadBack(
            sourceThreadID: thread.id,
            targetThreadID: targetThreadID,
            runID: runID
        )
        _ = await model.detail(for: thread.id, force: true)
    }

    /// Refreshes either way: a failed stop may still have ended the session.
    private func lineageDetach() async throws {
        do {
            try await model.client.stopThreadSession(threadID: thread.id)
        } catch {
            _ = await model.detail(for: thread.id, force: true)
            throw error
        }
        _ = await model.detail(for: thread.id, force: true)
    }

    /// Background commands for the open thread, finished ones included so the bar
    /// can report an ending that has just landed.
    private var backgroundCommands: [ThreadDetailsBackgroundCommand] {
        guard let detail else { return [] }
        return ThreadDetailsBackgroundTasks.backgroundCommands(detail.timelineItems.map(\.item))
    }

    /// Queued runs, above the composer that will add to them.
    ///
    /// One surface, not two. `ThreadQueueControlView` used to appear alongside
    /// this whenever the provider could promote a queued message, which printed
    /// the same queue twice — a 168pt scroll card above a compact strip listing
    /// identical rows. The strip wins because it owns edit and cancel as well as
    /// reorder; steering, the card's one unique affordance, moved onto it.
    @ViewBuilder
    private var queueSurfaces: some View {
        let state = queueState
        if !state.queuedRuns.isEmpty {
            QueuedMessageStripView(
                queuedRuns: state.queuedRuns,
                isHeld: state.isHeld,
                canReorder: state.canReorder,
                dispatchingRunID: state.dispatchingRunID,
                busyRunID: queueBusyRunID,
                steerTargetRunID: state.canPromoteToSteer ? state.activeRun?.id : nil,
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
                },
                onPromoteToSteer: { queuedRunID, targetRunID in
                    performQueueAction(runID: queuedRunID) {
                        try await model.client.promoteQueuedRun(
                            threadID: thread.id,
                            queuedRunID: queuedRunID,
                            targetRunID: targetRunID
                        )
                    }
                },
                onResumeQueue: {
                    // The head run is what resuming starts, so it carries the
                    // busy state the rows already read.
                    guard let headRunID = state.queuedRuns.first?.run.id else { return }
                    performQueueAction(runID: headRunID) {
                        try await model.client.resumeThreadQueue(threadID: thread.id)
                    }
                }
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
        }
    }

    /// Reads the thread's selection and writes a pick straight back to it, so
    /// changing the model or effort here reaches every other device on the
    /// thread instead of staying in this composer.
    ///
    /// Opening the model picker materializes each option's default, which lands
    /// here as a write. Comparing against the materialized form of what the
    /// thread already holds keeps that from dispatching a command every time the
    /// sheet appears.
    private var composerSelection: Binding<FeatureSelection?> {
        Binding(
            get: { currentSelection },
            set: { next in
                guard let next else { return }
                let providers = ProviderModelCatalogNormalizer.normalized(threadProviders)
                let current =
                    ProviderModelSelectionResolver.validated(currentSelection, in: providers)
                    ?? currentSelection
                guard next != current else { return }
                Task { await model.setModelSelection(thread.id, selection: next) }
            }
        )
    }

    /// Plan/Build is thread state, so a tap here is written through to the
    /// server and mirrored locally for the frame before the echo lands — the
    /// same shape as the model selection above.
    private var composerInteractionMode: Binding<FeatureInteractionMode> {
        Binding(
            get: { currentThread.interactionMode },
            set: { next in
                guard next != currentThread.interactionMode else { return }
                Task { await model.setInteractionMode(thread.id, mode: next) }
            }
        )
    }

    private func composer(_ detail: FeatureThreadDetail) -> some View {
        FeatureComposerView(
            text: $draft,
            selection: composerSelection,
            attachments: $attachments,
            interactionMode: composerInteractionMode,
            providers: threadProviders,
            providerSetup: ProviderSetupContext(client: model.client, environmentID: thread.environmentID),
            threadSelection: currentSelection,
            materializesDefaultSelection: false,
            isSending: isSending,
            isWorking: detail.thread.state == .working || detail.thread.state == .queued,
            workingStatus: workingStatus,
            focused: $composerFocused,
            onSend: send,
            onStop: {
                Task { await model.cancelTurn(threadID: thread.id) }
            },
            readingHistory: readingHistoryThreadID == thread.id,
            pendingApprovals: detail.approvals,
            pendingUserInputs: detail.userInputs,
            isResolvingRequest: model.isPerformingAction,
            powerFeatures: composerPowerFeatures,
            historyMessages: { detail.messages },
            historyDraftKey: draftKey,
            historyDraftStore: draftStore,
            onWillStash: {
                isSwappingDraft = true
                let pending = draftSaveTask
                pending?.cancel()
                await pending?.value
            },
            onDidStash: { isSwappingDraft = false },
            externalFileDrop: didRestoreDraft && !isSwappingDraft ? model.pendingThreadFileDrops[thread.id] : nil,
            onExternalFileDropConsumed: { id in
                if model.pendingThreadFileDrops[thread.id]?.id == id { model.pendingThreadFileDrops[thread.id] = nil }
            },
            onApprovalDecision: { id, decision in
                Task { await model.resolveApproval(id, decision: decision) }
            },
            onUserInputSubmit: { id, answers, files, dismiss in
                Task { await model.resolveUserInput(id, answers: answers, attachments: files, dismiss: dismiss) }
            }
        )
        .simultaneousGesture(composerKeyboardDismissGesture)
        .environment(\.openURL, OpenURLAction { url in
            if let citation = AssistantCitation.parse(url.absoluteString) { citationPreview = citation; return .handled }
            return .systemAction
        })
    }

    private var composerKeyboardDismissGesture: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .local)
            .onChanged { value in
                // A push-to-talk hold is itself a drag over this view. Without
                // this the keyboard closes the moment the finger drifts on the
                // mic, mid-recording.
                guard !VoiceComposerCoordinator.shared.ownsActiveTouch() else { return }
                guard composerFocused,
                      value.translation.height > 8,
                      value.translation.height > abs(value.translation.width) else {
                    return
                }
                dismissKeyboard()
            }
    }

    private var composerPowerFeatures: FeatureComposerPowerFeatures {
        let selectedProviderID = currentSelection?.providerID
        let provider = threadProviders.first { $0.id == selectedProviderID }?.inWorkspace(threadWorkspaceRoot)
        return FeatureComposerPowerFeatures(
            slashCommands: provider?.slashCommands ?? [],
            skills: provider?.skills ?? [],
            showSkillsInSlashMenu: model.snapshot.settings.showSkillsInSlashMenu,
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

    /// A Hermes thread — T3 Work or T3 Chat — offers Hermes models only. Which
    /// side the thread is on comes from the thread's own provider instance,
    /// never from the picker, so the scope cannot be resolved through
    /// ``currentSelection`` (which resolves against this list in turn).
    private var threadProviders: [FeatureProvider] {
        let providers = environmentProviders
        // Same fallback chain as `currentSelection`: a detail that has not
        // resolved its provider yet must not demote the thread out of Hermes.
        let providerID = detail?.thread.providerID ?? thread.providerID
        return ModelOptions.isHermesProvider(providerID, in: providers)
            ? ModelOptions.scoped(providers, to: .hermesOnly)
            : providers
    }

    private var environmentProviders: [FeatureProvider] {
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

    /// The thread's lineage: parents and forks, context transfers, subagents,
    /// and the merge-back and detach affordances that depend on its runs and
    /// provider session.
    ///
    /// The projection's workflow carries all of it, feature-scoped, and
    /// ``FeatureThreadWorkflow/relationships(relatedThreads:additionalSubagents:)``
    /// is what reads it. Subagent edges recovered from the transcript's own
    /// `subagent` items join them, remapped onto the child ids the detail
    /// resolved, which is what makes a card in the timeline and a row in the
    /// banner point at the same thread. A client with no projection gets the
    /// transcript's subagents alone.
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

        if let lineage = detail.workflow.thread {
            var relatedIDs = Set(subagents.compactMap(\.childThreadID))
            relatedIDs.formUnion(detail.workflow.subagents.compactMap(\.childThreadID))
            for transfer in detail.workflow.transfers {
                relatedIDs.insert(transfer.sourceThreadID)
                relatedIDs.insert(transfer.targetThreadID)
            }
            if let parentID = lineage.forkedFromRunThreadID ?? lineage.parentThreadID {
                relatedIDs.insert(parentID)
            }
            relatedIDs.remove(lineage.id)
            let related = model.snapshot.threads
                .filter { relatedIDs.contains($0.id) }
                .map(relationshipShell)
            return detail.workflow.relationships(relatedThreads: related, additionalSubagents: subagents)
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

    /// A snapshot thread as the graph reads it. The snapshot carries no parent
    /// ids, so these shells contribute titles and availability, never edges of
    /// their own.
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

    /// Runs a project action and returns the terminal that accepted it, which
    /// Details pushes so the output of what was just started is on screen.
    private func runProjectScript(_ script: ProjectScript) async throws -> String? {
        try await model.client.performProjectScript(threadID: thread.id, script: script)
    }

    /// Rows that leave the thread close Details first: their destination is
    /// not inside it. Everything else Details pushes in its own stack.
    private func exitFromDetails(_ exit: ThreadDetailsExit) {
        toolSurface = nil
        switch exit {
        case .connections:
            model.setConnectionManagementPresented(true)
        case let .thread(id, isArchived):
            onOpenRelatedThread(id, isArchived)
        }
    }

    /// Details' merge back. It throws so the sheet can say why a merge did not
    /// happen. Nil when there is nothing to merge.
    private var detailsMergeBack: (() async throws -> Void)? {
        guard let relationships,
              let targetThreadID = relationships.mergeTargetThreadID,
              let runID = relationships.latestMergeBackRunID else { return nil }
        return {
            try await model.client.mergeThreadBack(
                sourceThreadID: thread.id,
                targetThreadID: targetThreadID,
                runID: runID
            )
            _ = await model.detail(for: thread.id, force: true)
        }
    }

    /// A workspace tool, pushed inside Details or presented on its own by a
    /// deep link from the transcript.
    @ViewBuilder
    private func workspaceToolView(_ tool: ThreadDetailsWorkspaceTool) -> some View {
        switch tool {
        case let .files(path, line):
            FeatureFilesView(
                client: model.client,
                threadID: thread.id,
                initialPath: path,
                initialLine: line,
                workspaceMutationID: WorkspaceMutationRevision.latest((model.details[thread.id]?.timelineItems ?? []).lazy.map {
                    WorkspaceMutationItem(sourceThreadID: $0.sourceThreadId, itemID: $0.item.id,
                        type: $0.item.type, status: $0.item.status.rawValue, updatedAt: $0.item.base.updatedAt)
                })
            )
        case let .review(filePath):
            FeatureReviewView(
                client: model.client,
                threadID: thread.id,
                selection: model.reviewSelection,
                initialFilePath: filePath
            )
        case .sourceControl:
            FeatureSourceControlView(
                client: model.client,
                threadID: thread.id,
                reviewSelection: model.reviewSelection
            )
        case let .terminal(terminalID):
            FeatureTerminalView(
                client: model.client,
                threadID: thread.id,
                initialTerminalID: terminalID
            )
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
    /// The section is what makes the review show *this* checkpoint's diff rather
    /// than the working tree, so it is namespaced on the way in: the store keeps
    /// section ids opaque, and a bare checkpoint id would be indistinguishable
    /// from any other section spelling the review might grow.
    private func openDiff(checkpointID: String, filePath: String?) {
        model.reviewSelection.openReview(
            threadID: thread.id,
            sectionID: ReviewSectionID.checkpoint(id: checkpointID).rawValue,
            filePath: filePath
        )
        toolSurface = .review(filePath: filePath)
    }

    /// Routes a thread id from a timeline row. Whether the target is archived
    /// decides which stack the navigator pushes onto, and the snapshot is the
    /// only place this view can learn that.
    private func openCitationSource(_ citation: AssistantCitation) {
        guard let target = model.snapshot.threads.first(where: {
            ($0.wireID ?? $0.id) == citation.threadId && $0.environmentID == citation.environmentId
        }) else {
            citationError = "The source thread is not available in your connected environments. The saved quote is unchanged."
            return
        }
        model.pendingAssistantCitation = AssistantCitationNavigationRequest(citation: citation)
        if target.id != thread.id { openRelatedThread(target.id) }
    }

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

    /// A model switch across providers makes the next turn slow in a way the
    /// transcript otherwise cannot explain: the orchestrator has to carry the
    /// context across, which can itself be an AI call, and until the run starts
    /// there is nothing on screen but a user bubble and a spinner.
    ///
    /// The server records this as a context handoff but never emits a `handoff`
    /// turn item for it, so the row that already knows how to draw one never
    /// fires. This synthesizes that item locally from what the client already
    /// knows, and drops it the moment a real run on the new provider appears.
    private struct PendingProviderSwitch: Equatable {
        let fromInstanceID: String
        let fromModel: String
        let toInstanceID: String
        let toModel: String
    }

    private func notePendingProviderSwitch() {
        guard let selection = currentSelection,
              let previous = detail?.timelineRuns.last,
              !previous.providerInstanceID.isEmpty,
              previous.providerInstanceID != selection.providerID else {
            pendingProviderSwitch = nil
            return
        }
        pendingProviderSwitch = PendingProviderSwitch(
            fromInstanceID: previous.providerInstanceID,
            fromModel: previous.model,
            toInstanceID: selection.providerID,
            toModel: selection.modelID
        )
    }

    /// The synthetic row, or nil once the switch has landed. `status: .running`
    /// is what makes `LifecyclePresentation` label it "Preparing context
    /// handoff" and spin, exactly as a server-sent handoff would.
    private var pendingHandoffItem: OrchestrationV2ProjectedTurnItem? {
        guard let pending = pendingProviderSwitch, let detail else { return nil }
        // A run on the target provider means the handoff is done, and a real
        // handoff item means the server is now telling this story itself.
        let landed = detail.timelineRuns.contains { $0.providerInstanceID == pending.toInstanceID }
        let serverIsNarrating = detail.timelineItems.contains { $0.item.type == "handoff" }
        guard !landed, !serverIsNarrating else { return nil }

        let base = OrchestrationV2TurnItemBase(
            id: "__t3-pending-handoff__",
            threadId: thread.id,
            ordinal: Int.max,
            status: .running,
            updatedAt: ISO8601DateFormatter().string(from: Date())
        )
        return OrchestrationV2ProjectedTurnItem(
            position: Int.max,
            visibility: .local,
            sourceThreadId: thread.id,
            sourceItemId: base.id,
            item: OrchestrationV2TurnItem(
                type: "handoff",
                base: base,
                payload: .handoff(
                    contextHandoffID: base.id,
                    fromProviderInstanceIDs: [pending.fromInstanceID],
                    fromModelSelections: [
                        ModelSelection(instanceId: pending.fromInstanceID, model: pending.fromModel),
                    ],
                    toProviderThreadID: "",
                    toProviderInstanceID: pending.toInstanceID,
                    toModel: pending.toModel,
                    strategy: "full_thread_summary",
                    summary: nil
                )
            )
        )
    }

    /// Appends the synthetic handoff row so every existing renderer — grouping,
    /// day dividers, the lifecycle row itself — treats it as any other item.
    private func detailWithPendingHandoff(_ detail: FeatureThreadDetail) -> FeatureThreadDetail {
        guard let pendingHandoffItem else { return detail }
        var augmented = detail
        augmented.timelineItems.append(pendingHandoffItem)
        return augmented
    }

    /// Uploads the thread as provider feedback, restoring the composer text if
    /// the provider refuses — the reader typed a report and should not lose it.
    private func submitProviderFeedback(reason: String?, restoring message: String) {
        draftSaveTask?.cancel()
        isSending = true
        draft = ""
        composerFocused = false
        Task {
            do {
                feedbackReceipt = try await model.client.uploadThreadFeedback(
                    threadID: thread.id,
                    reason: reason
                )
                try? await draftStore.removeDraft(for: draftKey)
            } catch {
                feedbackFailure = error.localizedDescription
                if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft = message
                }
                composerFocused = true
            }
            isSending = false
        }
    }

    private func startFreshWorkConversation(providerID: String) {
        guard let manager = model.client as? any FeatureWorkManaging,
              let environmentID = threadEnvironment?.id ?? currentThread.environmentID else {
            workConversationFailure = "This environment does not support starting Work conversations."
            return
        }
        isSending = true
        let sourceThreadID = currentThread.wireID ?? currentThread.id
        let surface = currentThread.workInboxRole == "chat" ? "chat" : "work"
        Task {
            defer { isSending = false }
            do {
                let response = try await manager.workMutate(environmentID: environmentID, input: .object([
                    "providerInstanceId": .string(providerID), "profile": .string("default"),
                    "command": .object(["type": .string("conversation.open"), "sourceThreadId": .string(sourceThreadID), "surface": .string(surface)])
                ]))
                guard let threadID = response.threadId else { throw FeatureCapabilityUnavailable("Starting a Work conversation") }
                draftSaveTask?.cancel()
                draft = ""
                try? await draftStore.removeDraft(for: draftKey)
                NotificationCenter.default.post(name: .platformRouteReceived, object: nil, userInfo: ["route": PlatformRoute.thread(environmentID: environmentID, threadID: threadID)])
            } catch { workConversationFailure = error.localizedDescription }
        }
    }

    private func send() {
        let message = draft
        let pendingAttachments = attachments
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pendingAttachments.isEmpty else {
            return
        }
        if pendingAttachments.isEmpty,
           ["/new", "/reset"].contains(message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()),
           let providerID = currentThread.providerID,
           ModelOptions.isHermesProvider(providerID, in: environmentProviders) {
            startFreshWorkConversation(providerID: providerID)
            return
        }
        // `/feedback` goes to the provider, not the agent. Only when the thread
        // actually offers it, and only on its own: attachments make it a real
        // message the reader meant to send.
        if pendingAttachments.isEmpty,
           ProviderFeedbackCommand.isSupported(by: composerPowerFeatures.slashCommands),
           let command = ProviderFeedbackCommand.parse(message) {
            submitProviderFeedback(reason: command.reason, restoring: message)
            return
        }
        draftSaveTask?.cancel()
        notePendingProviderSwitch()
        isSending = true
        draft = ""
        attachments = []
        composerFocused = false
        Task {
            let sent = await submitMessage(
                FeatureMessageSubmission(
                threadID: thread.id,
                text: message,
                selection: currentSelection,
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
                // The restored draft is the visible state; a real error has
                // already been raised by the model. No second alert.
                PlatformHapticEngine.shared.play(.error)
                AccessibilityNotification.Announcement("Message not sent. Your draft is still here.").post()
                composerFocused = true
            }
            isSending = false
            if !sent {
                persistDraftImmediately()
            }
        }
    }

    private func consumePullRequestPrompt() {
        guard didRestoreDraft, !isSending, !isSwappingDraft, let request = model.pendingPullRequestPrompts[thread.id] else { return }
        draft = PullRequestHandoffPrompt.merge(existing: draft, last: lastPullRequestPrompt, incoming: request.text)
        lastPullRequestPrompt = request.text
        pullRequestCheckoutWarning = request.warning
        model.pendingPullRequestPrompts[thread.id] = nil
        toolSurface = nil
        composerFocused = true
        scheduleDraftSave()
    }

    private var draftKey: String {
        FeatureComposerDraftStore.threadKey(currentThread)
    }

    @MainActor
    private func restoreDraft(from baseline: FeatureComposerDraft, key: String) async {
        let saved = try? await draftStore.draft(for: key)
        guard !Task.isCancelled else { return }

        let liveDraft = composerDraft
        // Only text and attachments are restored: the thread owns the model
        // selection now, so a stale one saved on this device must not shadow a
        // pick made elsewhere.
        let restored = FeatureComposerDraftRestoration.merge(
            saved: saved,
            baseline: baseline,
            current: liveDraft
        )
        draft = restored.text
        attachments = restored.attachments
        didRestoreDraft = true
        consumePullRequestPrompt()

        // Changes made while the file read or thread refresh was in flight did
        // not pass the didRestoreDraft gate, so enqueue their first save now.
        if liveDraft != baseline {
            scheduleDraftSave()
        }
    }

    private func scheduleDraftSave() {
        guard didRestoreDraft, !isSending, !isSwappingDraft else { return }
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
        guard didRestoreDraft, !isSwappingDraft else { return }
        draftSaveTask?.cancel()
        let snapshot = composerDraft
        let key = draftKey
        draftSaveTask = Task {
            try? await draftStore.setDraft(snapshot, for: key)
        }
    }

    private func persistDraftBeforeLeaving() {
        guard didRestoreDraft, !isSending, !isSwappingDraft else { return }
        persistDraftImmediately()
    }

    private var composerDraft: FeatureComposerDraft {
        FeatureComposerDraft(
            text: draft,
            attachments: attachments
        )
    }

}

/// A sheet over the thread, and where inside it to land.
///
/// Details is the hub: Source Control and Terminal are only reached by pushing
/// inside it. Files and Review are also opened directly, because the
/// transcript deep-links into them: a file link names a file and sometimes a
/// line, and a changed-files chip names one file of a diff. The identity below
/// includes that destination, so opening the same surface at a different place
/// re-presents it rather than reusing a sheet already pointed somewhere else.
private enum FeatureThreadToolSurface: Identifiable {
    case details
    case files(path: String?, line: Int?)
    case review(filePath: String?)
    case sourceControl
    case terminal(terminalID: String?)

    var id: String {
        switch self {
        case .details: "details"
        case let .files(path, line): "files:\(path ?? "")#\(line.map(String.init) ?? "")"
        case let .review(filePath): "review:\(filePath ?? "")"
        case .sourceControl: "sourceControl"
        case let .terminal(terminalID): "terminal:\(terminalID ?? "")"
        }
    }

    /// The workspace tool a deep link presents on its own; nil for Details.
    var tool: ThreadDetailsWorkspaceTool? {
        switch self {
        case .details: nil
        case let .files(path, line): .files(path: path, line: line)
        case let .review(filePath): .review(filePath: filePath)
        case .sourceControl: .sourceControl
        case let .terminal(terminalID): .terminal(terminalID: terminalID)
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
            ),
            routing: current.routing == baseline.routing ? saved?.routing : current.routing
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
    /// `caption` is the quiet line under a user bubble: its delivery while it
    /// is in the outbox, otherwise how it entered the run.
    case message(FeatureMessage, caption: ThreadMessageCaption? = nil)
    case turnFold(ThreadTurnFold)
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
        var liveEntryID: String? = nil
        let id: String
        let rows: [ThreadWorkLogRow]
        /// Relational support keyed by projected-item id, read by the inspector
        /// a row opens.
        let support: [String: ThreadActivityItemSupport]
        let date: Date?
    }

    var id: String {
        switch self {
        case let .message(message, _): "message:\(message.id)"
        case let .turnFold(fold): fold.id
        case let .lifecycle(lifecycle): lifecycle.id
        case let .workLog(workLog): workLog.id
        case let .dayDivider(id, _): id
        }
    }

    /// When the entry happened, for day bucketing. Nil when the timestamp did
    /// not parse, which drops the divider rather than the row under it.
    var date: Date? {
        switch self {
        case let .message(message, _): message.createdAt
        case let .turnFold(fold): fold.date
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
        let activeRunID = detail.workflow.queueState.activeRun?.id
        var result = entries(
            timelineItems: detail.timelineItems,
            messages: detail.messages,
            runs: detail.timelineRuns,
            support: detail.itemSupport,
            subagentChildThreadIDs: detail.subagentChildThreadIDs,
            liveRun: ThreadWorkLogLiveRun(threadState: detail.thread.state, activeRunID: activeRunID),
            calendar: calendar
        )
        if detail.thread.state == .working, case var .workLog(work)? = result.last {
            work.liveEntryID = ThreadLiveWorkFocus.selection(items: work.rows.map(\.liveFocusItem), activeRunID: activeRunID)
            result[result.count - 1] = .workLog(work)
        }
        return result
    }

    static func entries(
        timelineItems: [OrchestrationV2ProjectedTurnItem],
        messages: [FeatureMessage],
        runs: [LifecycleTimelineRun] = [],
        support: [String: ThreadActivityItemSupport] = [:],
        subagentChildThreadIDs: [String: String] = [:],
        liveRun: ThreadWorkLogLiveRun = .unscoped,
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

        // One Stop is one boundary: a request whose run already reports the
        // result says nothing the result does not.
        var interruptedRunIDs = Set<String>()
        for projected in timelineItems where projected.item.type == "run_interrupt_result" {
            if let runID = projected.item.base.runId { interruptedRunIDs.insert(runID) }
        }

        for projected in timelineItems {
            let item = projected.item
            if item.type == "run_interrupt_request",
               let runID = item.base.runId, interruptedRunIDs.contains(runID) {
                continue
            }
            if item.type == "user_message" || item.type == "assistant_message" {
                // An empty bubble is not a row — an assistant message before its
                // first token, say — and skipping it must not split the work
                // group it sits inside.
                guard let message = messagesByID[item.id], !message.isEmptyBubble else { continue }
                closeWork()
                closeLifecycle()
                entries.append(.message(message, caption: ThreadMessageCaption.origin(of: item)))
                continue
            }
            if ThreadLifecycle.isLifecycleTimelineItem(item) {
                closeWork()
                openLifecycle.append(projected)
                continue
            }
            closeLifecycle()
            openWork.append(ThreadWorkLogRow.make(projected, liveRun: liveRun))
        }
        closeWork()
        closeLifecycle()

        // Optimistic sends have no projected item yet, and a client that carries
        // no projection at all has only messages. Both arrive here as plain
        // message rows, which is what keeps a just-sent bubble on screen.
        // Two identifiers name the same bubble: an optimistic row carries the
        // message id the client generated, while its projected row carries the
        // turn item id the server assigned. Matching on the item id alone let a
        // just-sent message through a second time the moment the echo landed —
        // visible until a reload dropped the optimistic copy. Same distinction
        // `OrchestrationV2ThreadProjection.containsUserMessage(id:)` draws.
        var projectedItemIDs = Set(timelineItems.map(\.item.id))
        for projected in timelineItems {
            switch projected.item.payload {
            case let .userMessage(messageID, _, _, _):
                projectedItemIDs.insert(messageID)
            case let .assistantMessage(messageID, _, _):
                projectedItemIDs.insert(messageID)
            default:
                break
            }
        }
        for message in messages
        where !projectedItemIDs.contains(message.id) && !message.isEmptyBubble {
            entries.append(.message(message, caption: nil))
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
    var onRetrySend: () -> Void = {}
    var onRetryTurn: (() -> Void)? = nil

    var onToggleFold: (String) -> Void = { _ in }

    var body: some View {
        switch entry {
        case let .turnFold(fold):
            let steps = ThreadWorkLogRow.stepCount(fold.hiddenIDs.count)
            Button { onToggleFold(fold.runID) } label: {
                HStack(spacing: 8) {
                    Text(fold.label).font(T3Typography.supportingStrong)
                    Text("· \(steps)").font(T3Typography.supporting).foregroundStyle(T3Colors.textTertiary)
                    TimelineDisclosureChevron(isExpanded: fold.isExpanded)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(fold.label), \(steps)")
            .accessibilityValue(fold.isExpanded ? "Expanded" : "Collapsed")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier(fold.id)
            .padding(.bottom, ChatTimelineStyle.entrySpacing)

        case let .message(message, caption):
            FeatureMessageView(message: message, caption: caption, onRetrySend: onRetrySend)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, ChatTimelineStyle.entrySpacing)

        case let .lifecycle(lifecycle):
            if lifecycle.rows.count > 1 {
                ThreadLifecycleRowGroup(
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
                liveEntryID: workLog.liveEntryID,
                currentThreadID: currentThreadID,
                currentWireThreadID: currentWireThreadID,
                workspaceRoot: workspaceRoot,
                itemSupport: { workLog.support[$0.id] ?? .empty },
                onOpenThread: onOpenThread,
                onOpenFile: onOpenFile,
                onOpenURL: onOpenURL,
                onOpenDiff: onOpenDiff,
                onRollback: onRollback,
                onRetryTurn: onRetryTurn,
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
    @SwiftUI.Environment(\.nativeAppToolIconContext) private var nativeAppIcons
    private static let loadEarlierID = "__t3-load-earlier__"

    private enum Section: Hashable {
        case transcript
    }

    let threadID: String
    let wireThreadID: String
    /// Resolves assistant markdown media against this thread's environment.
    let markdownMedia: MarkdownMediaContext?
    var pullRequests: MarkdownPullRequestContext? = nil
    let onRollback: (ThreadActivityRollbackTarget) -> Void
    /// The whole detail rather than its rows: building the feed costs O(window),
    /// so it happens inside the coordinator once the revision guard has proved
    /// something actually changed, not on every SwiftUI body evaluation.
    let detail: FeatureThreadDetail
    let renderUpdate: FeatureDetailRenderUpdate?
    let dynamicTypeSize: DynamicTypeSize
    /// Keeps the first rows clear of the floating banners while still letting
    /// them scroll underneath, which is the whole point of the glass. The
    /// collection adds the navigation bar itself when it runs under it.
    let topContentInset: CGFloat
    let bottomContentInset: CGFloat
    let canLoadEarlier: Bool
    let isLoadingEarlier: Bool
    let workspaceRoot: String?
    /// `FeatureSettings.alwaysExpandActivity`, which decides how work-log rows
    /// open. Tracked like the type size below rather than passed through the row
    /// context alone: a preference change has to reconfigure cells that are
    /// already on screen.
    let alwaysExpandActivity: Bool
    /// Delivery captions for messages still in this device's outbox, keyed by
    /// message id. Folded into the rows so a status change reconfigures only
    /// the bubble it belongs to.
    var outboxCaptions: [String: ThreadMessageCaption] = [:]
    let onLoadEarlier: () -> Void
    let onOpenThread: (String) -> Void
    let onOpenFile: (ThreadActivityFileOpenRequest) -> Void
    let onOpenURL: (URL) -> Void
    let onOpenDiff: (String, String?) -> Void
    var onRetrySend: () -> Void = {}
    var onRetryTurn: (() -> Void)? = nil
    var citationNavigation: AssistantCitationNavigationRequest? = nil
    var onCitationComplete: (AssistantCitationNavigationRequest, String?) -> Void = { _, _ in }
    var onOpenCitation: (AssistantCitation) -> Void = { _ in }
    var citationContext: AssistantCitationContext? = nil
    var onUseTemplate: (CodexArtifactTemplate) -> Void = { _ in }
    var navigationRequest: Int = 0
    var scrollToLatestRequest: Int = 0
    var onReadingHistoryChanged: (Bool) -> Void = { _ in }
    var onActivityBelowChanged: (Bool) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UICollectionView {
        let collectionView = BottomAnchoredTranscriptCollectionView(
            frame: .zero,
            collectionViewLayout: Self.makeLayout()
        )
        collectionView.alwaysBounceVertical = true
        // Interactive, like Messages: the keyboard follows the finger down
        // instead of snapping away the moment the transcript moves.
        collectionView.keyboardDismissMode = .interactive
        collectionView.delaysContentTouches = false
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.isPrefetchingEnabled = true
        collectionView.accessibilityIdentifier = "thread-transcript"
        if #available(iOS 26, *) {
            collectionView.topEdgeEffect.style = .soft
        }
        context.coordinator.connect(to: collectionView)
        // Assigns the background now and again on every palette change; the
        // token dies with the coordinator, so it cannot outlive this view.
        context.coordinator.themeRefresh = T3ThemeRefresh { [weak collectionView] in
            collectionView?.backgroundColor = T3Colors.uiBackground
        }
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        // Both insets go through the subclass rather than being assigned here:
        // the collection ignores the container safe area to run under the
        // glass bars, and the bar and home-indicator overlaps it must add back
        // are only current inside its own layout pass. It folds
        // `adjustedContentInset` into its viewport model, so a change restores
        // the bottom anchor rather than jumping the scroll.
        let transcript = collectionView as? BottomAnchoredTranscriptCollectionView
        transcript?.floatingTopInset = topContentInset
        transcript?.floatingBottomInset = bottomContentInset
        context.coordinator.onReadingHistoryChanged = onReadingHistoryChanged
        context.coordinator.onActivityBelowChanged = onActivityBelowChanged
        context.coordinator.update(
            threadID: threadID,
            detail: detail,
            renderUpdate: renderUpdate,
            dynamicTypeSize: dynamicTypeSize,
            canLoadEarlier: canLoadEarlier,
            isLoadingEarlier: isLoadingEarlier,
            alwaysExpandActivity: alwaysExpandActivity,
            outboxCaptions: outboxCaptions,
            rowContext: Coordinator.RowContext(
                currentThreadID: threadID,
                currentWireThreadID: wireThreadID,
                markdownMedia: markdownMedia,
                pullRequests: pullRequests,
                nativeAppIcons: nativeAppIcons,
                onRollback: onRollback,
                workspaceRoot: workspaceRoot,
                alwaysExpandActivity: alwaysExpandActivity,
                onOpenThread: onOpenThread,
                onOpenFile: onOpenFile,
                onOpenURL: onOpenURL,
                onOpenDiff: onOpenDiff,
                onRetrySend: onRetrySend,
                onRetryTurn: onRetryTurn,
                onOpenCitation: onOpenCitation,
                citationContext: citationContext,
                onUseTemplate: onUseTemplate
            ),
            onLoadEarlier: onLoadEarlier,
            in: collectionView
        )
        context.coordinator.navigate(request: navigationRequest, in: collectionView)
        context.coordinator.scrollToLatest(request: scrollToLatestRequest, in: collectionView)
        context.coordinator.navigateCitation(citationNavigation, completion: onCitationComplete, in: collectionView)
    }

    private static func makeLayout() -> UICollectionViewLayout {
        StormGuardedCompositionalLayout { _, environment in
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
            /// How a message's markdown media resolves to a loadable URL. Set
            /// on the hosted row rather than on the SwiftUI parent: a hosting
            /// configuration roots its own environment, so nothing an ancestor
            /// puts there reaches these cells.
            var markdownMedia: MarkdownMediaContext?
            var pullRequests: MarkdownPullRequestContext?
            var nativeAppIcons: NativeAppToolIconContext?
            var onRollback: (ThreadActivityRollbackTarget) -> Void = { _ in }
            var workspaceRoot: String?
            var alwaysExpandActivity = false
            var onOpenThread: (String) -> Void = { _ in }
            var onOpenFile: (ThreadActivityFileOpenRequest) -> Void = { _ in }
            var onOpenURL: (URL) -> Void = { _ in }
            var onOpenDiff: (String, String?) -> Void = { _, _ in }
            var onRetrySend: () -> Void = {}
            var onRetryTurn: (() -> Void)?
            var onOpenCitation: (AssistantCitation) -> Void = { _ in }
            var citationContext: AssistantCitationContext?
            var onUseTemplate: (CodexArtifactTemplate) -> Void = { _ in }
        }

        private var dataSource: UICollectionViewDiffableDataSource<Section, String>?
        private var entriesByID: [String: ThreadTimelineEntry] = [:]
        private var orderedIDs: [String] = []
        private var expandedRunIDs = Set<String>()
        private var foldChoiceRevision = 0
        private var renderedFoldChoiceRevision = 0
        private var rebuildForFold: (() -> Void)?
        private var hiddenCitationRunIDs: [String: String] = [:]

        private func toggleFold(_ runID: String) {
            if !expandedRunIDs.insert(runID).inserted { expandedRunIDs.remove(runID) }
            foldChoiceRevision += 1
            rebuildForFold?()
        }
        private let citationHighlight = AssistantCitationHighlight()
        private let workLogHistory = ThreadWorkLogHistoryStore()
        private var citationRequest: AssistantCitationNavigationRequest?
        private var citationCompletion: (AssistantCitationNavigationRequest, String?) -> Void = { _, _ in }
        private var citationPages = Set<String>()
        private var citationSawLoading = false
        private var applyingSnapshot = false

        func navigateCitation(_ request: AssistantCitationNavigationRequest?, completion: @escaping (AssistantCitationNavigationRequest, String?) -> Void, in collectionView: UICollectionView) {
            if citationRequest?.id != request?.id { citationPages = []; citationSawLoading = false }
            citationRequest = request
            citationCompletion = completion
            DispatchQueue.main.async { [weak self, weak collectionView] in
                guard let self, let collectionView else { return }
                self.revealCitation(in: collectionView)
            }
        }

        private func revealCitation(in collectionView: UICollectionView) {
            guard let request = citationRequest, !applyingSnapshot, let dataSource else { return }
            let citation = request.citation
            if let entryID = orderedIDs.first(where: {
                guard case let .message(message, _) = entriesByID[$0] else { return false }
                return (message.wireMessageID ?? message.id) == citation.messageId && message.role == .assistant
            }), let path = dataSource.indexPath(for: entryID) {
                (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = false
                collectionView.layoutIfNeeded()
                collectionView.scrollToItem(at: path, at: .top, animated: !UIAccessibility.isReduceMotionEnabled)
                var sourceMatches = false
                if case let .message(message, _) = entriesByID[entryID] {
                    let document = MarkdownRenderCache.shared.documentImmediately(for: MarkdownContentRevision(message.text))
                    sourceMatches = AssistantCitationTextRange.resolve(in: document?.citationText ?? message.text, quote: citation.text,
                        start: citation.start, end: citation.end, prefix: citation.prefix, suffix: citation.suffix) != nil
                }
                if sourceMatches { citationHighlight.show(citation) }
                UIAccessibility.post(notification: .announcement, argument: "Quoted response: \(citation.text)")
                citationRequest = nil
                citationCompletion(request, sourceMatches ? nil : "The source response is visible, but the saved quote no longer matches unambiguously. Your saved quote is unchanged.")
                return
            }
            if let runID = hiddenCitationRunIDs[citation.messageId], !expandedRunIDs.contains(runID) {
                toggleFold(runID)
                return
            }
            if currentIsLoadingEarlier { citationSawLoading = true; return }
            let page = orderedIDs.first ?? "empty"
            if currentCanLoadEarlier && citationPages.count < 20 {
                if citationPages.insert(page).inserted { citationSawLoading = false; onLoadEarlier?(); return }
                if !citationSawLoading { return }
            }
            citationRequest = nil
            citationCompletion(request, "The source response could not be loaded. Load earlier turns and try again. Your saved quote is unchanged.")
        }

        private var lastNavigationRequest = 0
        private var pendingPreviousTurn = false

        func navigate(request: Int, in collectionView: UICollectionView) {
            guard request != lastNavigationRequest else { return }
            let forward = request > lastNavigationRequest
            lastNavigationRequest = request
            navigateTurn(forward: forward, in: collectionView)
        }

        private var lastScrollToLatestRequest = 0

        func scrollToLatest(request: Int, in collectionView: UICollectionView) {
            guard request != lastScrollToLatestRequest else { return }
            lastScrollToLatestRequest = request
            scrollToBottom(collectionView, animated: !UIAccessibility.isReduceMotionEnabled)
        }

        fileprivate func navigateTurn(forward: Bool, in collectionView: UICollectionView, allowLoad: Bool = true) {
            guard let dataSource else { return }
            collectionView.layoutIfNeeded()
            let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
            let candidates = orderedIDs.compactMap { id -> (IndexPath, CGFloat)? in
                guard case let .message(message, _) = entriesByID[id], message.role == .user, !message.isAgentAuthored,
                      let path = dataSource.indexPath(for: id),
                      let frame = collectionView.layoutAttributesForItem(at: path)?.frame else { return nil }
                return (path, frame.minY)
            }
            let target = forward ? candidates.first { $0.1 > top + 2 } : candidates.last { $0.1 < top - 2 }
            if let target {
                pendingPreviousTurn = false
                (collectionView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = false
                collectionView.scrollToItem(at: target.0, at: .top, animated: !UIAccessibility.isReduceMotionEnabled)
            } else if allowLoad && !forward && currentCanLoadEarlier && !currentIsLoadingEarlier {
                pendingPreviousTurn = true
                onLoadEarlier?()
            } else if forward { scrollToBottom(collectionView, animated: !UIAccessibility.isReduceMotionEnabled) }
        }

        private var currentThreadID: String?
        private var currentDetailRevision: UInt64?
        private var currentDynamicTypeSize: DynamicTypeSize?
        private var currentAlwaysExpandActivity = false
        private var currentCanLoadEarlier = false
        private var currentIsLoadingEarlier = false
        private var currentOutboxCaptions: [String: ThreadMessageCaption] = [:]
        private var markdownPrefetches: [String: MarkdownPrefetch] = [:]
        private var rowContext = RowContext()
        private var onLoadEarlier: (() -> Void)?
        /// Set when scrolling near the top asked for earlier turns, cleared
        /// when that load settles, so one approach asks once.
        private var requestedEarlierTurns = false
        private var reportedActivityBelow = false
        var onReadingHistoryChanged: (Bool) -> Void = { _ in }
        var onActivityBelowChanged: (Bool) -> Void = { _ in }
        var themeRefresh: T3ThemeRefresh?

        deinit {
            markdownPrefetches.values.forEach { $0.task.cancel() }
        }

        func connect(to collectionView: UICollectionView) {
            let registration = UICollectionView.CellRegistration<UICollectionViewCell, String> {
                [weak self] cell, _, entryID in
                if entryID == FeatureTranscriptCollectionView.loadEarlierID {
                    cell.contentConfiguration = UIHostingConfiguration {
                        FeatureLoadEarlierTurnsRow(
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
                guard let self, let entry = entriesByID[entryID] else {
                    cell.contentConfiguration = nil
                    return
                }

                let context = rowContext
                let highlight = citationHighlight
                let toolHistory = workLogHistory
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
                        onOpenDiff: context.onOpenDiff,
                        onRetrySend: context.onRetrySend,
                        onRetryTurn: context.onRetryTurn,
                        onToggleFold: { [weak self] in self?.toggleFold($0) }
                    )
                    // A recycled cell keeps the SwiftUI state of whatever it
                    // rendered last. Keying on the entry drops an expansion
                    // when the cell is reused for a different row, rather than
                    // showing it against the wrong one.
                    .id(entryID)
                    .environment(\.markdownMediaContext, context.markdownMedia)
                    .environment(\.markdownPullRequestContext, context.pullRequests)
                    .environment(\.assistantCitationContext, context.citationContext)
                    .environment(\.assistantCitationHighlight, highlight)
                    .environment(\.threadWorkLogHistory, toolHistory)
                    .environment(\.nativeAppToolIconContext, context.nativeAppIcons)
                    .environment(\.markdownTemplateAction, context.onUseTemplate)
                    .environment(\.openURL, OpenURLAction { url in
                        if let citation = AssistantCitation.parse(url.absoluteString) {
                            context.onOpenCitation(citation)
                            return .handled
                        }
                        guard let target = CodexMarkdownDirectives.fileTarget(url) else { return .systemAction }
                        let root = context.workspaceRoot.map { $0.hasSuffix("/") ? $0 : $0 + "/" }
                        let path = root.map { target.path.hasPrefix($0) ? String(target.path.dropFirst($0.count)) : target.path } ?? target.path
                        context.onOpenFile(ThreadActivityFileOpenRequest(relativePath: path, line: target.line))
                        return .handled
                    })
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
            // Previous and next turn for VoiceOver; hardware keyboards get
            // the same moves as shortcuts on the thread screen.
            collectionView.accessibilityCustomActions = [
                UIAccessibilityCustomAction(name: "Previous turn") { [weak self, weak collectionView] _ in
                    guard let self, let collectionView else { return false }
                    self.navigateTurn(forward: false, in: collectionView)
                    return true
                },
                UIAccessibilityCustomAction(name: "Next turn") { [weak self, weak collectionView] _ in
                    guard let self, let collectionView else { return false }
                    self.navigateTurn(forward: true, in: collectionView)
                    return true
                },
            ]
        }

        func update(
            threadID: String,
            detail: FeatureThreadDetail,
            renderUpdate: FeatureDetailRenderUpdate?,
            dynamicTypeSize: DynamicTypeSize,
            canLoadEarlier: Bool,
            isLoadingEarlier: Bool,
            alwaysExpandActivity: Bool,
            outboxCaptions: [String: ThreadMessageCaption],
            rowContext: RowContext,
            onLoadEarlier: @escaping () -> Void,
            in collectionView: UICollectionView
        ) {
            guard let dataSource else { return }
            let iconEnvironmentChanged = self.rowContext.nativeAppIcons?.environmentID != rowContext.nativeAppIcons?.environmentID
            self.rowContext = rowContext
            self.onLoadEarlier = onLoadEarlier

            rebuildForFold = { [weak self, weak collectionView] in
                guard let self, let collectionView else { return }
                self.update(threadID: threadID, detail: detail, renderUpdate: renderUpdate,
                    dynamicTypeSize: dynamicTypeSize, canLoadEarlier: canLoadEarlier,
                    isLoadingEarlier: isLoadingEarlier, alwaysExpandActivity: alwaysExpandActivity,
                    outboxCaptions: outboxCaptions, rowContext: rowContext,
                    onLoadEarlier: onLoadEarlier, in: collectionView)
            }
            let foldChoiceChanged = renderedFoldChoiceRevision != foldChoiceRevision
            let threadChanged = currentThreadID != threadID
            let typeSizeChanged = currentDynamicTypeSize != dynamicTypeSize || iconEnvironmentChanged
            // Same treatment as the type size: it changes how every row renders
            // rather than what any row contains, so nothing else in this update
            // would report it.
            let expansionPreferenceChanged =
                currentAlwaysExpandActivity != alwaysExpandActivity
            let revisionChanged = currentDetailRevision != renderUpdate?.revision
            let loadEarlierChanged = currentCanLoadEarlier != canLoadEarlier
                || currentIsLoadingEarlier != isLoadingEarlier
            let outboxChanged = currentOutboxCaptions != outboxCaptions
            if currentIsLoadingEarlier, !isLoadingEarlier { requestedEarlierTurns = false }
            guard threadChanged || typeSizeChanged || expansionPreferenceChanged
                || revisionChanged || loadEarlierChanged || foldChoiceChanged
                || outboxChanged else { return }

            // Always the whole feed. An item's shape depends on its neighbours —
            // a new tool call joins the work group above it, a subagent card
            // merges into the run beside it — so a delta that only names changed
            // messages cannot say which rows moved, and applying it would leave
            // stale groups on screen instead of failing loudly.
            if threadChanged { expandedRunIDs = []; hiddenCitationRunIDs = [:] }
            let fullEntries = ThreadTimelineFeed.entries(for: detail)
            let folded = ThreadTimelineFoldPresentation.apply(entries: fullEntries, detail: detail,
                expandedRunIDs: expandedRunIDs, alwaysExpand: alwaysExpandActivity)
            hiddenCitationRunIDs = folded.hiddenCitationRunIDs
            let captioned = outboxCaptions.isEmpty ? folded.entries : folded.entries.map { entry in
                guard case let .message(message, _) = entry,
                      let delivery = outboxCaptions[message.id] else { return entry }
                return .message(message, caption: delivery)
            }
            let state = entryState(captioned)
            renderedFoldChoiceRevision = foldChoiceRevision
            let newIDs = state.ids
            let idsChanged = state.idsChanged
            let changedIDs = typeSizeChanged || expansionPreferenceChanged
                ? newIDs
                : state.changedIDs

            currentDetailRevision = renderUpdate?.revision
            currentDynamicTypeSize = dynamicTypeSize
            currentAlwaysExpandActivity = alwaysExpandActivity
            currentCanLoadEarlier = canLoadEarlier
            currentIsLoadingEarlier = isLoadingEarlier
            currentOutboxCaptions = outboxCaptions
            guard threadChanged || idsChanged || !changedIDs.isEmpty
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
            let lastIDChanged = orderedIDs.last != newIDs.last
            let isInitialLoad = currentThreadID == nil || threadChanged
            let previousIDs = orderedIDs
            let prependedMessages = !threadChanged
                && newIDs.count > previousIDs.count
                && Array(newIDs.suffix(previousIDs.count)) == previousIDs
            let shouldFollowBottom = isInitialLoad || (wasNearBottom && !foldChoiceChanged)
            // The coordinator is the one place that knows a new row landed
            // while the reader was elsewhere; the jump button shows it.
            if threadChanged {
                reportActivityBelow(false)
            } else if lastIDChanged, !wasNearBottom, !prependedMessages {
                reportActivityBelow(true)
            }
            let prependAnchor = !shouldFollowBottom
                && (foldChoiceChanged || prependedMessages || (loadEarlierChanged && !canLoadEarlier))
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
            let appendedIDSet = Set(state.appendedIDs)
            var reconfiguredIDs = changedIDs.filter { !appendedIDSet.contains($0) }
            if loadEarlierChanged,
               snapshot.indexOfItem(FeatureTranscriptCollectionView.loadEarlierID) != nil {
                reconfiguredIDs.append(FeatureTranscriptCollectionView.loadEarlierID)
            }
            if !reconfiguredIDs.isEmpty {
                snapshot.reconfigureItems(reconfiguredIDs)
            }

            applyingSnapshot = true
            dataSource.apply(snapshot, animatingDifferences: false) {
                [weak self, weak collectionView] in
                guard let self, let collectionView else { return }
                self.applyingSnapshot = false
                DispatchQueue.main.async {
                    if shouldFollowBottom {
                        self.scrollToBottom(
                            collectionView,
                            animated: !isInitialLoad && lastIDChanged
                        )
                    } else if let prependAnchor {
                        self.restore(prependAnchor, in: collectionView, dataSource: dataSource)
                    }
                    self.revealCitation(in: collectionView)
                    if self.pendingPreviousTurn && !self.currentIsLoadingEarlier {
                        self.pendingPreviousTurn = false
                        self.navigateTurn(forward: false, in: collectionView, allowLoad: false)
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
            guard case let .message(message, _) = entriesByID[entryID],
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
            reportReadingHistory(false)
            reportActivityBelow(false)
        }

        /// The host compares before it writes, so a scroll costs it one state
        /// change per crossing of the threshold rather than one per frame. Not
        /// deduplicated here: focusing the composer clears the host's flag
        /// behind this coordinator's back.
        private func reportReadingHistory(_ reading: Bool) {
            onReadingHistoryChanged(reading)
        }

        private func reportActivityBelow(_ hasActivity: Bool) {
            guard reportedActivityBelow != hasActivity else { return }
            reportedActivityBelow = hasActivity
            onActivityBelowChanged(hasActivity)
            if hasActivity {
                UIAccessibility.post(notification: .announcement, argument: "New activity below")
            }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            if let request = citationRequest {
                citationRequest = nil
                citationCompletion(request, nil)
            }
            (scrollView as? BottomAnchoredTranscriptCollectionView)?.maintainsBottomAnchor = false
        }

        /// Plain arithmetic per frame, and only while the reader moves the
        /// transcript: whether they have left the bottom, and whether they
        /// have come close enough to the top to fetch earlier turns.
        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard scrollView.isDragging || scrollView.isDecelerating,
                  let collectionView = scrollView as? UICollectionView else { return }
            let nearBottom = isNearBottom(collectionView)
            reportReadingHistory(!nearBottom)
            if nearBottom { reportActivityBelow(false) }

            // Earlier turns arrive before the reader reaches the edge; the
            // prepend keeps what is on screen in place.
            guard currentCanLoadEarlier, !currentIsLoadingEarlier, !requestedEarlierTurns else { return }
            let distanceFromTop = scrollView.contentOffset.y + scrollView.adjustedContentInset.top
            if distanceFromTop < scrollView.bounds.height * 0.75 {
                requestedEarlierTurns = true
                onLoadEarlier?()
            }
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
            let nearBottom = isNearBottom(collectionView)
            collectionView.maintainsBottomAnchor = nearBottom
            reportReadingHistory(!nearBottom)
            if nearBottom { reportActivityBelow(false) }
        }
    }
}

/// The top of a transcript with more history. Scrolling near it loads the
/// earlier turns on its own; the button stays for VoiceOver and for a reader
/// who stops short of the edge.
private struct FeatureLoadEarlierTurnsRow: View {
    let isLoading: Bool
    let onLoad: () -> Void

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Loading earlier turns")
            } else {
                Button("Load Earlier Turns", action: onLoad)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: T3Metrics.minimumTapTarget)
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

    /// How many times running the anchor may move the offset before the
    /// transcript has to have settled. Self-sizing rows legitimately need a
    /// couple of passes to swap their estimate for a measured height; a
    /// transcript still moving after that is not converging, and chasing it
    /// further is what recurses into UIKit's re-entrancy assertion.
    static let maximumConsecutiveRestores = 4

    func restoredBottomOffset(
        after previous: Self?,
        maintainsBottomAnchor: Bool,
        isInteracting: Bool,
        consecutiveRestores: Int = 0
    ) -> CGFloat? {
        guard maintainsBottomAnchor, !isInteracting else {
            return nil
        }
        guard consecutiveRestores < Self.maximumConsecutiveRestores else {
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
/// The floating banner's measured height, so the transcript can inset for a
/// view that overlays it rather than displaces it.
private struct TranscriptBannerHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// The floating composer's measured height, same purpose from the other edge.
private struct TranscriptComposerHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Bounds how often the layout may invalidate itself inside a single layout
/// pass of the transcript.
///
/// Opening a long thread lands the scroll at the bottom of a layout where
/// every row above is still `.estimated(120)`. Each visible-cells pass then
/// measures cells, shifts the content offset, reveals more unmeasured rows,
/// and invalidates — and UIKit re-enters the pass recursively. Around a
/// hundred nested passes UIKit's re-entrancy assertion aborts the app (the
/// dominant crash in the field). Rows here cannot be pre-measured (markdown,
/// embeds), so past a generous bound the remaining invalidations are deferred
/// to the next runloop turn: the layout converges across frames instead of
/// recursing to death.
private final class StormGuardedCompositionalLayout: UICollectionViewCompositionalLayout {
    /// Well below UIKit's ~100-pass abort, well above the handful of passes a
    /// legitimately converging layout needs.
    private static let maximumInvalidationsPerPass = 40

    fileprivate var invalidationsThisPass = 0
    private var recoveryScheduled = false

    override func invalidateLayout(with context: UICollectionViewLayoutInvalidationContext) {
        // Structural invalidations (reloads, count changes) must always land;
        // only the self-sizing feedback loop inside a layout pass is bounded.
        guard let host = collectionView as? BottomAnchoredTranscriptCollectionView,
              host.isInLayoutPass,
              !context.invalidateEverything,
              !context.invalidateDataSourceCounts else {
            super.invalidateLayout(with: context)
            return
        }
        invalidationsThisPass += 1
        guard invalidationsThisPass > Self.maximumInvalidationsPerPass else {
            super.invalidateLayout(with: context)
            return
        }
        if !recoveryScheduled {
            recoveryScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.recoveryScheduled = false
                self.collectionView?.setNeedsLayout()
            }
        }
    }
}

private final class BottomAnchoredTranscriptCollectionView: UICollectionView {
    var maintainsBottomAnchor = false {
        didSet {
            // Following the latest turn again is a fresh reason to anchor, so
            // it starts from a fresh budget rather than inheriting whatever
            // the last burst of growth spent.
            if maintainsBottomAnchor, !oldValue { consecutiveAnchorRestores = 0 }
        }
    }

    /// The measured height of the glass composer floating over the bottom of
    /// the transcript. Folded into `contentInset.bottom` together with the
    /// live safe-area overlap (the home indicator when no keyboard is up).
    ///
    /// Applied from the setter and from `safeAreaInsetsDidChange` — never from
    /// `layoutSubviews`. Writing `contentInset` inside the layout pass makes
    /// the compositional layout invalidate itself mid-visible-cells update,
    /// which recurses until UIKit's re-entrancy assertion kills the app.
    var floatingBottomInset: CGFloat = 0 {
        didSet {
            if abs(floatingBottomInset - oldValue) > 0.5 { applyInsets() }
        }
    }

    /// The measured height of the bars floating over the top of the
    /// transcript. Folded into `contentInset.top` together with the safe-area
    /// overlap, which is the navigation bar where the transcript runs under it
    /// (iOS 26) and zero where it stops at an opaque bar.
    var floatingTopInset: CGFloat = 0 {
        didSet {
            if abs(floatingTopInset - oldValue) > 0.5 { applyInsets() }
        }
    }

    private var lastLaidOutGeometry: TranscriptViewportGeometry?
    private var isRestoringBottomAnchor = false
    fileprivate var isInLayoutPass = false
    /// Offset writes made while the transcript height was still moving, reset
    /// the moment it stops. See `maximumConsecutiveRestores`.
    private var consecutiveAnchorRestores = 0

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        applyInsets()
    }

    private func applyInsets() {
        let top = floatingTopInset + safeAreaInsets.top
        let bottom = floatingBottomInset + safeAreaInsets.bottom
        guard abs(contentInset.top - top) > 0.5 || abs(contentInset.bottom - bottom) > 0.5 else { return }
        // The invariant documented on `floatingBottomInset`, actually enforced:
        // UIKit calls `safeAreaInsetsDidChange` from inside the layout pass
        // whenever the keyboard moves, so the setter alone does not keep inset
        // writes out of it. Land the write on the next turn instead.
        guard !isInLayoutPass else {
            DispatchQueue.main.async { [weak self] in self?.applyInsets() }
            return
        }
        if abs(contentInset.top - top) > 0.5 { contentInset.top = top }
        if abs(contentInset.bottom - bottom) > 0.5 { contentInset.bottom = bottom }
    }

    override func layoutSubviews() {
        (collectionViewLayout as? StormGuardedCompositionalLayout)?.invalidationsThisPass = 0
        isInLayoutPass = true
        super.layoutSubviews()
        isInLayoutPass = false

        let geometry = TranscriptViewportGeometry(
            contentHeight: contentSize.height,
            viewportHeight: bounds.height,
            topInset: adjustedContentInset.top,
            bottomInset: adjustedContentInset.bottom
        )
        let previous = lastLaidOutGeometry
        lastLaidOutGeometry = geometry

        // Settled: rows have stopped swapping estimates for measured heights,
        // so the next genuine growth gets the full budget again.
        if previous == geometry {
            consecutiveAnchorRestores = 0
            return
        }

        guard let bottomY = geometry.restoredBottomOffset(
            after: previous,
            maintainsBottomAnchor: maintainsBottomAnchor,
            isInteracting: isDragging || isDecelerating || isRestoringBottomAnchor,
            consecutiveRestores: consecutiveAnchorRestores
        ) else {
            return
        }
        guard abs(contentOffset.y - bottomY) > 0.5 else { return }

        consecutiveAnchorRestores += 1
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


struct FeatureMessageView: View {
    let message: FeatureMessage
    /// The line under a user bubble. A message still waiting on its echo reads
    /// as sending even before the outbox has said more.
    var caption: ThreadMessageCaption? = nil
    var onRetrySend: () -> Void = {}

    private var resolvedCaption: ThreadMessageCaption? {
        if caption?.isDelivery == true { return caption }
        if message.state == .queued { return .sending(uploading: false) }
        return caption
    }

    /// Tail at the top-leading corner — the mirror of the user bubble's
    /// bottom-trailing tail.
    private var agentAuthoredShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 4,
            bottomLeadingRadius: 16,
            bottomTrailingRadius: 16,
            topTrailingRadius: 16
        )
    }

    var body: some View {
        switch message.role {
        case .user where message.isAgentAuthored:
            // Sent into this thread by another agent, not by the reader:
            // mirrored to the agent side with a byline, so "I never wrote
            // that" bubbles stop wearing the reader's color. Matches the RN
            // feed's treatment.
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Sent by another agent")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)

                    VStack(alignment: .leading, spacing: 10) {
                        FeatureMessageAttachmentsView(attachments: message.attachments)
                        if !message.text.isEmpty {
                            ReviewContextMessageText(
                                source: message.text,
                                isStreaming: message.state == .streaming
                            )
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .frame(maxWidth: T3Metrics.readingWidth * 0.88, alignment: .leading)
                    .background(
                        T3Colors.surface,
                        in: agentAuthoredShape
                    )
                    .overlay {
                        agentAuthoredShape.stroke(T3Colors.border, lineWidth: 1)
                    }
                }
                Spacer(minLength: 44)
            }
            .accessibilityLabel("Another agent")
            .accessibilityValue(accessibilityValue)
            .accessibilityIdentifier("message-\(message.id)")
        case .user:
            HStack {
                Spacer(minLength: 44)
                VStack(alignment: .trailing, spacing: 4) {
                    VStack(alignment: .leading, spacing: 10) {
                        FeatureMessageAttachmentsView(attachments: message.attachments)
                        if !message.text.isEmpty {
                            ReviewContextMessageText(
                                source: message.text,
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
                            topTrailingRadius: 16,
                            style: .continuous
                        )
                    )
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("You")
                    .accessibilityValue(accessibilityValue)

                    if let resolvedCaption {
                        ThreadMessageCaptionView(caption: resolvedCaption, onRetry: onRetrySend)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("message-\(message.id)")
        case .assistant:
            // No "Working" line over a streaming reply: the composer band and
            // the subtitle already say it, and neither scrolls away.
            VStack(alignment: .leading, spacing: 10) {
                FeatureMessageAttachmentsView(attachments: message.attachments)
                if !message.text.isEmpty {
                    MarkdownMessageView(
                        message.text,
                        isStreaming: message.state == .streaming,
                        citationMessageID: message.wireMessageID,
                        timestamp: message.createdAt
                    )
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Assistant")
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
    @SwiftUI.Environment(\.markdownMediaContext) private var mediaContext
    @State private var previewedDocument: FeatureMessageAttachment?
    @State private var captureDetails: FeatureMessageAttachment?
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
                        } else if attachment.mimeType.hasPrefix("video/"), let url = attachment.url {
                            FeatureInlineVideoView(url: url, title: attachment.name)
                                .background(T3Colors.surfaceRaised)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }

                        if let source = attachment.source {
                            Button { captureDetails = attachment } label: {
                                HStack(spacing: 7) {
                                    if let data = source.appIconData, let icon = UIImage(data: data) {
                                        Image(uiImage: icon).resizable().scaledToFit().frame(width: 28, height: 28)
                                    } else {
                                        Image(systemName: "macwindow").frame(width: 28, height: 28)
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(source.appName).font(T3Typography.supportingStrong)
                                        Text(source.windowTitle.isEmpty ? "Captured window" : source.windowTitle)
                                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).lineLimit(2)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: source.accessibilityDetails == nil ? "photo" : "text.alignleft")
                                }.frame(minHeight: T3Metrics.minimumTapTarget)
                            }.buttonStyle(.plain).accessibilityLabel("Capture details from \(source.appName)")
                        }
                        if FeatureFilePreviewPath.isDocument(attachment.name), mediaContext?.resolveDocumentURL != nil {
                            Button { previewedDocument = attachment } label: {
                                Label("Preview document", systemImage: "doc.richtext").font(T3Typography.supportingStrong)
                                    .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
                            }.buttonStyle(.plain).accessibilityLabel("Preview \(attachment.name)")
                        }
                        HStack(spacing: 9) {
                            Image(
                                systemName: FeatureAttachmentGlyph.systemImage(
                                    mimeType: attachment.mimeType,
                                    name: attachment.name
                                )
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
                    .accessibilityElement(
                        children: attachment.mimeType.hasPrefix("video/") || attachment.source != nil ? .contain : .combine
                    )
                    .accessibilityLabel(
                        attachment.mimeType.hasPrefix("image/")
                            ? "Image attachment"
                            : attachment.mimeType.hasPrefix("video/")
                                ? "Video attachment"
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
            .sheet(item: $captureDetails) { attachment in
                if let source = attachment.source {
                    NavigationStack {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                Text(source.appName).font(.headline)
                                Text(source.windowTitle).foregroundStyle(T3Colors.textSecondary)
                                Text(source.accessibilityDetails ?? "The captured window did not include accessibility data.")
                                    .font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding()
                        }.background(T3Colors.background).navigationTitle("Capture details")
                            .navigationBarTitleDisplayMode(.inline)
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { captureDetails = nil } } }
                    }
                }
            }
            .sheet(item: $previewedDocument) { attachment in
                if let resolve = mediaContext?.resolveDocumentURL {
                    FeatureDocumentAttachmentPreview(attachment: attachment, resolve: resolve)
                }
            }
            .fullScreenCover(item: $previewedAttachment) { attachment in
                let images = attachments.compactMap { item -> MarkdownInlineImage? in
                    guard item.mimeType.hasPrefix("image/"), let url = item.url else { return nil }
                    return MarkdownInlineImage(alt: item.name, src: url.absoluteString)
                }
                if let url = attachment.url {
                    MarkdownGallerySheet(images: images, initial: MarkdownInlineImage(alt: attachment.name, src: url.absoluteString), context: nil)
                }
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
