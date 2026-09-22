import SwiftUI
import UIKit

struct FeatureWorkspaceNavigationRequest: Equatable, Sendable {
    enum Destination: Equatable, Sendable {
        case thread(id: String)
        case project(id: String)
        case newTask(projectID: String?)
    }

    let id: UUID
    let destination: Destination

    init(id: UUID = UUID(), destination: Destination) {
        self.id = id
        self.destination = destination
    }
}

/// Home: a tab per workspace (Code, Work, Chat) and a New tab that composes.
/// Each workspace tab is its own split view, so a thread opens inside the tab
/// it belongs to and every tab remembers where it was left.
public struct WorkspaceView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @Bindable var model: FeatureRootModel
    private let navigationRequest: FeatureWorkspaceNavigationRequest?
    private let onNavigationRequestConsumed: @MainActor (UUID) -> Void
    private let submitNewTask: (NewTaskRequest) async -> FeatureThread?
    private let submitMessage: (FeatureMessageSubmission) async -> Bool
    /// True while the model is still restoring its cache. The shell is already
    /// up with placeholder rows; navigation requests and compose wait.
    private let isAwaitingData: Bool

    @AppStorage(WorkspaceSwitcher.storageKey) private var storedWorkspace = MobileWorkspace.code
        .rawValue

    /// Each tab keeps its own open thread and column, so switching tabs returns
    /// to where that tab was left.
    @State private var selectedThreadIDs: [MobileWorkspace: String] = [:]
    @State private var compactColumns: [MobileWorkspace: NavigationSplitViewColumn] = [:]
    @State private var selectedProjectID: String?
    @State private var searchText = ""
    @State private var isSearchPresented = false
    /// Which workspace a search looks through. It starts at the tab the search
    /// was opened from; the scope bar can widen it to another.
    @State private var searchScope = MobileWorkspace.code
    // Persisted like the web sidebar's shelves: whether a shelf is open is a
    // lasting preference, not per-launch state. Defaults match web (settled
    // open; snoozed and archived out of the way).
    @AppStorage("workspace.snoozed-expanded") private var isSnoozedExpanded = false
    @AppStorage("workspace.settled-expanded") private var isSettledExpanded = true
    @AppStorage("workspace.archive-expanded") private var isArchiveExpanded = false
    @State private var settledLimit = 12
    @State private var showingNewTask = false
    @State private var newTaskDraftID: String?
    @State private var showingDrafts = false
    @State private var openingDraft = false
    @State private var newTaskDrafts: [FeatureComposerDraftStore.NewTaskDraftSummary] = []
    @State private var showingNewWorkConversation = false
    @State private var newTaskInitialProjectID: String?
    @State private var showingAddProject = false
    @State private var editingProjectIcon: FeatureProject?
    @State private var showingSettings = false
    /// Connection problems open Settings on Servers rather than its root.
    @State private var settingsOpensServers = false
    @State private var showingHermesSetup = false
    @State private var showingPullRequests = false
    @State private var showingArrangement = false
    @State private var renamingThread: FeatureThread?
    @State private var renameTitle = ""
    @State private var sidebarBoundaryNow = Date.now
    @State private var homePresentationCache = HomePresentationCache()
    @State private var threadListActions = ThreadListActions()
    /// One slot for every "here is what went wrong" message the list raises —
    /// a refused regeneration, a failed handoff script, a drop that can't land.
    /// They cannot overlap: each is the direct result of a single tap.
    @State private var noticeAlert: ThreadListActionAlert?
    @State private var draftKeys: Set<String> = []
    @State private var batchSelection: Set<String> = []
    @State private var isSelecting = false
    @State private var isBatchRunning = false
    @State private var confirmsBatchDelete = false
    @State private var confirmsBatchUnpin = false
    @State private var customSnoozeTargets: CustomSnoozeTargets?
    /// The last message-search answer and the query it answers.
    @State private var contentSearch: (query: String, matches: [String: FeatureThreadSearchMatch])?
    @State private var draftToDiscard: FeatureThread?
    @State private var pendingUnpinThread: FeatureThread?
    @State private var pendingDeleteThread: FeatureThread?
    /// The row whose leading Snooze swipe is asking for a wake time.
    @State private var snoozeRequestThread: FeatureThread?
    /// The banner's Reconnect is in flight.
    @State private var isReconnecting = false
    /// Handoff scripts being generated, so the menu can say so.
    @State private var generatingHandoffIDs: Set<String> = []

    public init(
        model: FeatureRootModel,
        submitNewTask: ((NewTaskRequest) async -> FeatureThread?)? = nil,
        submitMessage: ((FeatureMessageSubmission) async -> Bool)? = nil
    ) {
        self.init(
            model: model,
            navigationRequest: nil,
            onNavigationRequestConsumed: { _ in },
            submitNewTask: submitNewTask,
            submitMessage: submitMessage
        )
    }

    init(
        model: FeatureRootModel,
        navigationRequest: FeatureWorkspaceNavigationRequest?,
        onNavigationRequestConsumed: @escaping @MainActor (UUID) -> Void,
        isAwaitingData: Bool = false,
        submitNewTask: ((NewTaskRequest) async -> FeatureThread?)? = nil,
        submitMessage: ((FeatureMessageSubmission) async -> Bool)? = nil
    ) {
        self.model = model
        self.navigationRequest = navigationRequest
        self.onNavigationRequestConsumed = onNavigationRequestConsumed
        self.isAwaitingData = isAwaitingData
        self.submitNewTask = submitNewTask ?? { request in await model.startTask(request) }
        self.submitMessage = submitMessage ?? { submission in
            if submission.attachments.isEmpty {
                return await model.sendMessage(
                    threadID: submission.threadID,
                    text: submission.text,
                    selection: submission.selection
                )
            }
            do {
                try await model.client.sendMessage(
                    threadID: submission.threadID,
                    text: submission.text,
                    selection: submission.selection,
                    attachments: submission.attachments.map(\.uploadValue)
                )
                _ = await model.detail(for: submission.threadID, force: true)
                return true
            } catch {
                return false
            }
        }
    }

    public var body: some View {
        lifecycle(dialogs(sheets(homeTabs)))
    }

    // MARK: - Tabs

    @ViewBuilder
    private var homeTabs: some View {
        if #available(iOS 18, *) {
            TabView(selection: tabSelection) {
                Tab("Code", systemImage: MobileWorkspace.code.tabSymbol, value: HomeTab.workspace(.code)) {
                    workspaceTab(.code)
                }
                Tab("Work", systemImage: MobileWorkspace.work.tabSymbol, value: HomeTab.workspace(.work)) {
                    workspaceTab(.work)
                }
                .badge(workNeedsYouCount)
                Tab("Chat", systemImage: MobileWorkspace.chat.tabSymbol, value: HomeTab.workspace(.chat)) {
                    workspaceTab(.chat)
                }
                // Never shown: selecting it composes and the selection snaps
                // back. iPad keeps compose in the list's toolbar instead.
                Tab("New", systemImage: "plus", value: HomeTab.new, role: Self.newTabRole) {
                    Color.clear
                }
                .hidden(usesToolbarCompose)
            }
            .tabViewStyle(.sidebarAdaptable)
            .homeTabBarMinimizesOnScroll()
        } else {
            TabView(selection: tabSelection) {
                workspaceTab(.code)
                    .tabItem { Label("Code", systemImage: MobileWorkspace.code.tabSymbol) }
                    .tag(HomeTab.workspace(.code))
                workspaceTab(.work)
                    .tabItem { Label("Work", systemImage: MobileWorkspace.work.tabSymbol) }
                    .tag(HomeTab.workspace(.work))
                    .badge(workNeedsYouCount)
                workspaceTab(.chat)
                    .tabItem { Label("Chat", systemImage: MobileWorkspace.chat.tabSymbol) }
                    .tag(HomeTab.workspace(.chat))
                if !usesToolbarCompose {
                    Color.clear
                        .tabItem { Label("New", systemImage: "plus") }
                        .tag(HomeTab.new)
                }
            }
        }
    }

    /// iOS 27 draws a prominent tab as the detached circle beside the bar;
    /// before that + is an ordinary trailing tab. The role only exists in the
    /// iOS 27 SDK (Swift 6.4), so builds with an older Xcode take the
    /// ordinary tab on every system.
    @available(iOS 18, *)
    private static var newTabRole: TabRole? {
        #if compiler(>=6.4)
        if #available(iOS 27, *) { return .prominent }
        #endif
        return nil
    }

    /// A regular-width window has room for compose in the toolbar, where iPad
    /// apps keep it; the New tab would read as a sidebar destination there.
    private var usesToolbarCompose: Bool {
        horizontalSizeClass == .regular
    }

    /// Reads the remembered workspace and never reports `.new`: choosing New
    /// composes for the tab the user came from, and the tab bar snaps back.
    private var tabSelection: Binding<HomeTab> {
        Binding(
            get: { .workspace(workspace) },
            set: { tab in
                switch tab {
                case let .workspace(next):
                    selectWorkspace(next)
                case .new:
                    guard !isAwaitingData else { return }
                    openNewTaskOrProjectCreation()
                }
            }
        )
    }

    private func selectWorkspace(_ next: MobileWorkspace) {
        guard next != workspace else { return }
        endSearch()
        exitSelection()
        storedWorkspace = next.rawValue
    }

    private func workspaceTab(_ tab: MobileWorkspace) -> some View {
        NavigationSplitView(preferredCompactColumn: compactColumnBinding(for: tab)) {
            homeList(tab)
                .navigationSplitViewColumnWidth(
                    min: T3Metrics.minimumSidebarWidth,
                    ideal: T3Metrics.sidebarWidth,
                    max: T3Metrics.maximumSidebarWidth
                )
        } detail: {
            detail(tab)
        }
        .navigationSplitViewStyle(.balanced)
        // The tab owns the bar: its columns both stay alive, so neither the
        // list nor the thread can answer for it. See `HomeTabBar.visibility`.
        .toolbar(tabBarVisibility(for: tab), for: .tabBar)
    }

    private func tabBarVisibility(for tab: MobileWorkspace) -> Visibility {
        HomeTabBar.visibility(
            isCompact: horizontalSizeClass == .compact,
            showsThread: compactColumns[tab] == .detail && selectedThreadIDs[tab] != nil,
            isSelecting: tab == workspace && isSelecting
        )
    }

    private func compactColumnBinding(for tab: MobileWorkspace) -> Binding<NavigationSplitViewColumn> {
        Binding(
            get: { compactColumns[tab] ?? .sidebar },
            set: { compactColumns[tab] = $0 }
        )
    }

    // MARK: - List

    private func homeList(_ tab: MobileWorkspace) -> some View {
        let isCurrent = tab == workspace
        let isSearchingHere = isCurrent && isSearchActive
        let listWorkspace = isSearchingHere ? searchScope : tab
        let query = isSearchingHere ? searchText : ""
        // A tab that is not showing keeps its last presentation; its list skips
        // updates until it is selected again.
        let presentation = isCurrent
            ? presentation(for: listWorkspace, query: query)
            : homePresentationCache.latest(for: tab) ?? presentation(for: tab, query: "")
        let isSelectingHere = isCurrent && isSelecting
        let showsPlaceholders = !isSearchingHere
            && HomeLoadingState.showsPlaceholders(isLoading: isAwaitingData, snapshot: model.snapshot)
        let subtitle = isCurrent ? listSubtitle(tab, presentation: presentation) : nil
        let emptyState = isCurrent && presentation.isEmpty && !showsPlaceholders
            ? emptyState(for: tab)
            : nil
        let canArrange = tab != .chat && presentation.active.contains { $0.supportsActiveOrder == true }

        return HomeThreadCollectionView(
            presentation: presentation,
            changeRequests: model.changeRequestsByThreadID,
            workspace: listWorkspace,
            query: query,
            selectedThreadID: selectedThreadIDs[tab],
            forceRichRows: dynamicTypeSize.isAccessibilitySize,
            isSnoozedExpanded: isSnoozedExpanded,
            isSettledExpanded: isSettledExpanded,
            isArchiveExpanded: isArchiveExpanded,
            settledLimit: settledLimit,
            confirmThreadUnpin: model.snapshot.settings.confirmThreadUnpin,
            onOpen: { openThread($0, in: tab) },
            onToggleSnoozed: { isSnoozedExpanded.toggle() },
            onToggleSettled: { isSettledExpanded.toggle() },
            onToggleArchive: { isArchiveExpanded.toggle() },
            onShowMoreSettled: { settledLimit += 25 },
            onRename: { thread in
                renameTitle = thread.title
                renamingThread = thread
            },
            onArchive: { thread, archived in
                Task { await model.setArchived(thread.id, archived: archived) }
            },
            onSettle: { thread, settled in
                Task { await model.setSettled(thread.id, settled: settled) }
            },
            onSnooze: { thread, until in
                Task { await model.setSnoozed(thread.id, until: until) }
            },
            onPin: { thread, pinned in
                if !pinned, model.snapshot.settings.confirmThreadUnpin {
                    pendingUnpinThread = thread
                } else {
                    Task { await model.setPinned(thread.id, pinned: pinned) }
                }
            },
            onDelete: { pendingDeleteThread = $0 },
            onCopyHandoffScript: copyHandoffScript,
            onCopy: copyThreadDetail,
            onRegenerateTitle: regenerateTitle,
            draftKeys: draftKeys,
            isSelecting: isSelectingHere,
            batchSelection: batchSelection,
            onToggleSelection: toggleSelection,
            onBeginSelection: beginSelection,
            onDiscardDraft: { draftToDiscard = $0 },
            onDropFiles: { thread, providers in receiveThreadFileDrop(thread, providers: providers, in: tab) },
            onCustomSnooze: { customSnoozeTargets = CustomSnoozeTargets(threadIDs: [$0.id], isBatch: false) },
            onSnoozeRequest: { snoozeRequestThread = $0 },
            contentMatches: isSearchingHere ? currentContentMatches : [:],
            isSearchingContent: isSearchingHere && isSearchingContent,
            generatingHandoffIDs: generatingHandoffIDs,
            isActive: isCurrent,
            isPlaceholder: showsPlaceholders,
            subtitle: Self.subtitleIsInNavigationBar ? nil : subtitle,
            banner: isCurrent ? connectionBanner : nil,
            onReconnect: reconnect,
            onOpenConnections: openServerSettings,
            emptyState: emptyState,
            onEmptyAction: performEmptyAction,
            onRefresh: { await model.reload(reason: "pull-to-refresh") },
            isRegularWidth: horizontalSizeClass == .regular
        )
        // Rows run under the glass bars; UIKit insets the content to match.
        .ignoresSafeArea(.container, edges: .vertical)
        .background(sidebarIsGlass ? Color.clear : T3Colors.background)
        // Where the web sidebar keeps its Undo notice. Only the showing tab
        // hosts it, so one pill owns the undo manager registration.
        .overlay(alignment: .bottom) {
            if isCurrent { ThreadUndoPill(center: model.threadUndo) }
        }
        .navigationTitle(isSelectingHere ? selectionTitle : WorkspaceSwitcher.shortTitle(tab))
        .navigationBarTitleDisplayMode(.large)
        .homeNavigationSubtitle(subtitle ?? "")
        .toolbar {
            if isSelectingHere {
                selectionToolbar(presentation)
            } else {
                listToolbar(tab, canArrange: canArrange)
            }
        }
        .t3Searchable(
            text: $searchText,
            isPresented: searchPresentedBinding(for: tab),
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: Text(listWorkspace.searchPrompt)
        )
        .searchScopes($searchScope, activation: .onSearchPresentation) {
            ForEach(MobileWorkspace.allCases, id: \.self) { scope in
                Text(WorkspaceSwitcher.shortTitle(scope)).tag(scope)
            }
        }
        .t3NavigationChrome()
    }

    /// iPadOS 26 floats the sidebar as a glass pane; painting it would hide
    /// the glass.
    private var sidebarIsGlass: Bool {
        if #available(iOS 26, *) { return horizontalSizeClass == .regular }
        return false
    }

    /// Only the showing tab's search can be presented; the others read false.
    private func searchPresentedBinding(for tab: MobileWorkspace) -> Binding<Bool> {
        Binding(
            get: { tab == workspace && isSearchPresented },
            set: { if tab == workspace { isSearchPresented = $0 } }
        )
    }

    /// iOS 26 carries the subtitle in the navigation bar; before that it is the
    /// list's first row.
    private static var subtitleIsInNavigationBar: Bool {
        if #available(iOS 26, *) { return true }
        return false
    }

    private func listSubtitle(_ tab: MobileWorkspace, presentation: HomePresentation) -> String? {
        guard !isSearchActive else { return nil }
        return HomeListSubtitle.text(
            workspace: tab,
            projectName: selectedProject?.name,
            threads: presentation.pinned + presentation.active,
            connection: model.snapshot.connection,
            environmentName: HomeConnectionBanner.environmentName(in: model.snapshot)
        )
    }

    @ToolbarContentBuilder
    private func listToolbar(_ tab: MobileWorkspace, canArrange: Bool) -> some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            HomeAccountButton(status: connectionBanner?.tone) {
                if connectionBanner == nil { showingSettings = true } else { openServerSettings() }
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if usesToolbarCompose {
                Button {
                    openNewTaskOrProjectCreation()
                } label: {
                    Label(tab.newItemTitle, systemImage: "square.and.pencil")
                }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(isAwaitingData)
                .accessibilityHint(
                    tab == .code && creationProjects.isEmpty
                        ? "Add a project to start a task"
                        : "Compose a message and start a thread"
                )
                .accessibilityIdentifier("sidebar-new-task-button")
            }
            Button {
                isSearchPresented = true
            } label: {
                Label("Search", systemImage: "magnifyingglass")
            }
            .keyboardShortcut("f", modifiers: .command)
            .accessibilityIdentifier("sidebar-search-button")
            moreMenu(tab, canArrange: canArrange)
        }
    }

    /// Everything that used to be a row above the list: the project filter,
    /// and the actions reached for too rarely to deserve permanent space.
    private func moreMenu(_ tab: MobileWorkspace, canArrange: Bool) -> some View {
        Menu {
            if WorkspaceSwitcher.showsProjectFilter(tab), !filterableProjects.isEmpty {
                Section("Project") {
                    Picker("Project", selection: $selectedProjectID) {
                        Text("All Projects").tag(String?.none)
                        ForEach(filterableProjects) { project in
                            Text(projectMenuTitle(project)).tag(Optional(project.id))
                        }
                    }
                    .pickerStyle(.inline)
                    if let project = selectedProject, canChangeIcon(of: project) {
                        Button("Change Project Icon…", systemImage: "paintpalette") {
                            editingProjectIcon = project
                        }
                    }
                }
            }
            Section {
                Button("Select Threads", systemImage: "checkmark.circle", action: beginSelection)
                if canArrange {
                    Button("Arrange Threads", systemImage: "arrow.up.arrow.down") {
                        showingArrangement = true
                    }
                }
            }
            Section {
                if supportsPullRequests {
                    Button {
                        showingPullRequests = true
                    } label: {
                        Label("Pull Requests", symbol: T3Symbol.pullRequest)
                    }
                }
                Button(action: openDrafts) {
                    Label {
                        Text("Drafts")
                        if let draftsSubtitle { Text(draftsSubtitle) }
                    } icon: {
                        Image(systemName: "doc.text")
                    }
                }
            }
            Section {
                Button("Add Project…", systemImage: "folder.badge.plus") { showingAddProject = true }
                    .accessibilityIdentifier("sidebar-add-project-button")
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("sidebar-more-menu")
    }

    private var supportsPullRequests: Bool {
        model.client is any FeatureProjectPullRequestManaging
            && model.snapshot.environments.contains(where: { $0.supportsPullRequests == true })
    }

    private func canChangeIcon(of project: FeatureProject) -> Bool {
        model.snapshot.environments.first(where: { $0.id == project.environmentID })?.supportsProjectIcons == true
            && model.client is any FeatureProjectIconManaging
    }

    /// "2 drafts · 1 queued", or nothing when both are empty.
    private var draftsSubtitle: String? {
        var parts: [String] = []
        if !newTaskDrafts.isEmpty {
            parts.append(newTaskDrafts.count == 1 ? "1 draft" : "\(newTaskDrafts.count) drafts")
        }
        if model.outboxCount > 0 {
            parts.append("\(model.outboxCount) queued")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: - Selection

    private var selectionTitle: String {
        batchSelection.isEmpty ? "Select Threads" : "\(batchSelection.count) Selected"
    }

    private func beginSelection() {
        guard !isBatchRunning else { return }
        endSearch()
        isSelecting = true
    }

    private func toggleSelection(_ id: String) {
        guard !isBatchRunning else { return }
        isSelecting = true
        if !batchSelection.insert(id).inserted { batchSelection.remove(id) }
    }

    private func exitSelection() {
        guard !isBatchRunning else { return }
        isSelecting = false
        batchSelection.removeAll()
    }

    /// The rows Select All reaches: what the list is showing right now.
    private func selectableThreadIDs(in presentation: HomePresentation) -> [String] {
        var threads = presentation.pinned + presentation.active
        if isSnoozedExpanded { threads += presentation.snoozed }
        if isSettledExpanded { threads += presentation.settled.prefix(settledLimit) }
        if isArchiveExpanded { threads += presentation.archived }
        return threads.map(\.id)
    }

    private var selectedThreads: [FeatureThread] {
        model.snapshot.threads.filter { batchSelection.contains($0.id) }
    }

    @ToolbarContentBuilder
    private func selectionToolbar(_ presentation: HomePresentation) -> some ToolbarContent {
        let selectable = selectableThreadIDs(in: presentation)
        let selectsAll = !selectable.isEmpty && selectable.allSatisfy(batchSelection.contains)
        ToolbarItem(placement: .topBarLeading) {
            Button(selectsAll ? "Deselect All" : "Select All") {
                if selectsAll { batchSelection.removeAll() } else { batchSelection.formUnion(selectable) }
            }
            .disabled(isBatchRunning || selectable.isEmpty)
        }
        ToolbarItem(placement: .topBarTrailing) {
            selectionDoneButton
        }
        ToolbarItemGroup(placement: .bottomBar) {
            batchActions
        }
    }

    @ViewBuilder
    private var selectionDoneButton: some View {
        if #available(iOS 26, *) {
            Button(role: .confirm, action: exitSelection)
                .disabled(isBatchRunning)
                .accessibilityLabel("Done Selecting")
        } else {
            Button(action: exitSelection) {
                Text("Done").fontWeight(.semibold)
            }
            .disabled(isBatchRunning)
            .accessibilityLabel("Done Selecting")
        }
    }

    /// Each action is enabled when it applies to at least one selected thread;
    /// the rest of the selection is left alone and stays selected.
    @ViewBuilder
    private var batchActions: some View {
        let availability = HomeBatchAvailability.resolve(
            selectedThreads,
            workspace: workspace,
            now: .now,
            changeRequests: model.changeRequestsByThreadID
        )
        if isBatchRunning {
            HStack(spacing: 8) {
                ProgressView()
                Text(batchSelection.count == 1 ? "Updating 1 thread…" : "Updating \(batchSelection.count) threads…")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        } else {
            if workspace != .chat {
                Menu {
                    ForEach(SnoozePresets.resolve()) { preset in
                        Button {
                            // Recomputed at tap time, like the row menu.
                            guard let until = SnoozePresets.snoozedUntil(actionID: SnoozePresets.actionID(for: preset)) else { return }
                            snoozeSelection(until: until)
                        } label: {
                            Text(preset.label)
                            Text(preset.whenLabel)
                        }
                    }
                    Divider()
                    Button("Custom…", systemImage: "calendar") {
                        customSnoozeTargets = CustomSnoozeTargets(threadIDs: batchSelection.sorted(), isBatch: true)
                    }
                } label: {
                    Label("Snooze", systemImage: "moon.zzz")
                }
                .disabled(!availability.canSnooze)
                .accessibilityIdentifier("workspace-batch-snooze")
                Spacer()
                Button {
                    settleSelection()
                } label: {
                    Label("Settle", systemImage: "checkmark")
                }
                .disabled(!availability.canSettle)
                Spacer()
            }
            Button {
                archiveSelection()
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .disabled(!availability.canArchive)
            Spacer()
            if availability.canPin || !availability.canUnpin {
                Button {
                    runBatch { await model.setPinned($0, pinned: true) }
                } label: {
                    Label("Pin", systemImage: "pin")
                }
                .disabled(!availability.canPin)
            } else {
                Button {
                    if model.snapshot.settings.confirmThreadUnpin { confirmsBatchUnpin = true }
                    else { runBatch { await model.setPinned($0, pinned: false) } }
                } label: {
                    Label("Unpin", systemImage: "pin.slash")
                }
            }
            Spacer()
            Button(role: .destructive) {
                confirmsBatchDelete = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .disabled(batchSelection.isEmpty)
            .accessibilityIdentifier("workspace-batch-delete")
        }
    }

    /// Applies one action to every selected thread in turn. Threads it
    /// succeeds on leave the selection, so a retry only touches the rest.
    private func runBatch(
        failureMessage: String = "Failed threads remain selected. Check the connection and try again.",
        _ operation: @escaping (String) async -> Bool
    ) {
        guard !isBatchRunning else { return }
        isBatchRunning = true
        let ids = batchSelection.sorted()
        Task {
            for id in ids {
                if await operation(id) { batchSelection.remove(id) }
            }
            isBatchRunning = false
            if batchSelection.isEmpty {
                isSelecting = false
                PlatformHapticEngine.shared.play(.success)
            } else {
                PlatformHapticEngine.shared.play(.error)
                // A server refusal already raised the root alert; one alert
                // at a time.
                if model.errorMessage == nil {
                    noticeAlert = ThreadListActionAlert(title: "Some Threads Weren't Updated", message: failureMessage)
                }
            }
        }
    }

    /// Threads whose server cannot snooze them, or that are queued or Work's
    /// Main thread, stay selected rather than being sent a command the server
    /// would refuse.
    private func snoozeSelection(until: Date) {
        let snoozable = Set(model.snapshot.threads.filter { HomeBatchAvailability.canSnooze($0, in: workspace) }.map(\.id))
        runBatch(failureMessage: "Threads that can't be snoozed, or failed to update, remain selected.") { id in
            guard snoozable.contains(id) else { return false }
            return await model.setSnoozed(id, until: until)
        }
    }

    private func settleSelection() {
        let now = Date.now
        let settleable = Set(model.snapshot.threads.filter {
            HomeBatchAvailability.canSettle(
                $0,
                in: workspace,
                now: now,
                changeRequest: model.changeRequestsByThreadID[$0.id]
            )
        }.map(\.id))
        runBatch(failureMessage: "Threads that can't be settled, or failed to update, remain selected.") { id in
            guard settleable.contains(id) else { return false }
            return await model.setSettled(id, settled: true)
        }
    }

    /// A thread with a live provider run stays selected: archiving it would
    /// detach the run.
    private func archiveSelection() {
        let archivable = Set(model.snapshot.threads.filter { !$0.isArchived && $0.canArchive }.map(\.id))
        runBatch(failureMessage: "Running threads can't be archived. They remain selected.") { id in
            guard archivable.contains(id) else { return false }
            return await model.setArchived(id, archived: true)
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private func detail(_ tab: MobileWorkspace) -> some View {
        if let id = selectedThreadIDs[tab],
           let thread = model.snapshot.threads.first(where: { $0.id == id }) {
            ThreadDetailView(
                model: model,
                thread: thread,
                submitMessage: submitMessage,
                onNavigateBack: { closeSelectedThread(in: tab) },
                // Subagent cards, fork dividers and lineage rows all point at
                // another thread; an archived target also needs the shelf open
                // or it lands on a list that does not contain it.
                onOpenRelatedThread: { threadID, isArchived in
                    if isArchived { isArchiveExpanded = true }
                    openThread(threadID, in: tab)
                }
            )
            .id(id)
        } else {
            ContentUnavailableView {
                Label(
                    tab == .code ? "No Thread Selected" : "No Conversation Selected",
                    systemImage: tab.tabSymbol
                )
            } description: {
                Text(tab == .code
                    ? "Choose a thread, or start a new task."
                    : "Choose a conversation, or start a new one.")
            } actions: {
                Button(tab.newItemTitle, action: openNewTaskOrProjectCreation)
                    .t3ProminentButtonStyle()
                    .disabled(isAwaitingData)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
        }
    }

    // MARK: - Presentations

    private func sheets(_ content: some View) -> some View {
        content
            .sheet(isPresented: $showingNewTask) {
                NewThreadView(
                    model: model,
                    submit: submitNewTask,
                    onCreated: { thread in
                        openThread(thread.id, in: .code)
                        showingNewTask = false
                    },
                    onCreateProject: openProjectCreation,
                    initialProjectID: newTaskInitialProjectID,
                    draftID: newTaskDraftID
                )
            }
            .sheet(isPresented: $showingDrafts, onDismiss: {
                if openingDraft { openingDraft = false; showingNewTask = true }
            }) {
                draftsSheet
            }
            .sheet(isPresented: $showingNewWorkConversation) {
                NewWorkConversationView(
                    model: model,
                    flavor: workspace == .chat ? .chat : .work,
                    submit: submitNewTask,
                    onCreated: { thread in
                        openThread(thread.id, in: workspace)
                        showingNewWorkConversation = false
                    }
                )
            }
            .sheet(item: $editingProjectIcon) { project in
                if let manager = model.client as? any FeatureProjectIconManaging {
                    ProjectIconPickerView(project: project, manager: manager)
                }
            }
            .sheet(isPresented: $showingAddProject) {
                AddProjectView(model: model)
            }
            .sheet(isPresented: $showingPullRequests) {
                if let manager = model.client as? any FeatureProjectPullRequestManaging {
                    PullRequestWorkspaceView(model: model, manager: manager)
                }
            }
            .sheet(isPresented: $showingHermesSetup) { WorkSetupSheet(model: model) }
            .sheet(item: $customSnoozeTargets) { targets in
                CustomSnoozeSheet(threadCount: targets.threadIDs.count) { until in
                    if targets.isBatch {
                        snoozeSelection(until: until)
                    } else if let id = targets.threadIDs.first {
                        Task { await model.setSnoozed(id, until: until) }
                    }
                }
            }
            .sheet(isPresented: $showingSettings, onDismiss: { settingsOpensServers = false }) {
                SettingsView(model: model, initialRoute: settingsOpensServers ? .servers : nil)
            }
            .sheet(isPresented: $showingArrangement) {
                ActiveThreadArrangementSheet(model: model, workspace: workspace, projectID: activeProjectFilterID)
            }
    }

    private var draftsSheet: some View {
        NavigationStack {
            List {
                if model.outboxCount > 0 {
                    Section {
                        ForEach(model.outboxSubmissions) { submission in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(submission.text)
                                    .lineLimit(2)
                                    .foregroundStyle(T3Colors.textPrimary)
                                Text(model.outboxStatus(submission))
                                    .font(.caption)
                                    .foregroundStyle(T3Colors.textSecondary)
                            }
                            .swipeActions {
                                Button("Cancel Send", role: .destructive) {
                                    Task { await model.cancelOutbox(submission.id) }
                                }
                            }
                        }
                    } header: {
                        HStack {
                            Text("Outbox")
                            Spacer()
                            Button("Retry All") { model.retryOutbox() }
                                .font(.footnote.weight(.semibold))
                                .textCase(nil)
                        }
                    } footer: {
                        Text("Queued messages send on their own once their environment is reachable.")
                    }
                    .t3GroupedRow()
                }
                if !newTaskDrafts.isEmpty {
                    Section("Drafts") {
                        ForEach(newTaskDrafts) { draft in
                            Button {
                                openDraft(draftID: draft.draftID, projectID: draft.projectID)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(draft.title)
                                        .lineLimit(2)
                                        .foregroundStyle(T3Colors.textPrimary)
                                    Text(model.snapshot.projects.first(where: { $0.id == draft.projectID })?.name ?? "Project")
                                        .font(.caption)
                                        .foregroundStyle(T3Colors.textSecondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        .onDelete { offsets in
                            let removed = offsets.map { newTaskDrafts[$0] }
                            Task {
                                do {
                                    for draft in removed { try await FeatureComposerDraftStore.shared.removeDraft(for: draft.id) }
                                    newTaskDrafts = try await FeatureComposerDraftStore.shared.newTaskDrafts(projects: model.snapshot.projects)
                                } catch { noticeAlert = ThreadListActionAlert(title: "Couldn't Delete Draft", message: error.localizedDescription) }
                            }
                        }
                    }
                    .t3GroupedRow()
                }
            }
            .listStyle(.insetGrouped)
            .t3GroupedListBackground()
            .overlay {
                if model.outboxCount == 0, newTaskDrafts.isEmpty {
                    ContentUnavailableView {
                        Label("No Drafts", systemImage: "doc.text")
                    } description: {
                        Text("New tasks you start and don't send are kept here.")
                    } actions: {
                        Button("New Draft", action: startNewDraft)
                            .t3ProminentButtonStyle()
                    }
                }
            }
            .navigationTitle("Drafts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: startNewDraft) {
                        Label("New Draft", systemImage: "square.and.pencil")
                    }
                }
            }
            .t3SheetToolbar(.close) {
                newTaskInitialProjectID = nil
                showingDrafts = false
            }
            .t3NavigationChrome()
        }
    }

    private func dialogs(_ content: some View) -> some View {
        content
            .confirmationDialog(
                batchSelection.count == 1 ? "Delete 1 Selected Thread?" : "Delete \(batchSelection.count) Selected Threads?",
                isPresented: $confirmsBatchDelete,
                titleVisibility: .visible
            ) {
                Button(batchSelection.count == 1 ? "Delete Thread" : "Delete Threads", role: .destructive) {
                    runBatch { await model.deleteThread($0) }
                }
            } message: {
                Text("Thread history will be deleted. Worktree files stay on the environment. Failed threads remain selected.")
            }
            .confirmationDialog("Unpin Selected Threads?", isPresented: $confirmsBatchUnpin, titleVisibility: .visible) {
                Button("Unpin", role: .destructive) { runBatch { await model.setPinned($0, pinned: false) } }
            }
            .confirmationDialog(
                "Discard Unsent Draft?",
                isPresented: Binding(get: { draftToDiscard != nil }, set: { if !$0 { draftToDiscard = nil } }),
                titleVisibility: .visible
            ) {
                Button("Discard Draft", role: .destructive) {
                    guard let thread = draftToDiscard else { return }
                    draftToDiscard = nil
                    Task {
                        do { try await FeatureComposerDraftStore.shared.discardDraft(for: FeatureComposerDraftStore.threadKey(thread)) }
                        catch { noticeAlert = ThreadListActionAlert(title: "Couldn't Discard Draft", message: error.localizedDescription) }
                    }
                }
            }
            .confirmationDialog(
                pendingDeleteThread.map { "Delete “\($0.title)”?" } ?? "Delete Thread?",
                isPresented: Binding(
                    get: { pendingDeleteThread != nil },
                    set: { if !$0 { pendingDeleteThread = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingDeleteThread
            ) { thread in
                Button("Delete Thread", role: .destructive) {
                    pendingDeleteThread = nil
                    Task { await model.deleteThread(thread.id) }
                }
                Button("Cancel", role: .cancel) { pendingDeleteThread = nil }
            } message: { _ in
                Text("Its history will be deleted. Worktree files stay on the environment.")
            }
            .confirmationDialog(
                "Snooze Until",
                isPresented: Binding(
                    get: { snoozeRequestThread != nil },
                    set: { if !$0 { snoozeRequestThread = nil } }
                ),
                titleVisibility: .visible,
                presenting: snoozeRequestThread
            ) { thread in
                ForEach(SnoozePresets.resolve()) { preset in
                    Button("\(preset.label) · \(preset.whenLabel)") {
                        snoozeRequestThread = nil
                        guard let until = SnoozePresets.snoozedUntil(actionID: SnoozePresets.actionID(for: preset)) else { return }
                        Task { await model.setSnoozed(thread.id, until: until) }
                    }
                }
                Button("Custom…") {
                    snoozeRequestThread = nil
                    customSnoozeTargets = CustomSnoozeTargets(threadIDs: [thread.id], isBatch: false)
                }
                Button("Cancel", role: .cancel) { snoozeRequestThread = nil }
            }
            .alert(
                "Rename Thread",
                isPresented: Binding(
                    get: { renamingThread != nil },
                    set: { if !$0 { renamingThread = nil } }
                )
            ) {
                TextField("Thread title", text: $renameTitle)
                Button("Cancel", role: .cancel) { renamingThread = nil }
                Button("Save") {
                    guard let thread = renamingThread else { return }
                    let title = renameTitle
                    renamingThread = nil
                    Task { await model.renameThread(thread.id, title: title) }
                }
                .disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .alert(
                noticeAlert?.title ?? "",
                isPresented: Binding(
                    get: { noticeAlert != nil },
                    set: { if !$0 { noticeAlert = nil } }
                ),
                presenting: noticeAlert
            ) { _ in
                Button("OK") { noticeAlert = nil }
            } message: { notice in
                Text(notice.message)
            }
            .confirmationDialog(
                pendingUnpinThread.map { "Unpin “\($0.title)”?" } ?? "Unpin Thread?",
                isPresented: Binding(
                    get: { pendingUnpinThread != nil },
                    set: { if !$0 { pendingUnpinThread = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingUnpinThread
            ) { thread in
                Button("Unpin", role: .destructive) {
                    pendingUnpinThread = nil
                    Task { await model.setPinned(thread.id, pinned: false) }
                }
                Button("Cancel", role: .cancel) { pendingUnpinThread = nil }
            } message: { _ in
                Text("This thread will return to its normal place in the list.")
            }
    }

    private func lifecycle(_ content: some View) -> some View {
        content
            .task {
                do {
                    for await keys in try await FeatureComposerDraftStore.shared.draftPresence() {
                        draftKeys = keys
                        newTaskDrafts = try await FeatureComposerDraftStore.shared.newTaskDrafts(projects: model.snapshot.projects)
                    }
                } catch { noticeAlert = ThreadListActionAlert(title: "Drafts Unavailable", message: error.localizedDescription) }
            }
            .environment(\.pullRequestHandoff, (model.client is any FeaturePullRequestThreadPreparing) ? PullRequestHandoffHandler { scope, overview, kind, mode, selection in
                let threadID = try await model.stagePullRequestTask(scope: scope, overview: overview, kind: kind, mode: mode, selection: selection)
                showingPullRequests = false
                openThread(threadID, in: .code)
            } : nil)
            .onChange(of: selectedProjectIsAvailable) { _, isAvailable in
                if !isAvailable { selectedProjectID = nil }
            }
            .onChange(of: selectedProjectID) {
                settledLimit = 12
            }
            // A different workspace is a different list, so the settled shelf
            // starts from its own first page rather than inheriting the other's.
            .onChange(of: storedWorkspace) {
                settledLimit = 12
            }
            .onChange(of: isSearchPresented) { _, isPresented in
                if isPresented { searchScope = workspace }
            }
            .onChange(of: navigationRequest?.id, initial: true) { _, _ in
                consumeNavigationRequest()
            }
            // A request that arrives before its thread or project exists in the
            // snapshot stays pending; retry it as data lands so cold-start deep
            // links are not silently stranded.
            .onChange(of: model.homePresentationRevision) { _, _ in
                closeMissingThreads()
                if navigationRequest != nil { consumeNavigationRequest() }
            }
            .onChange(of: isAwaitingData) { _, _ in
                if navigationRequest != nil { consumeNavigationRequest() }
            }
            .onAppear {
                // The favicon store resolves through whichever client this session
                // runs on; re-pointing on every appearance keeps it current after
                // a reconnect swaps the client out.
                ProjectFaviconStore.shared.attach(model.client)
            }
            .task(id: nextSidebarBoundary) {
                guard let boundary = nextSidebarBoundary else { return }
                do {
                    try await Task.sleep(for: .seconds(max(0, boundary.timeIntervalSinceNow)))
                    sidebarBoundaryNow = max(.now, boundary)
                } catch {
                    return
                }
            }
            .task(id: searchText) { await searchThreadContent() }
            .task(id: currentChangeRequestThreadIDs) {
                model.observeChangeRequests(threadIDs: currentChangeRequestThreadIDs)
            }
    }

    // MARK: - Search

    private var isSearchActive: Bool {
        isSearchPresented || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func endSearch() {
        isSearchPresented = false
        searchText = ""
    }

    /// Debounced, and cancelled by the next keystroke through `.task(id:)`.
    private func searchThreadContent() async {
        guard let query = ThreadContentSearch.normalizedQuery(searchText),
              let searcher = model.client as? any FeatureThreadContentSearching else {
            contentSearch = nil
            return
        }
        do { try await Task.sleep(for: ThreadContentSearch.debounce) } catch { return }
        let matches = await searcher.searchThreadContent(query: query)
        guard !Task.isCancelled else { return }
        contentSearch = (query, matches)
    }

    /// Matches count only for the query they answer, so a previous answer never
    /// decorates rows while the next query is still debouncing.
    private var currentContentMatches: [String: FeatureThreadSearchMatch] {
        guard let contentSearch, contentSearch.query == ThreadContentSearch.normalizedQuery(searchText) else { return [:] }
        return contentSearch.matches
    }

    private var isSearchingContent: Bool {
        guard let query = ThreadContentSearch.normalizedQuery(searchText),
              model.client is any FeatureThreadContentSearching else { return false }
        return contentSearch?.query != query
    }

    // MARK: - Presentation

    private func presentation(for listWorkspace: MobileWorkspace, query: String) -> HomePresentation {
        homePresentationCache.presentation(
            snapshot: model.snapshot,
            revision: model.homePresentationRevision,
            workspace: listWorkspace,
            query: query,
            projectID: WorkspaceSwitcher.projectFilter(listWorkspace, selectedProjectID: selectedProjectID),
            now: sidebarBoundaryNow,
            changeRequests: model.changeRequestsByThreadID,
            contentMatchIDs: query.isEmpty ? [] : Set(currentContentMatches.keys)
        )
    }

    /// Blocked-on-you Work, badged on the Work tab so it shows from Code and
    /// Chat too.
    private var workNeedsYouCount: Int {
        let work = presentation(for: .work, query: "")
        return (work.pinned + work.active)
            .filter { $0.homeStatus == .approval || $0.homeStatus == .input }
            .count
    }

    private var connectionBanner: HomeConnectionBanner? {
        HomeConnectionBanner.resolve(snapshot: model.snapshot, isReconnecting: isReconnecting)
    }

    private func openServerSettings() {
        settingsOpensServers = true
        showingSettings = true
    }

    private func reconnect() {
        guard !isReconnecting else { return }
        isReconnecting = true
        Task {
            await model.reload(reason: "reconnect-button")
            isReconnecting = false
        }
    }

    private func emptyState(for tab: MobileWorkspace) -> HomeEmptyState {
        let hermesReady: Bool
        if tab == .code {
            hermesReady = true
        } else if case .hermesUnavailable = WorkspaceSwitcher.newTaskIntent(
            workspace: tab,
            selectedProjectID: nil,
            projects: workspaceProjects,
            serverConfigs: workspaceServerConfigs,
            requiredEnvironmentID: nil
        ) {
            hermesReady = false
        } else {
            hermesReady = true
        }
        return HomeEmptyState.resolve(
            workspace: tab,
            hasCreationProjects: !creationProjects.isEmpty,
            filteredProjectName: tab == .code ? selectedProject?.name : nil,
            hermesReady: hermesReady
        )
    }

    private func performEmptyAction(_ action: HomeEmptyState.Action) {
        switch action {
        case .addProject: showingAddProject = true
        case .newItem: openNewTaskOrProjectCreation()
        case .showAllProjects: selectedProjectID = nil
        case .setUpHermes: showingHermesSetup = true
        }
    }

    /// Only the Code workspace labels a row with its change request, and each
    /// subscribed thread costs one status stream on the server — so this covers
    /// the live rows a Code list leads with, newest first, and stops there. The
    /// parked shelves below use the slim row, which shows no branch to replace.
    private static let changeRequestRowLimit = 30

    private var currentChangeRequestThreadIDs: [String] {
        guard workspace == .code else { return [] }
        return changeRequestThreadIDs(in: presentation(for: .code, query: ""))
    }

    private func changeRequestThreadIDs(in presentation: HomePresentation) -> [String] {
        let live = (presentation.pinned + presentation.active)
            .prefix(Self.changeRequestRowLimit)
            .map(\.id)
        // A merged or closed change request is itself what parks a row on the
        // Settled shelf. Dropping its subscription the moment the row settles
        // would forget that state and bounce the row straight back to Active,
        // so rows that settled while observed stay observed.
        let settledWithKnownRequest = presentation.settled
            .map(\.id)
            .filter { model.changeRequestsByThreadID[$0] != nil }
        var seen = Set<String>()
        // Membership is chosen by list order (the prefix above), but the result
        // is sorted: `.task(id:)` and the model compare this array, and active
        // rows reorder on every agent turn — a mere reorder must not read as a
        // different subscription set and restart every vcs status stream.
        return (live + settledWithKnownRequest)
            .filter { seen.insert($0).inserted }
            .sorted()
    }

    private var workspace: MobileWorkspace {
        WorkspaceSwitcher.stored(storedWorkspace)
    }

    /// Work keeps the remembered Code selection rather than clearing it, so
    /// switching back lands where the user left off.
    private var activeProjectFilterID: String? {
        WorkspaceSwitcher.projectFilter(workspace, selectedProjectID: selectedProjectID)
    }

    /// The Home projects as the routing model reads them. `OrchestrationProject.id`
    /// carries the *feature* id here so a resolved Hermes target names a project
    /// this view can actually open.
    private var workspaceProjects: [MobileWorkspaceProject] {
        model.snapshot.projects.map { project in
            MobileWorkspaceProject(
                environmentID: project.environmentID,
                project: OrchestrationProject(
                    id: project.id,
                    title: project.name,
                    workspaceRoot: project.path,
                    repositoryIdentity: nil,
                    defaultModelSelection: nil,
                    faviconPath: project.faviconPath,
                    projectIcon: project.projectIcon,
                    scripts: project.scripts,
                    createdAt: "",
                    updatedAt: "",
                    deletedAt: nil
                )
            )
        }
    }

    /// Empty until a client capability surfaces `ServerConfigSnapshot` — and in
    /// particular its `t3WorkDirectory` — to the feature layer. The snapshot
    /// carries provider drivers but not the server's Work checkout, and without
    /// that there is no way to tell the backing project apart from any other, so
    /// a Work launch honestly reports itself unavailable rather than attaching
    /// the conversation to an arbitrary project.
    /// Ordered by the saved-environment list, because Hermes routing takes the
    /// first environment that can host the conversation — an unordered source
    /// would make the chosen project depend on hashing.
    private var workspaceServerConfigs: [MobileWorkspaceEnvironmentConfig] {
        model.client.workspaceServerConfigs()
    }

    private var selectedProject: FeatureProject? {
        filterableProjects.first { $0.id == selectedProjectID }
    }

    private var creationProjects: [FeatureProject] {
        DailyUXCreationContext.projects(
            in: model.snapshot,
            serverConfigs: workspaceServerConfigs
        )
    }

    /// The projects the Code filter offers, which are the same ones a task can
    /// be started in: filtering to the Work checkout could only ever empty the
    /// list, since Work threads are not Code threads.
    private var filterableProjects: [FeatureProject] {
        let serverConfigs = workspaceServerConfigs
        return model.snapshot.projects.filter { project in
            !MobileWorkspaceRouting.isWorkBackingProject(
                environmentID: project.environmentID,
                workspaceRoot: project.path,
                serverConfigs: serverConfigs
            )
        }
    }

    private var nextSidebarBoundary: Date? {
        DailyUXSidebarRefresh.nextBoundary(
            for: model.snapshot.threads,
            after: sidebarBoundaryNow,
            changeRequests: model.changeRequestsByThreadID
        )
    }

    /// A filter remembered from before the Work checkout became identifiable
    /// reads as unavailable, so the existing reset clears it rather than leaving
    /// the list filtered to a project it no longer offers.
    private var selectedProjectIsAvailable: Bool {
        guard let selectedProjectID else { return true }
        return filterableProjects.contains { $0.id == selectedProjectID }
    }

    /// A thread deleted elsewhere closes in whichever tab had it open.
    private func closeMissingThreads() {
        let known = Set(model.snapshot.threads.map(\.id))
        for (tab, id) in selectedThreadIDs where !known.contains(id) {
            closeSelectedThread(in: tab)
        }
    }

    // MARK: - Actions

    private func receiveThreadFileDrop(_ thread: FeatureThread, providers: [NSItemProvider], in tab: MobileWorkspace) -> Bool {
        guard !isSelecting, !thread.isArchived,
            model.snapshot.threads.contains(where: { $0.id == thread.id && !$0.isArchived }) else { return false }
        let supported = providers.filter { ThreadFileDropBatch.supportedType($0) != nil }
        guard !supported.isEmpty else { return false }
        guard model.pendingThreadFileDrops[thread.id] == nil else {
            noticeAlert = ThreadListActionAlert(title: "Files Are Being Prepared", message: "Finish adding the previous drop before dropping more files on this thread.")
            openThread(thread.id, in: tab)
            return false
        }
        guard model.pendingThreadFileDrops.count < 8 else {
            noticeAlert = ThreadListActionAlert(title: "Too Many Pending Drops", message: "Open the threads with pending files before adding more.")
            return false
        }
        model.pendingThreadFileDrops[thread.id] = ThreadFileDropBatch(draftKey: FeatureComposerDraftStore.threadKey(thread), providers: supported)
        openThread(thread.id, in: tab)
        return true
    }

    private func openThread(_ id: String, in tab: MobileWorkspace) {
        selectedThreadIDs[tab] = id
        compactColumns[tab] = .detail
    }

    private func closeSelectedThread(in tab: MobileWorkspace) {
        selectedThreadIDs[tab] = nil
        compactColumns[tab] = .sidebar
    }

    @MainActor
    private func openProjectCreation() {
        showingNewTask = false
        showingAddProject = true
    }

    private func openDrafts() {
        Task {
            do {
                newTaskDrafts = try await FeatureComposerDraftStore.shared.newTaskDrafts(projects: model.snapshot.projects)
                showingDrafts = true
            } catch {
                noticeAlert = ThreadListActionAlert(title: "Couldn't Read Drafts", message: error.localizedDescription)
            }
        }
    }

    private func startNewDraft() {
        openDraft(draftID: UUID().uuidString, projectID: activeProjectFilterID)
    }

    /// The composer opens once the drafts sheet is gone, so the two sheets
    /// never fight over the same presentation.
    private func openDraft(draftID: String?, projectID: String?) {
        newTaskDraftID = draftID
        newTaskInitialProjectID = projectID
        openingDraft = true
        showingDrafts = false
    }

    private func openNewTaskOrProjectCreation() {
        openNewTaskOrProjectCreation(initialProjectID: nil)
    }

    private func openNewTaskOrProjectCreation(initialProjectID: String?) {
        newTaskDraftID = nil
        let intent = WorkspaceSwitcher.newTaskIntent(
            workspace: workspace,
            selectedProjectID: initialProjectID,
            projects: workspaceProjects,
            serverConfigs: workspaceServerConfigs,
            requiredEnvironmentID: nil
        )
        switch intent {
        case let .newTask(projectID):
            presentNewTask(projectID: projectID)
        case .hermesConversation:
            // Work gets its own compose screen: assistant-shaped, no project
            // or git chrome. It re-resolves the target itself.
            showingNewWorkConversation = true
        case .hermesUnavailable:
            showingHermesSetup = true
        }
    }

    private func presentNewTask(projectID: String?) {
        if creationProjects.isEmpty {
            showingAddProject = true
        } else {
            newTaskInitialProjectID = projectID
            showingNewTask = true
        }
    }

    /// The pasteboard write lives here rather than in ``ThreadListActions`` so
    /// the whole path stays testable without UIKit.
    private func copyHandoffScript(for thread: FeatureThread) {
        generatingHandoffIDs.insert(thread.id)
        Task { @MainActor in
            let outcome = await threadListActions.copyHandoffScript(threadID: thread.id) {
                try await model.client.generateHandoffScript(threadID: thread.id)
            }
            generatingHandoffIDs.remove(thread.id)
            switch outcome {
            case let .handoffScript(script, confirmation):
                UIPasteboard.general.string = script
                T3HUD.show(confirmation.title, systemImage: "doc.on.doc")
            case let .unsupported(alert), let .failed(alert):
                noticeAlert = alert
            case .alreadyRunning, .titleRegenerationRequested:
                break
            }
        }
    }

    /// Path, branch and thread id are already on the row, so these copies are a
    /// pasteboard write and a confirmation — no server round trip and nothing to
    /// serialise against. The value is resolved in ``ThreadCopy`` so the choice
    /// stays testable; only the write lives here.
    private func copyThreadDetail(for thread: FeatureThread, target: ThreadCopyTarget) {
        // The menu omits targets with nothing to copy, so a nil here means the
        // row changed under an open menu. Silent: there is nothing to report.
        guard let value = ThreadCopy.value(for: target, on: thread) else { return }
        UIPasteboard.general.string = value
        T3HUD.show(ThreadCopy.confirmation(for: target).title, systemImage: "doc.on.doc")
    }

    private func regenerateTitle(for thread: FeatureThread) {
        Task { @MainActor in
            let outcome = await threadListActions.regenerateTitle(
                threadID: thread.id,
                supported: thread.canRegenerateTitle
            ) {
                try await model.client.regenerateThreadTitle(id: thread.id)
            }
            switch outcome {
            case let .unsupported(alert), let .failed(alert):
                noticeAlert = alert
            // The new title streams in over the shell subscription, so an
            // accepted request has nothing left to report.
            case .alreadyRunning, .titleRegenerationRequested, .handoffScript:
                break
            }
        }
    }

    private func consumeNavigationRequest() {
        guard let navigationRequest, !isAwaitingData else { return }
        switch navigationRequest.destination {
        case let .thread(id):
            guard let thread = model.snapshot.threads.first(where: { $0.id == id }) else { return }
            dismissTransientPresentations()
            // The thread opens in the tab that lists it.
            let tab = WorkspaceSwitcher.workspace(
                of: thread,
                providerDrivers: WorkspaceSwitcher.providerDrivers(in: model.snapshot),
                fallbackEnvironmentID: WorkspaceSwitcher.fallbackEnvironmentID(in: model.snapshot)
            )
            showTab(tab)
            if thread.isArchived { isArchiveExpanded = true }
            openThread(id, in: tab)
        case let .project(id):
            guard model.snapshot.projects.contains(where: { $0.id == id }) else { return }
            dismissTransientPresentations()
            showTab(.code)
            selectedProjectID = id
            closeSelectedThread(in: .code)
        case let .newTask(projectID):
            if let projectID,
               model.snapshot.projects.contains(where: { $0.id == projectID }) {
                selectedProjectID = projectID
            }
            dismissTransientPresentations()
            Task { @MainActor in
                await Task.yield()
                // A link that names a project is asking for that project's task
                // sheet, whichever workspace happens to be selected — routing it
                // through the switcher would answer "Hermes is not ready" to a
                // request that never mentioned Work.
                if let projectID {
                    presentNewTask(projectID: projectID)
                } else {
                    openNewTaskOrProjectCreation(initialProjectID: nil)
                }
            }
        }
        onNavigationRequestConsumed(navigationRequest.id)
    }

    /// Switches tabs for a deep link, leaving search and selection behind.
    private func showTab(_ tab: MobileWorkspace) {
        guard tab != workspace else { return }
        endSearch()
        isSelecting = false
        batchSelection.removeAll()
        storedWorkspace = tab.rawValue
    }

    private func dismissTransientPresentations() {
        showingNewTask = false
        showingAddProject = false
        showingSettings = false
        renamingThread = nil
    }

    private func projectMenuTitle(_ project: FeatureProject) -> String {
        guard model.snapshot.environments.count > 1,
              let environment = model.snapshot.environments.first(where: {
                  $0.id == project.environmentID
              }) else {
            return project.name
        }
        return "\(project.name) · \(environment.name)"
    }
}

private extension View {
    /// iOS 26 minimizes the tab bar to its current tab while a list scrolls
    /// down; earlier systems keep the bar.
    @ViewBuilder
    func homeTabBarMinimizesOnScroll() -> some View {
        if #available(iOS 26, *) {
            tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
    }

    /// The list's subtitle under the large title, where the system has one
    /// (iOS 26). Always applied, never conditional on the text, so the list
    /// underneath keeps its identity when the subtitle comes and goes.
    @ViewBuilder
    func homeNavigationSubtitle(_ subtitle: String) -> some View {
        if #available(iOS 26, *) {
            navigationSubtitle(subtitle)
        } else {
            self
        }
    }
}

private extension FeatureDraftAttachment {
    var uploadValue: FeatureUploadAttachment {
        FeatureUploadAttachment(data: data, name: filename, mimeType: mimeType)
    }
}

/// Who a custom snooze applies to: one row's thread, or the batch selection.
private struct CustomSnoozeTargets: Identifiable {
    let id = UUID()
    let threadIDs: [String]
    let isBatch: Bool
}

struct HomePresentation {
    let pinned: [FeatureThread]
    let active: [FeatureThread]
    let snoozed: [FeatureThread]
    let settled: [FeatureThread]
    let archived: [FeatureThread]
    /// Threads the query matches by title, preview, project or pull request.
    let searchTitleResults: [FeatureThread]
    /// Threads only the server's message search found; listed under their own
    /// heading, after the title matches.
    let searchMessageResults: [FeatureThread]
    let rowContexts: [String: HomeThreadRowContext]

    var searchResults: [FeatureThread] { searchTitleResults + searchMessageResults }

    /// Nothing on any shelf: the list shows its empty state instead.
    var isEmpty: Bool {
        pinned.isEmpty && active.isEmpty && snoozed.isEmpty && settled.isEmpty && archived.isEmpty
    }

    init(
        snapshot: FeatureSnapshot,
        workspace: MobileWorkspace,
        query: String,
        projectID: String?,
        now: Date,
        changeRequests: [String: FeaturePullRequest] = [:],
        contentMatchIDs: Set<String> = []
    ) {
        // The two workspaces share one thread list; which rows belong to which
        // is decided here, before the shelves are built, so every shelf below
        // agrees about what it is looking at.
        let providerDrivers = WorkspaceSwitcher.providerDrivers(in: snapshot)
        let fallbackEnvironmentID = WorkspaceSwitcher.fallbackEnvironmentID(in: snapshot)
        var scoped = snapshot
        scoped.threads = WorkspaceSwitcher.threads(
            snapshot.threads,
            in: workspace,
            providerDrivers: providerDrivers,
            fallbackEnvironmentID: fallbackEnvironmentID,
            relationshipToParent: \.relationshipToParent
        )
        let index = DailyUXSidebarIndex(
            snapshot: scoped,
            query: "",
            projectID: projectID,
            now: now,
            changeRequests: changeRequests
        )
        // Archived rows never reach `WorkspaceSwitcher.threads` — it drops them
        // along with subagents — so the shelf splits them by workspace itself.
        let archived = snapshot.threads
            .filter { thread in
                guard thread.isArchived, !thread.isSubagentThread else { return false }
                guard projectID == nil || thread.projectID == projectID else { return false }
                return WorkspaceSwitcher.workspace(
                    of: thread,
                    providerDrivers: providerDrivers,
                    fallbackEnvironmentID: fallbackEnvironmentID
                ) == workspace
            }
            .sorted {
                if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
                return $0.id < $1.id
            }

        pinned = index.pinned
        if workspace == .chat {
            // Chat has no parking: a conversation someone snoozed or settled
            // elsewhere still just shows in the list.
            active = (index.active + index.snoozed + index.settled).sorted {
                if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
                return $0.id < $1.id
            }
            snoozed = []
            settled = []
        } else {
            active = index.active
            snoozed = index.snoozed
            settled = index.settled
        }
        self.archived = archived
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = DailyUXSidebarIndex.matchingThreadGroups(
            index.pinned + index.active + index.snoozed + index.settled + archived,
            snapshot: snapshot,
            query: normalizedQuery,
            contentMatchIDs: contentMatchIDs
        )
        searchTitleResults = matches.titles
        searchMessageResults = matches.messages
        rowContexts = HomeThreadRowContext.index(snapshot: snapshot)
    }
}

/// Home's presentations, a few at a time: each tab, the Work badge and a
/// search can each want a different one in the same render, and a single slot
/// would rebuild them in turn on every pass.
@MainActor
final class HomePresentationCache {
    private struct Key: Equatable {
        let revision: UInt64
        /// Part of the key because the workspace decides which threads the
        /// presentation contains. Without it, flipping the switcher hits the
        /// cache and the list silently keeps showing the other workspace.
        let workspace: MobileWorkspace
        let query: String
        let projectID: String?
        let now: Date
        /// Change-request state moves rows between Active and Settled, and it
        /// streams in outside `homePresentationRevision` — without it in the
        /// key, a PR merging would not re-sort the list until something else
        /// changed.
        let changeRequests: [String: FeaturePullRequest]
        let contentMatchIDs: Set<String>
    }

    /// Most recent last.
    private var entries: [(key: Key, presentation: HomePresentation)] = []
    private static let capacity = 6

    func presentation(
        snapshot: FeatureSnapshot,
        revision: UInt64,
        workspace: MobileWorkspace,
        query: String,
        projectID: String?,
        now: Date,
        changeRequests: [String: FeaturePullRequest] = [:],
        contentMatchIDs: Set<String> = []
    ) -> HomePresentation {
        let key = Key(
            revision: revision,
            workspace: workspace,
            query: query,
            projectID: projectID,
            now: now,
            changeRequests: changeRequests,
            contentMatchIDs: contentMatchIDs
        )
        if let index = entries.firstIndex(where: { $0.key == key }) {
            let entry = entries.remove(at: index)
            entries.append(entry)
            return entry.presentation
        }

        let presentation = HomePresentation(
            snapshot: snapshot,
            workspace: workspace,
            query: query,
            projectID: projectID,
            now: now,
            changeRequests: changeRequests,
            contentMatchIDs: contentMatchIDs
        )
        entries.append((key, presentation))
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
        return presentation
    }

    /// The last presentation built for a workspace, for a tab that is not on
    /// screen and so does not need a fresh one.
    func latest(for workspace: MobileWorkspace) -> HomePresentation? {
        entries.last { $0.key.workspace == workspace && $0.key.query.isEmpty }?.presentation
    }
}

/// A parked shelf's heading: "Snoozed 2", with a disclosure chevron that turns
/// as the shelf opens. Quiet on purpose; a collapsed shelf is the least
/// important thing on the screen.
struct HomeShelfHeader: View {
    let title: String
    let count: Int
    let isExpanded: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .foregroundStyle(T3Colors.textSecondary)
            Text("\(count)")
                .monospacedDigit()
                .foregroundStyle(T3Colors.textTertiary)
            Spacer(minLength: 8)
            // One glyph rotated, never two glyphs swapped: swapping replaces the
            // view and the arrow changes without travelling.
            Image(systemName: "chevron.right")
                .imageScale(.small)
                .foregroundStyle(T3Colors.textTertiary)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .animation(.easeInOut(duration: 0.2), value: isExpanded)
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 18)
        .padding(.top, 6)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
    }
}

struct HomeThreadRowContext: Equatable {
    let projectName: String
    /// Where the project's favicon resolves from; nil keeps the letter badge.
    let projectEnvironmentID: String?
    let projectWorkspaceRoot: String?
    /// The project's manually chosen icon, forwarded to favicon resolution as
    /// a cache-key hint so icon changes reach existing rows.
    let projectFaviconPath: String?
    var projectIcon: ProjectIconOverride? = nil
    let environmentLabel: String?
    var machineSymbol: String = "server.rack"
    let providerID: String
    let providerDriver: String
    let providerName: String
    let connectionState: FeatureConnection.State?
    /// The change request for this thread's branch, when it has one. Overlaid
    /// after the fact by whoever builds the rows: it arrives on its own
    /// subscription, long after the snapshot this context is indexed from.
    var pullRequest: FeaturePullRequest?
    /// Set only on a search result found by message content rather than title.
    var searchExcerpt: HomeThreadSearchExcerpt?
    /// Marks an archived thread among search results, where nothing else says
    /// it is archived. Rows on the Archived shelf do not need it.
    var showsArchivedBadge = false

    static let fallback = HomeThreadRowContext(
        projectName: "Project",
        projectEnvironmentID: nil,
        projectWorkspaceRoot: nil,
        projectFaviconPath: nil,
        environmentLabel: nil,
        providerID: "agent",
        providerDriver: "",
        providerName: "Agent",
        connectionState: nil
    )

    /// The row's environment is not live, so what it shows is its last known
    /// state.
    var isConnectionStale: Bool {
        connectionState == .connecting
            || connectionState == .reconnecting
            || connectionState == .disconnected
    }

    static func index(snapshot: FeatureSnapshot) -> [String: HomeThreadRowContext] {
        let projectByID = snapshot.projects.reduce(into: [String: FeatureProject]()) {
            $0[$1.id] = $1
        }
        let environmentByID = snapshot.environments.reduce(into: [String: FeatureEnvironment]()) {
            $0[$1.id] = $1
        }
        let providerByID = snapshot.providers.reduce(into: [String: FeatureProvider]()) {
            $0[$1.id] = $1
        }
        let activeEnvironmentID = snapshot.environments.first(where: \.isActive)?.id

        return snapshot.threads.reduce(into: [String: HomeThreadRowContext]()) { result, thread in
            let project = projectByID[thread.projectID]
            let environmentID = thread.environmentID ?? project?.environmentID
            let environment = environmentID.flatMap { environmentByID[$0] }
            let environmentLabel = (environment?.name ?? thread.environmentName)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let explicitProvider = thread.providerName?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let configuredProvider = thread.providerID.flatMap { providerByID[$0] }
            let providerName = (explicitProvider?.isEmpty == false ? explicitProvider : nil)
                ?? configuredProvider?.name
                ?? thread.providerID
                ?? "Agent"
            let providerID = thread.providerID ?? providerName
            let providerDriver = configuredProvider?.driver ?? thread.providerID ?? ""

            let connectionState: FeatureConnection.State?
            if environment?.isActive == true
                || environmentID == nil
                || activeEnvironmentID == nil
                || environmentID == activeEnvironmentID {
                connectionState = snapshot.connection.state
            } else {
                connectionState = environment?.connectionState
            }

            result[thread.id] = HomeThreadRowContext(
                projectName: project?.name ?? "Project",
                projectEnvironmentID: project?.environmentID,
                projectWorkspaceRoot: project?.path,
                projectFaviconPath: project?.faviconPath,
                projectIcon: project?.projectIcon,
                environmentLabel: environmentLabel?.isEmpty == false ? environmentLabel : nil,
                machineSymbol: environment?.machineSymbol ?? "server.rack",
                providerID: providerID,
                providerDriver: providerDriver,
                providerName: providerName,
                connectionState: connectionState
            )
        }
    }
}

struct FeatureThreadRow: View, Equatable {
    enum Style: Equatable {
        case rich
        case slim
        /// Chat rows: a conversation, not a task — title and the last thing
        /// said, no repo badge, no branch, no provenance.
        case conversation
        /// T3 Work rows: an inbox item, not a checkout — a status pill where a
        /// Code card names its repo, and what the work is doing where a Code
        /// card names its branch.
        case inbox
    }

    let thread: FeatureThread
    private let context: HomeThreadRowContext
    let isSelected: Bool
    let style: Style
    let now: Date
    let allowsMultilineTitle: Bool
    /// An unsent draft sits in this thread's composer.
    let hasDraft: Bool

    init(
        thread: FeatureThread,
        context: HomeThreadRowContext,
        isSelected: Bool = false,
        style: Style = .rich,
        now: Date = .now,
        allowsMultilineTitle: Bool = false,
        hasDraft: Bool = false
    ) {
        self.thread = thread
        self.context = context
        self.isSelected = isSelected
        self.style = style
        self.now = now
        self.allowsMultilineTitle = allowsMultilineTitle
        self.hasDraft = hasDraft
    }

    var body: some View {
        row(at: now)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(thread.title)
            .accessibilityValue(Self.accessibilityValue(thread: thread, context: context, style: style, now: now))
            .accessibilityHint(Self.accessibilityHint(for: style))
            .accessibilityIdentifier("thread-\(thread.id)")
            .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private func row(at now: Date) -> some View {
        Group {
            switch style {
            case .rich: richRow(at: now)
            case .slim: slimRow(at: now)
            case .conversation: conversationRow(at: now)
            case .inbox: inboxRow(at: now)
            }
        }
        .contentShape(Rectangle())
    }

    private func richRow(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                ProjectFaviconBadge(
                    environmentID: context.projectEnvironmentID,
                    workspaceRoot: context.projectWorkspaceRoot,
                    faviconPath: context.projectFaviconPath,
                    projectIcon: context.projectIcon, projectTitle: context.projectName
                ) {
                    ProjectBadge(name: context.projectName)
                }
                Text(context.projectName)
                    .lineLimit(1)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 8)
                status(at: now)
            }
            .font(T3Typography.homeMetadata.weight(.medium))
            .frame(minHeight: 20)

            Text(thread.title)
                .font(T3Typography.homeTitle)
                .tracking(-0.14)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(allowsMultilineTitle ? 2 : 1)
                .padding(.top, 4)

            metaLine
                .font(T3Typography.homeMetadata)
                .foregroundStyle(T3Colors.textTertiary)
                .frame(minHeight: 20)
                .padding(.top, 3)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 88)
        .background(
            isSelected ? T3Colors.subtleStrong : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
        .padding(.horizontal, 8)
    }

    /// Line three of a Code row: draft, change request or branch, environment,
    /// pin and harness. At accessibility sizes it stacks instead of running
    /// off the edge.
    private var metaLine: some View {
        let layout = allowsMultilineTitle
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 3))
            : AnyLayout(HStackLayout(spacing: 6))
        return layout {
            if hasDraft {
                draftMarker
            }
            branchOrChangeRequest
            if !allowsMultilineTitle {
                Spacer(minLength: 8)
            }
            HStack(spacing: 6) {
                if let environmentLabel = context.environmentLabel {
                    environmentStatus(environmentLabel)
                }
                if thread.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .imageScale(.small)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                providerIcon(size: 16)
            }
        }
    }

    private var branchOrChangeRequest: some View {
        HStack(spacing: 5) {
            // A t3-generated branch ("t3code/ffeef775") names nothing the row
            // does not already say. Once the work has a change request, that is
            // what this line reports instead.
            if let pullRequest = context.pullRequest {
                let stackSize = FeaturePullRequestLines.stackSize(thread.allLinkedPullRequests)
                let draft = pullRequest.state == "open" && pullRequest.isDraft == true
                let icon = stackSize != nil ? "square.3.layers.3d" : pullRequest.state == "merged" ? "arrow.triangle.merge" : pullRequest.state == "closed" ? "xmark.circle" : draft ? "pencil.circle" : T3Symbol.pullRequest
                let color = draft ? T3Colors.textSecondary : Self.pullRequestColor(pullRequest.state)
                Image(symbol: icon)
                    .imageScale(.small)
                    .foregroundStyle(color)
                Text(stackSize.map { "\($0)" } ?? "#\(pullRequest.number)")
                    .monospacedDigit()
                    .foregroundStyle(color)
                if stackSize == nil && thread.allLinkedPullRequests.count > 1 {
                    Text("+\(thread.allLinkedPullRequests.count - 1)")
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Text(pullRequest.title)
                    .lineLimit(1)
            } else {
                // Worktree checkouts get their own glyph (the desktop sidebar's
                // worktree indicator): the branch alone doesn't say the thread
                // runs on an isolated copy of the repo.
                Image(systemName: isWorktreeCheckout
                    ? "square.on.square"
                    : "arrow.triangle.branch")
                    .imageScale(.small)
                Text(branchLabel)
                    .lineLimit(1)
            }
        }
    }

    /// The environment a Code row runs on, spelled out when it is not live.
    private func environmentStatus(_ name: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: environmentIcon)
                .imageScale(.small)
            Text(environmentText(name))
                .lineLimit(1)
        }
        .foregroundStyle(environmentColor)
    }

    private func slimRow(at now: Date) -> some View {
        HStack(spacing: 9) {
            ProjectFaviconBadge(
                environmentID: context.projectEnvironmentID,
                workspaceRoot: context.projectWorkspaceRoot,
                faviconPath: context.projectFaviconPath,
                projectIcon: context.projectIcon, projectTitle: context.projectName
            ) {
                ProjectBadge(name: context.projectName)
            }
            .saturation(0)
            .opacity(0.48)
            VStack(alignment: .leading, spacing: 1) {
                (hasDraft ? draftPrefix : Text(""))
                    + Text(thread.title)
                        .foregroundStyle(T3Colors.textSecondary)
                if context.isConnectionStale, let environmentLabel = context.environmentLabel {
                    environmentStatus(environmentLabel)
                        .font(T3Typography.homeMetadata)
                }
            }
            .font(T3Typography.homeTitle)
            .lineLimit(allowsMultilineTitle ? 2 : 1)
            Spacer(minLength: 8)
            if thread.pinnedAt != nil {
                Image(systemName: "pin.fill")
                    .imageScale(.small)
                    .font(T3Typography.homeMetadata)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            providerIcon(size: 15)
            dateColumn(at: now)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 44)
        .background(
            isSelected ? T3Colors.subtleStrong : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
        .padding(.horizontal, 8)
    }

    /// The Chat row: title and date on one line, the last thing said underneath.
    ///
    /// There is no meta line above the title, because every row in Chat would
    /// have filled it with the same word. What differs between conversations is
    /// what was last said, which is what every message list leads with.
    private func conversationRow(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if thread.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .imageScale(.small)
                        .font(T3Typography.homeMetadata)
                        .foregroundStyle(T3Colors.textSecondary)
                        .accessibilityHidden(true)
                }
                Text(thread.title)
                    .font(T3Typography.homeTitle)
                    .tracking(-0.14)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(allowsMultilineTitle ? 2 : 1)
                Spacer(minLength: 8)
                dateColumn(at: now)
            }

            Group {
                if thread.homeStatus == .working {
                    Text("Responding…")
                        .foregroundStyle(T3Colors.statusRunning)
                } else if let preview = previewLine {
                    (hasDraft ? draftPrefix : Text(""))
                        + preview
                } else if hasDraft {
                    draftPrefix
                }
            }
            .font(T3Typography.homeMetadata)
            .foregroundStyle(T3Colors.textTertiary)
            .lineLimit(2)

            if context.isConnectionStale, let environmentLabel = context.environmentLabel {
                environmentStatus(environmentLabel)
                    .font(T3Typography.homeMetadata)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(minHeight: 56)
        .background(
            isSelected ? T3Colors.subtleStrong : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
        .padding(.horizontal, 8)
    }

    /// The T3 Work row: a status pill where a Code card names its repo, and the
    /// last thing that happened where a Code card names its branch.
    ///
    /// Work threads all sit on one hidden backing checkout, so repo, branch and
    /// harness are identical on every row — three constants where the inbox
    /// needs to show which item is blocked on the user.
    private func inboxRow(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if let pill = workInboxPill {
                    WorkInboxPill(label: pill, systemImage: statusIcon, tint: statusColor)
                }
                if let duration = thread.homeWorkingDuration(at: now) {
                    Text(duration)
                        .font(T3Typography.homeMetadata.weight(.semibold).monospacedDigit())
                        .foregroundStyle(statusColor)
                }
                Spacer(minLength: 8)
                if thread.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .imageScale(.small)
                        .font(T3Typography.homeMetadata)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                dateColumn(at: now)
            }
            .frame(minHeight: 20)

            Text(thread.title)
                .font(T3Typography.homeTitle)
                .tracking(-0.14)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(allowsMultilineTitle ? 2 : 1)
                .padding(.top, 3)

            Group {
                if let preview = previewLine {
                    (hasDraft ? draftPrefix : Text("")) + preview
                } else if hasDraft {
                    draftPrefix
                }
            }
            .font(T3Typography.homeMetadata)
            .foregroundStyle(T3Colors.textTertiary)
            .lineLimit(1)
            .padding(.top, 2)

            if context.isConnectionStale, let environmentLabel = context.environmentLabel {
                environmentStatus(environmentLabel)
                    .font(T3Typography.homeMetadata)
                    .padding(.top, 2)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.vertical, 9)
        .frame(minHeight: 72)
        .background(
            isSelected ? T3Colors.subtleStrong : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
        // Mail's unread dot, for work that is blocked on the user.
        .overlay(alignment: .topLeading) {
            if thread.workInboxBadge?.wantsAttentionRail == true {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
                    .padding(.leading, 4)
                    .padding(.top, 16)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 8)
    }

    /// What a Work pill names: the actual ask (Approval, Input) rather than
    /// the section it already sits in.
    private var workInboxPill: String? {
        guard let badge = thread.workInboxBadge else { return nil }
        if badge == .needsYou { return thread.homeStatusLabel ?? badge.label }
        return badge.label
    }

    /// The last thing said, prefixed when it was the user who said it. Returns
    /// `Text` rather than a view so the prefix can be dimmed inside one
    /// truncating line instead of competing with it for width.
    private var previewLine: Text? {
        guard let preview = thread.preview?.trimmingCharacters(in: .whitespacesAndNewlines),
              !preview.isEmpty
        else { return nil }
        guard thread.previewIsFromUser else { return Text(preview) }
        return Text("You: ").foregroundStyle(T3Colors.textTertiary.opacity(0.65))
            + Text(preview)
    }

    /// Mail's inline "Draft", leading the line it belongs to.
    private var draftPrefix: Text {
        Text("Draft ")
            .fontWeight(.semibold)
            .foregroundStyle(T3Colors.accent)
    }

    private var draftMarker: some View {
        Text("Draft")
            .fontWeight(.semibold)
            .foregroundStyle(T3Colors.accent)
    }

    /// Status glyph, label and age: "Approval 4m", "Done 12m", "Working 3m".
    /// A ready row has no label, just its date.
    @ViewBuilder
    private func status(at now: Date) -> some View {
        if let label = thread.homeStatusLabel {
            HStack(spacing: 4) {
                if let icon = statusIcon {
                    Image(systemName: icon)
                        .imageScale(.small)
                        // One bounce when the status changes; never repeating.
                        .symbolEffect(.bounce, value: thread.homeStatus)
                }
                Text(label)
                if let duration = thread.homeWorkingDuration(at: now) {
                    Text(duration)
                        .monospacedDigit()
                } else {
                    Text(SidebarRelativeAge.compact(since: thread.updatedAt, now: now))
                        .monospacedDigit()
                        .fontWeight(.regular)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            .font(T3Typography.status)
            .foregroundStyle(statusColor)
        } else {
            dateColumn(at: now)
        }
    }

    /// The trailing date: when a snoozed thread wakes, "Archived" on an
    /// archived search result, otherwise how long ago it moved.
    @ViewBuilder
    private func dateColumn(at now: Date) -> some View {
        HStack(spacing: 4) {
            if context.showsArchivedBadge {
                Text("Archived")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(T3Colors.subtleStrong, in: Capsule())
            }
            if let wake = snoozeWake(at: now) {
                Image(systemName: "moon.zzz")
                    .imageScale(.small)
                Text(HomeRowDate.wake(wake, now: now))
                    .monospacedDigit()
            } else {
                Text(style == .conversation
                    ? HomeRowDate.conversation(thread.updatedAt, now: now)
                    : SidebarRelativeAge.compact(since: thread.updatedAt, now: now))
                    .monospacedDigit()
            }
        }
        .font(T3Typography.homeMetadata)
        .foregroundStyle(T3Colors.textTertiary)
    }

    private func snoozeWake(at now: Date) -> Date? {
        guard let snoozedUntil = thread.snoozedUntil, thread.isEffectivelySnoozed(at: now) else { return nil }
        return snoozedUntil
    }

    private var statusIcon: String? {
        switch thread.homeStatus {
        case .working, .background: "circle.dotted"
        case .approval: "hand.raised.fill"
        case .input: "questionmark.bubble"
        case .done: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .ready: nil
        }
    }

    private var statusColor: Color {
        switch thread.homeStatus {
        case .working: T3Colors.statusRunning
        // The running hue, dimmed: nothing is generating, something is merely
        // still out there.
        case .background: T3Colors.statusRunning.opacity(0.8)
        case .approval: T3Colors.warning
        case .input: T3Colors.statusInput
        case .failed: T3Colors.danger
        case .done: T3Colors.success
        case .ready: T3Colors.textTertiary
        }
    }

    private var environmentIcon: String {
        switch context.connectionState {
        case .connecting, .reconnecting:
            "wifi"
        case .disconnected:
            "wifi.slash"
        case .connected, nil:
            context.machineSymbol
        }
    }

    private var environmentColor: Color {
        switch context.connectionState {
        case .connecting, .reconnecting:
            T3Colors.warning
        case .disconnected:
            T3Colors.danger
        case .connected, nil:
            T3Colors.textTertiary
        }
    }

    private func environmentText(_ name: String) -> String {
        switch context.connectionState {
        case .connecting, .reconnecting: "\(name) · reconnecting"
        case .disconnected: "\(name) · last known state"
        case .connected, nil: name
        }
    }

    private var isWorktreeCheckout: Bool {
        guard let worktreePath = thread.worktreePath else { return false }
        return !worktreePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var branchLabel: String {
        HomeBranchLabel.display(branch: thread.branch, worktreePath: thread.worktreePath)
    }

    /// Open reads as live and merged as landed, matching how the other clients
    /// rank the two. Closed recedes: the palette has no violet, so merged takes
    /// the accent and a closed PR is simply quiet rather than alarming.
    static func pullRequestColor(_ state: String) -> Color {
        switch state {
        case "open": T3Colors.success
        case "merged": T3Colors.accent
        default: T3Colors.textTertiary
        }
    }

    private func providerIcon(size: CGFloat) -> some View {
        ProviderIcon(
            driver: context.providerDriver,
            providerID: context.providerID,
            fallbackName: context.providerName,
            size: size
        )
    }

    static func accessibilityHint(for style: Style) -> String {
        switch style {
        case .rich, .slim: "Opens task"
        case .conversation, .inbox: "Opens conversation"
        }
    }

    /// What VoiceOver reads after a row's title. Work and Chat rows say the
    /// same thing about project, branch and harness on every row, so they read
    /// what the row actually carries instead of three constants before the
    /// useful part.
    static func accessibilityValue(
        thread: FeatureThread,
        context: HomeThreadRowContext,
        style: Style,
        now: Date
    ) -> String {
        var values: [String] = []
        switch style {
        case .conversation:
            if thread.homeStatus == .working {
                values.append("Responding")
            }
            if let preview = thread.preview, !preview.isEmpty {
                values.append(thread.previewIsFromUser ? "You said: \(preview)" : preview)
            }
        case .inbox:
            values.append(thread.homeStatusLabel ?? "Ready")
            if let duration = thread.homeWorkingDuration(at: now) {
                values.append("for \(duration)")
            }
            if let preview = thread.preview, !preview.isEmpty {
                values.append(thread.previewIsFromUser ? "You said: \(preview)" : preview)
            }
        case .rich, .slim:
            values.append(thread.homeStatusLabel ?? "Ready")
            if let duration = thread.homeWorkingDuration(at: now) {
                values.append("for \(duration)")
            }
            values.append("Project \(context.projectName)")
            if let pullRequest = context.pullRequest {
                values.append(
                    "Pull request #\(pullRequest.number) \(pullRequest.state == "open" && pullRequest.isDraft == true ? "draft" : pullRequest.state). \(pullRequest.title)"
                )
            } else {
                let branch = HomeBranchLabel.display(branch: thread.branch, worktreePath: thread.worktreePath)
                let isWorktree = thread.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                values.append(isWorktree ? "Worktree branch \(branch)" : "Branch \(branch)")
            }
            if let environmentLabel = context.environmentLabel {
                values.append("on \(environmentLabel)")
            }
        }
        if thread.pinnedAt != nil {
            values.append("Pinned")
        }
        if let snoozedUntil = thread.snoozedUntil, thread.isEffectivelySnoozed(at: now) {
            values.append("Snoozed until \(HomeRowDate.wake(snoozedUntil, now: now))")
        } else if thread.homeWorkingDuration(at: now) == nil {
            values.append(SidebarRelativeAge.accessibility(since: thread.updatedAt, now: now))
        }
        if thread.isArchived {
            values.append("Archived")
        }
        if context.isConnectionStale {
            let name = context.environmentLabel ?? "Environment"
            values.append(context.connectionState == .disconnected
                ? "\(name) unreachable, last known state"
                : "\(name) reconnecting, last known state")
        }
        return values.joined(separator: ". ")
    }
}

/// The T3 Work row's status pill: what the work needs or is doing, in
/// sentence case at a size that scales.
private struct WorkInboxPill: View {
    let label: String
    let systemImage: String?
    let tint: Color

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage {
                Image(systemName: systemImage)
                    .imageScale(.small)
            }
            Text(label)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(tint.opacity(0.14), in: Capsule())
        .accessibilityHidden(true)
    }
}

private struct ProjectBadge: View {
    let name: String

    var body: some View {
        Text(label)
            .font(.system(size: 8, weight: .heavy))
            .foregroundStyle(foreground)
            .frame(width: 16, height: 16)
            .background(background, in: RoundedRectangle(cornerRadius: 4))
            .accessibilityHidden(true)
    }

    private var label: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "?" }
        if trimmed.lowercased().hasPrefix("t3") { return "T3" }
        return String(trimmed.prefix(1)).uppercased()
    }

    private var paletteIndex: Int {
        if label == "T3" { return 0 }
        return name.unicodeScalars.reduce(0) { ($0 + Int($1.value)) % 4 }
    }

    private var background: Color {
        switch paletteIndex {
        case 0: Color(red: 0.03, green: 0.24, blue: 0.21)
        case 1: Color(red: 0.19, green: 0.13, blue: 0.37)
        case 2: Color(red: 0.29, green: 0.18, blue: 0.02)
        default: Color(red: 0.10, green: 0.18, blue: 0.34)
        }
    }

    private var foreground: Color {
        switch paletteIndex {
        case 0: Color(red: 0.78, green: 0.98, blue: 0.95)
        case 1: Color(red: 0.93, green: 0.91, blue: 1)
        case 2: Color(red: 1, green: 0.95, blue: 0.78)
        default: Color(red: 0.82, green: 0.9, blue: 1)
        }
    }
}

/// Drag-to-reorder for the Active shelf. The order is stored on the server, so
/// every client sees the same arrangement.
private struct ActiveThreadArrangementSheet: View {
    @Bindable var model: FeatureRootModel
    let workspace: MobileWorkspace
    let projectID: String?
    @State private var rows: [FeatureThread] = []
    @State private var contexts: [String: HomeThreadRowContext] = [:]
    @State private var saving = false
    @State private var error: String?

    private var presentation: HomePresentation {
        HomePresentation(
            snapshot: model.snapshot,
            workspace: workspace,
            query: "",
            projectID: projectID,
            now: .now,
            changeRequests: model.changeRequestsByThreadID
        )
    }

    private var active: [FeatureThread] {
        presentation.active.filter { $0.supportsActiveOrder == true }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { SettingsErrorBanner(message: error) }
                }
                Section {
                    ForEach(rows) { thread in
                        ArrangementRow(
                            thread: thread,
                            context: contexts[thread.id] ?? .fallback,
                            showsProject: workspace == .code
                        )
                        .accessibilityAction(named: "Move Up") { move(thread.id, offset: -1) }
                        .accessibilityAction(named: "Move Down") { move(thread.id, offset: 1) }
                    }
                    .onMove { source, destination in
                        guard !saving, let index = source.first else { return }
                        let id = rows[index].id
                        rows.move(fromOffsets: source, toOffset: destination)
                        save(movedID: id)
                    }
                    .moveDisabled(saving)
                } footer: {
                    Text("Drag threads into the order you want to work through them.")
                }
                Section {
                    Button("Reset to Newest First", action: reset)
                        .disabled(saving || !rows.contains { $0.activeOrderKey != nil })
                }
            }
            .environment(\.editMode, .constant(.active))
            .t3GroupedListBackground()
            .overlay {
                if rows.isEmpty {
                    ContentUnavailableView(
                        "Nothing to Arrange",
                        systemImage: "arrow.up.arrow.down",
                        description: Text("Active threads you can reorder show up here.")
                    )
                }
            }
            .navigationTitle("Arrange Threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if saving {
                    ToolbarItem(placement: .status) {
                        HStack(spacing: 6) {
                            ProgressView()
                            Text("Saving…")
                                .font(.footnote)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .t3SheetToolbar(.close, hasChanges: saving)
            .onAppear(perform: reload)
            .onChange(of: active) { _, _ in if !saving { reload() } }
            .t3NavigationChrome()
        }
    }

    private func reload() {
        let presentation = presentation
        rows = presentation.active.filter { $0.supportsActiveOrder == true }
        contexts = presentation.rowContexts
    }

    private func move(_ id: String, offset: Int) {
        guard !saving, let index = rows.firstIndex(where: { $0.id == id }), rows.indices.contains(index + offset) else { return }
        rows.swapAt(index, index + offset)
        save(movedID: id)
    }

    private func save(movedID: String) {
        let writes = ThreadActiveOrder.assignments(ordered: rows, movedID: movedID, retained: model.snapshot.threads)
        saving = true
        error = nil
        Task {
            for (id, key) in writes {
                if !(await model.setActiveOrder(id, key: key)) {
                    error = "Couldn't save the new order. Try again."
                    PlatformHapticEngine.shared.play(.error)
                    break
                }
            }
            saving = false
            reload()
        }
    }

    private func reset() {
        guard !saving else { return }
        saving = true
        error = nil
        Task {
            for row in rows where row.activeOrderKey != nil {
                if !(await model.setActiveOrder(row.id, key: nil)) {
                    error = "Couldn't reset every thread. Try again."
                    PlatformHapticEngine.shared.play(.error)
                    break
                }
            }
            saving = false
            reload()
        }
    }
}

/// One thread in the arrangement sheet: enough to tell rows apart while
/// dragging, without the full Home row.
private struct ArrangementRow: View {
    let thread: FeatureThread
    let context: HomeThreadRowContext
    let showsProject: Bool

    var body: some View {
        HStack(spacing: 10) {
            if showsProject {
                ProjectFaviconBadge(
                    environmentID: context.projectEnvironmentID,
                    workspaceRoot: context.projectWorkspaceRoot,
                    faviconPath: context.projectFaviconPath,
                    projectIcon: context.projectIcon, projectTitle: context.projectName
                ) {
                    ProjectBadge(name: context.projectName)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        [showsProject ? context.projectName : nil, thread.homeStatusLabel]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}
