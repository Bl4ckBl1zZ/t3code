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

public struct WorkspaceView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @Bindable var model: FeatureRootModel
    private let navigationRequest: FeatureWorkspaceNavigationRequest?
    private let onNavigationRequestConsumed: @MainActor (UUID) -> Void
    private let submitNewTask: (NewTaskRequest) async -> FeatureThread?
    private let submitMessage: (FeatureMessageSubmission) async -> Bool

    @AppStorage(WorkspaceSwitcher.storageKey) private var storedWorkspace = MobileWorkspace.code
        .rawValue

    @State private var selectedThreadID: String?
    @State private var selectedProjectID: String?
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var isSnoozedExpanded = false
    @State private var isSettledExpanded = true
    @State private var isArchiveExpanded = false
    @State private var settledLimit = 12
    @State private var showingNewTask = false
    @State private var showingNewWorkConversation = false
    @State private var newTaskInitialProjectID: String?
    @State private var showingAddProject = false
    @State private var showingSettings = false
    @State private var renamingThread: FeatureThread?
    @State private var renameTitle = ""
    @State private var sidebarBoundaryNow = Date.now
    @State private var preferredCompactColumn = NavigationSplitViewColumn.sidebar
    @State private var homePresentationCache = HomePresentationCache()
    @State private var threadListActions = ThreadListActions()
    /// One slot for every "here is what happened" message the sidebar raises —
    /// a copied handoff script, a refused regeneration, an unconfigured Hermes.
    /// They cannot overlap: each is the direct result of a single tap.
    @State private var noticeAlert: ThreadListActionAlert?
    @FocusState private var isSearchFocused: Bool

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
        submitNewTask: ((NewTaskRequest) async -> FeatureThread?)? = nil,
        submitMessage: ((FeatureMessageSubmission) async -> Bool)? = nil
    ) {
        self.model = model
        self.navigationRequest = navigationRequest
        self.onNavigationRequestConsumed = onNavigationRequestConsumed
        self.submitNewTask = submitNewTask ?? { request in
            do {
                let thread = try await model.client.createThreadAndSend(
                    projectID: request.projectID,
                    prompt: request.trimmedPrompt,
                    selection: request.selection,
                    runtimeMode: request.runtimeMode,
                    interactionMode: request.interactionMode,
                    workspaceMode: request.workspaceMode,
                    branch: request.branch,
                    worktreePath: request.worktreePath,
                    startFromOrigin: request.startFromOrigin,
                    attachments: request.attachments.map(\.uploadValue)
                )
                await model.reload()
                return thread
            } catch {
                return nil
            }
        }
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
        NavigationSplitView(preferredCompactColumn: $preferredCompactColumn) {
            sidebar
                .navigationSplitViewColumnWidth(
                    min: T3Metrics.minimumSidebarWidth,
                    ideal: T3Metrics.sidebarWidth,
                    max: T3Metrics.maximumSidebarWidth
                )
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingNewTask) {
            NewThreadView(
                model: model,
                submit: submitNewTask,
                onCreated: { thread in
                    openThread(thread.id)
                    showingNewTask = false
                },
                onCreateProject: openProjectCreation,
                initialProjectID: newTaskInitialProjectID
            )
        }
        .sheet(isPresented: $showingNewWorkConversation) {
            NewWorkConversationView(
                model: model,
                flavor: workspace == .chat ? .chat : .work,
                submit: submitNewTask,
                onCreated: { thread in
                    openThread(thread.id)
                    showingNewWorkConversation = false
                }
            )
        }
        .sheet(isPresented: $showingAddProject) {
            AddProjectView(model: model)
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView(model: model)
        }
        .alert(
            "Rename thread",
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
        .onChange(of: selectedThreadIsAvailable) { _, isAvailable in
            if !isAvailable { closeSelectedThread() }
        }
        .onChange(of: selectedThreadID) { _, newValue in
            preferredCompactColumn = newValue == nil ? .sidebar : .detail
        }
        .onChange(of: selectedProjectIsAvailable) { _, isAvailable in
            if !isAvailable { selectedProjectID = nil }
        }
        .onChange(of: navigationRequest?.id, initial: true) { _, _ in
            consumeNavigationRequest()
        }
        // A request that arrives before its thread or project exists in the
        // snapshot stays pending; retry it as data lands so cold-start deep
        // links are not silently stranded.
        .onChange(of: model.homePresentationRevision) { _, _ in
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
    }

    private var sidebar: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                homeBar
                if isSearching {
                    searchBar
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                threadList
            }

            composeButton
                .padding(.trailing, 16)
                .padding(.bottom, 14)
        }
        .background(T3Colors.background)
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: selectedProjectID) {
            settledLimit = 12
        }
        // A different workspace is a different list, so the settled shelf starts
        // from its own first page rather than inheriting the other's.
        // Every workspace lands on its own list. Chat used to auto-open its most
        // recent conversation here, which read as the tab opening a thread on
        // its own; picking the thread is the user's call.
        .onChange(of: storedWorkspace) {
            settledLimit = 12
        }
    }

    private var threadList: some View {
        let presentation = homePresentationCache.presentation(
            snapshot: model.snapshot,
            revision: model.homePresentationRevision,
            workspace: workspace,
            query: searchText,
            projectID: activeProjectFilterID,
            now: sidebarBoundaryNow
        )

        let changeRequestThreadIDs = changeRequestThreadIDs(in: presentation)

        return VStack(spacing: 0) {
            if WorkspaceSwitcher.showsProjectFilter(workspace) {
                projectFilter
            }
            HomeThreadCollectionView(
                presentation: presentation,
                changeRequests: model.changeRequestsByThreadID,
                workspace: workspace,
                query: searchText,
                selectedThreadID: selectedThreadID,
                forceRichRows: dynamicTypeSize.isAccessibilitySize,
                isSnoozedExpanded: isSnoozedExpanded,
                isSettledExpanded: isSettledExpanded,
                isArchiveExpanded: isArchiveExpanded,
                settledLimit: settledLimit,
                onOpen: openThread,
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
                    Task { await model.setPinned(thread.id, pinned: pinned) }
                },
                onDelete: { thread in
                    Task { await model.deleteThread(thread.id) }
                },
                onCopyHandoffScript: copyHandoffScript,
                onRegenerateTitle: regenerateTitle
            )
        }
        .background(T3Colors.background)
        .task(id: changeRequestThreadIDs) {
            model.observeChangeRequests(threadIDs: changeRequestThreadIDs)
        }
    }

    /// Only the Code workspace labels a row with its change request, and each
    /// subscribed thread costs one status stream on the server — so this covers
    /// the live rows a Code list leads with, newest first, and stops there. The
    /// parked shelves below use the slim row, which shows no branch to replace.
    private static let changeRequestRowLimit = 30

    private func changeRequestThreadIDs(in presentation: HomePresentation) -> [String] {
        guard workspace == .code else { return [] }
        return (presentation.pinned + presentation.active)
            .prefix(Self.changeRequestRowLimit)
            .map(\.id)
    }

    @ViewBuilder
    private var detail: some View {
        if let id = selectedThreadID,
           let thread = model.snapshot.threads.first(where: { $0.id == id }) {
            ThreadDetailView(
                model: model,
                thread: thread,
                submitMessage: submitMessage,
                onNavigateBack: closeSelectedThread,
                // Subagent cards, fork dividers and lineage rows all point at
                // another thread; an archived target also needs the shelf open
                // or it lands on a list that does not contain it.
                onOpenRelatedThread: { threadID, isArchived in
                    if isArchived { isArchiveExpanded = true }
                    openThread(threadID)
                }
            )
            .id(id)
        } else {
            VStack(spacing: 14) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(T3Colors.textTertiary)
                Text("Start a task")
                    .font(.title3.weight(.semibold))
                Text("Choose a thread or compose something new.")
                    .font(.subheadline)
                    .foregroundStyle(T3Colors.textSecondary)
                Button("New task", action: openNewTaskOrProjectCreation)
                    .buttonStyle(.borderedProminent)
                    .tint(T3Colors.primaryAction)
                    .foregroundStyle(T3Colors.primaryActionForeground)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
        }
    }

    private var homeBar: some View {
        HStack(spacing: 2) {
            connectionBrand
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    isSearching.toggle()
                }
                if isSearching {
                    Task { @MainActor in
                        await Task.yield()
                        isSearchFocused = true
                    }
                } else {
                    searchText = ""
                    isSearchFocused = false
                }
            } label: {
                Image(systemName: isSearching ? "xmark" : "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 40, height: T3Metrics.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(T3Colors.textSecondary)
            .accessibilityLabel(isSearching ? "Close search" : "Search tasks")
            .accessibilityIdentifier("sidebar-search-button")

            Button { showingSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 40, height: T3Metrics.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(T3Colors.textSecondary)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("sidebar-settings-button")
        }
        .padding(.leading, 15)
        .padding(.trailing, 8)
        // Sized off the switcher rather than fixed, so the row keeps its margin
        // above and below the tallest thing in it.
        .frame(height: Self.workspaceSwitcherHeight + 12)
        .background(T3Colors.background)
    }

    @ViewBuilder
    private var connectionBrand: some View {
        if !unreachableEnvironments.isEmpty {
            HStack(spacing: 7) {
                Image(systemName: "network.slash")
                    .font(.system(size: 13, weight: .semibold))
                Text(unreachableBrandLabel)
                    .lineLimit(2)
                    .font(.system(size: 13, weight: .semibold))
                Button("Reconnect") {
                    Task { await model.reload() }
                }
                .font(.caption.weight(.bold))
                .buttonStyle(.plain)
                .padding(.horizontal, 9)
                .frame(height: 26)
                .overlay {
                    Capsule().stroke(T3Colors.danger.opacity(0.42), lineWidth: 1)
                }
            }
            .foregroundStyle(T3Colors.danger)
            .accessibilityElement(children: .contain)
        } else if let reconnecting = reconnectingEnvironments.first {
            Button { showingSettings = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 13, weight: .semibold))
                    Text(reconnecting.name)
                        .lineLimit(1)
                    Text("reconnecting")
                        .fontWeight(.medium)
                        .opacity(0.76)
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(T3Colors.warning)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(reconnecting.name) reconnecting")
        } else if model.snapshot.connection.state == .connecting
            || model.snapshot.connection.state == .reconnecting {
            Button { showingSettings = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 13, weight: .semibold))
                    Text(connectionEnvironmentName)
                        .lineLimit(1)
                    Text("reconnecting")
                        .fontWeight(.medium)
                        .opacity(0.76)
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(T3Colors.warning)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(connectionEnvironmentName) reconnecting")
        } else if model.snapshot.connection.state == .disconnected {
            HStack(spacing: 7) {
                Image(systemName: "network.slash")
                    .font(.system(size: 13, weight: .semibold))
                Text("\(connectionEnvironmentName) unreachable")
                    .lineLimit(2)
                    .font(.system(size: 13, weight: .semibold))
                Button("Reconnect") {
                    Task { await model.reload() }
                }
                .font(.caption.weight(.bold))
                .buttonStyle(.plain)
                .padding(.horizontal, 9)
                .frame(height: 26)
                .overlay {
                    Capsule().stroke(T3Colors.danger.opacity(0.42), lineWidth: 1)
                }
            }
            .foregroundStyle(T3Colors.danger)
            .accessibilityElement(children: .contain)
        } else {
            workspaceSwitcher
        }
    }

    /// Every workspace is always on screen. The switcher is a hosted
    /// `UISegmentedControl` — the system owns the sliding thumb, its animation
    /// and its glass treatment, which a hand-rolled matched-geometry copy never
    /// quite matched — sized up past what `.pickerStyle(.segmented)` allows,
    /// because switching surfaces is the header's primary action and the
    /// default segment font reads as a settings row.
    private var workspaceSwitcher: some View {
        HStack(spacing: 11) {
            Text("T3")
                .font(.system(size: 19, weight: .bold))
                .foregroundStyle(T3Colors.textPrimary)

            WorkspaceSegmentedControl(
                titles: MobileWorkspace.allCases.map(WorkspaceSwitcher.shortTitle),
                selectedIndex: workspaceSelection,
                font: .systemFont(ofSize: 16, weight: .semibold),
                height: Self.workspaceSwitcherHeight,
                segmentPadding: 14
            )
        }
        .frame(minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sidebar-workspace-switcher")
    }

    /// Tall enough to clear the 44pt tap target on its own rather than relying
    /// on the header row's padding to make up the difference.
    private static let workspaceSwitcherHeight: CGFloat = 44

    private var workspaceSelection: Binding<Int> {
        Binding(
            get: { MobileWorkspace.allCases.firstIndex(of: workspace) ?? 0 },
            set: { index in
                let candidates = MobileWorkspace.allCases
                guard candidates.indices.contains(index) else { return }
                storedWorkspace = candidates[index].rawValue
            }
        )
    }

    private var searchBar: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(T3Colors.textTertiary)
            TextField("Search tasks and projects", text: $searchText)
                .font(.subheadline)
                .foregroundStyle(T3Colors.textPrimary)
                .focused($isSearchFocused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("sidebar-search-field")
            if !searchText.isEmpty {
                Button { searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: T3Metrics.minimumTapTarget)
        .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(T3Colors.border, lineWidth: 1)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }

    private var composeButton: some View {
        Button {
            isSearchFocused = false
            openNewTaskOrProjectCreation()
        } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(T3Colors.primaryActionForeground)
                .frame(width: 52, height: 52)
                .background(T3Colors.primaryAction, in: Circle())
                .shadow(color: T3Colors.shadow, radius: 16, y: 8)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New task")
        .accessibilityHint(
            creationProjects.isEmpty
                ? "Create a project to start a task"
                : "Compose a message and start a thread"
        )
        .accessibilityIdentifier("sidebar-new-task-button")
    }

    private var projectFilter: some View {
        HStack(spacing: 0) {
            Menu {
                Button {
                    selectedProjectID = nil
                } label: {
                    if selectedProjectID == nil {
                        Label("All projects", systemImage: "checkmark")
                    } else {
                        Text("All projects")
                    }
                }
                ForEach(filterableProjects) { project in
                    Button {
                        selectedProjectID = project.id
                    } label: {
                        let title = projectMenuTitle(project)
                        if selectedProjectID == project.id {
                            Label(title, systemImage: "checkmark")
                        } else {
                            Text(title)
                        }
                    }
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "folder")
                        .font(.system(size: 13, weight: .medium))
                    Text(selectedProject?.name ?? "All projects")
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
            }
            .font(T3Typography.homeMetadata.weight(.semibold))
                .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Project filter")
            .accessibilityValue(selectedProject?.name ?? "All projects")
            .accessibilityIdentifier("sidebar-project-filter")

            Button { showingAddProject = true } label: {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: T3Metrics.minimumTapTarget, height: 34)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add project")
            .accessibilityIdentifier("sidebar-add-project-button")
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .accessibilityElement(children: .contain)
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

    private var connectionEnvironmentName: String {
        model.snapshot.connection.environmentName
            ?? model.snapshot.environments.first(where: \.isActive)?.name
            ?? model.snapshot.environments.first?.name
            ?? "Server"
    }

    private var unreachableEnvironments: [FeatureEnvironment] {
        model.snapshot.environments.filter { $0.connectionState == .disconnected }
    }

    private var reconnectingEnvironments: [FeatureEnvironment] {
        model.snapshot.environments.filter {
            $0.connectionState == .connecting || $0.connectionState == .reconnecting
        }
    }

    private var unreachableBrandLabel: String {
        if unreachableEnvironments.count == 1 {
            return "\(unreachableEnvironments[0].name) unreachable"
        }
        return "\(unreachableEnvironments.count) devices unreachable"
    }

    private var nextSidebarBoundary: Date? {
        DailyUXSidebarRefresh.nextBoundary(
            for: model.snapshot.threads,
            after: sidebarBoundaryNow
        )
    }

    private var selectedThreadIsAvailable: Bool {
        guard let selectedThreadID else { return true }
        return model.snapshot.threads.contains { $0.id == selectedThreadID }
    }

    /// A filter remembered from before the Work checkout became identifiable
    /// reads as unavailable, so the existing reset clears it rather than leaving
    /// the list filtered to a project it no longer offers.
    private var selectedProjectIsAvailable: Bool {
        guard let selectedProjectID else { return true }
        return filterableProjects.contains { $0.id == selectedProjectID }
    }

    private func openThread(_ id: String) {
        selectedThreadID = id
        preferredCompactColumn = .detail
    }

    private func closeSelectedThread() {
        selectedThreadID = nil
        preferredCompactColumn = .sidebar
    }

    @MainActor
    private func openProjectCreation() {
        showingNewTask = false
        showingAddProject = true
    }

    private func openNewTaskOrProjectCreation() {
        openNewTaskOrProjectCreation(initialProjectID: nil)
    }

    private func openNewTaskOrProjectCreation(initialProjectID: String?) {
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
        case let .hermesUnavailable(title, message):
            noticeAlert = ThreadListActionAlert(title: title, message: message)
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
        Task { @MainActor in
            let outcome = await threadListActions.copyHandoffScript(threadID: thread.id) {
                try await model.client.generateHandoffScript(threadID: thread.id)
            }
            switch outcome {
            case let .handoffScript(script, alert):
                UIPasteboard.general.string = script
                noticeAlert = alert
            case let .unsupported(alert), let .failed(alert):
                noticeAlert = alert
            case .alreadyRunning, .titleRegenerationRequested:
                break
            }
        }
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
        guard let navigationRequest else { return }
        switch navigationRequest.destination {
        case let .thread(id):
            guard model.snapshot.threads.contains(where: { $0.id == id }) else { return }
            dismissTransientPresentations()
            openThread(id)
        case let .project(id):
            guard model.snapshot.projects.contains(where: { $0.id == id }) else { return }
            dismissTransientPresentations()
            selectedProjectID = id
            closeSelectedThread()
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

private extension FeatureDraftAttachment {
    var uploadValue: FeatureUploadAttachment {
        FeatureUploadAttachment(data: data, name: filename, mimeType: mimeType)
    }
}

struct HomePresentation {
    let pinned: [FeatureThread]
    let active: [FeatureThread]
    let snoozed: [FeatureThread]
    let settled: [FeatureThread]
    let archived: [FeatureThread]
    let searchResults: [FeatureThread]
    let rowContexts: [String: HomeThreadRowContext]

    init(
        snapshot: FeatureSnapshot,
        workspace: MobileWorkspace,
        query: String,
        projectID: String?,
        now: Date
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
            now: now
        )
        // Archived rows never reach `WorkspaceSwitcher.threads` — it drops them
        // along with subagents — so the shelf splits them by workspace itself.
        let archived = snapshot.threads
            .filter { thread in
                guard thread.isArchived, !thread.isSubagentThread else { return false }
                guard projectID == nil || thread.projectID == projectID else { return false }
                let isHermes = WorkspaceSwitcher.isWorkThread(
                    thread,
                    environmentID: thread.environmentID ?? fallbackEnvironmentID,
                    providerDrivers: providerDrivers
                )
                switch workspace {
                case .code: return !isHermes
                case .work: return isHermes && thread.workInboxRole != "chat"
                case .chat: return isHermes && thread.workInboxRole == "chat"
                }
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
        searchResults = normalizedQuery.isEmpty
            ? []
            : DailyUXSidebarIndex.matchingThreads(
                index.pinned + index.active + index.snoozed + index.settled + archived,
                snapshot: snapshot,
                query: normalizedQuery
            )
        rowContexts = HomeThreadRowContext.index(snapshot: snapshot)
    }
}

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
    }

    private var cachedKey: Key?
    private var cachedPresentation: HomePresentation?

    func presentation(
        snapshot: FeatureSnapshot,
        revision: UInt64,
        workspace: MobileWorkspace,
        query: String,
        projectID: String?,
        now: Date
    ) -> HomePresentation {
        let key = Key(
            revision: revision,
            workspace: workspace,
            query: query,
            projectID: projectID,
            now: now
        )
        if cachedKey == key, let cachedPresentation {
            return cachedPresentation
        }

        let presentation = HomePresentation(
            snapshot: snapshot,
            workspace: workspace,
            query: query,
            projectID: projectID,
            now: now
        )
        cachedKey = key
        cachedPresentation = presentation
        return presentation
    }
}

struct HomeShelfHeader: View {
    let title: String
    let count: Int
    let isExpanded: Bool
    let accent: Color?

    var body: some View {
        HStack(spacing: 8) {
            Text(count > 0 ? "\(title) (\(count))" : title)
                .lineLimit(1)
            Rectangle()
                .fill((accent ?? T3Colors.textTertiary).opacity(accent == nil ? 0.16 : 0.24))
                .frame(height: 1)
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 8, weight: .bold))
        }
        .font(T3Typography.homeMetadata.weight(.bold))
        .foregroundStyle(accent ?? T3Colors.textTertiary)
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .frame(minHeight: 40)
        .contentShape(Rectangle())
    }
}

struct HomeThreadRowContext: Equatable {
    let projectName: String
    /// Where the project's favicon resolves from; nil keeps the letter badge.
    let projectEnvironmentID: String?
    let projectWorkspaceRoot: String?
    let environmentLabel: String?
    let providerID: String
    let providerDriver: String
    let providerName: String
    let connectionState: FeatureConnection.State?
    /// The change request for this thread's branch, when it has one. Overlaid
    /// after the fact by whoever builds the rows: it arrives on its own
    /// subscription, long after the snapshot this context is indexed from.
    var pullRequest: FeaturePullRequest?

    static let fallback = HomeThreadRowContext(
        projectName: "Project",
        projectEnvironmentID: nil,
        projectWorkspaceRoot: nil,
        environmentLabel: nil,
        providerID: "agent",
        providerDriver: "",
        providerName: "Agent",
        connectionState: nil
    )

    var providerLooksTerminal: Bool {
        let normalized = [providerDriver, providerID, providerName]
            .joined(separator: " ")
            .lowercased()
        return normalized.contains("codex")
            || normalized.contains("cursor")
            || normalized.contains("open")
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
                environmentLabel: environmentLabel?.isEmpty == false ? environmentLabel : nil,
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
        /// T3 Work rows: an inbox item, not a checkout — a status lozenge
        /// where a Code card names its repo, and what the work is doing where
        /// a Code card names its branch.
        case inbox
    }

    let thread: FeatureThread
    private let context: HomeThreadRowContext
    let isSelected: Bool
    let style: Style
    let now: Date
    let allowsMultilineTitle: Bool

    init(
        thread: FeatureThread,
        context: HomeThreadRowContext,
        isSelected: Bool = false,
        style: Style = .rich,
        now: Date = .now,
        allowsMultilineTitle: Bool = false
    ) {
        self.thread = thread
        self.context = context
        self.isSelected = isSelected
        self.style = style
        self.now = now
        self.allowsMultilineTitle = allowsMultilineTitle
    }

    var body: some View {
        row(at: now)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(thread.title)
            .accessibilityValue(accessibilityValue(at: now))
            .accessibilityHint("Opens task")
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
                    workspaceRoot: context.projectWorkspaceRoot
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

            HStack(spacing: 6) {
                // A t3-generated branch ("t3code/ffeef775") names nothing the
                // row does not already say. Once the work has a change request,
                // that is what this line reports instead.
                if let pullRequest = context.pullRequest {
                    Image(systemName: "arrow.triangle.pull")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Self.pullRequestColor(pullRequest.state))
                    Text("#\(pullRequest.number)")
                        .monospacedDigit()
                        .foregroundStyle(Self.pullRequestColor(pullRequest.state))
                    Text(pullRequest.title)
                        .lineLimit(1)
                } else {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 10, weight: .medium))
                    Text(branchLabel)
                        .lineLimit(1)
                }
                if context.providerLooksTerminal {
                    Text(">_")
                        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(T3Colors.syntaxProperty)
                }
                Spacer(minLength: 8)
                if let environmentLabel {
                    HStack(spacing: 4) {
                        Image(systemName: environmentIcon)
                            .font(.system(size: 9))
                        Text(environmentLabel)
                            .lineLimit(1)
                    }
                    .foregroundStyle(environmentColor)
                }
                if thread.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(T3Colors.textSecondary)
                }
                providerIcon(size: 16)
            }
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

    private func slimRow(at now: Date) -> some View {
        HStack(spacing: 9) {
            ProjectFaviconBadge(
                environmentID: context.projectEnvironmentID,
                workspaceRoot: context.projectWorkspaceRoot
            ) {
                ProjectBadge(name: context.projectName)
            }
            .saturation(0)
            .opacity(0.48)
            Text(thread.title)
                .font(T3Typography.homeTitle)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(allowsMultilineTitle ? 2 : 1)
            Spacer(minLength: 8)
            if thread.pinnedAt != nil {
                Image(systemName: "pin.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(T3Colors.textSecondary)
            }
            providerIcon(size: 15)
            Text(SidebarRelativeAge.compact(since: thread.updatedAt, now: now))
                .font(T3Typography.homeMetadata.monospacedDigit())
                .foregroundStyle(T3Colors.textTertiary)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 44)
        .padding(.horizontal, 8)
        .background(
            isSelected ? T3Colors.subtleStrong : Color.clear,
            in: RoundedRectangle(cornerRadius: 7)
        )
    }

    /// The Chat row: title and time on one line, the last thing said underneath.
    ///
    /// There is no meta line above the title, because every row in Chat would
    /// have filled it with the same word. What differs between conversations is
    /// what was last said, which is what every message list leads with.
    private func conversationRow(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(thread.title)
                    .font(T3Typography.homeTitle)
                    .tracking(-0.14)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(allowsMultilineTitle ? 2 : 1)
                Spacer(minLength: 8)
                if thread.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Text(SidebarRelativeAge.compact(since: thread.updatedAt, now: now))
                    .font(T3Typography.homeMetadata.monospacedDigit())
                    .foregroundStyle(T3Colors.textTertiary)
            }

            if thread.homeStatus == .working {
                Text("responding…")
                    .font(T3Typography.homeMetadata)
                    .foregroundStyle(T3Colors.statusRunning)
            } else if let preview = previewLine {
                preview
                    .font(T3Typography.homeMetadata)
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
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

    /// The T3 Work row: a status lozenge where a Code card names its repo, and
    /// the last thing that happened where a Code card names its branch.
    ///
    /// Work threads all sit on one hidden backing checkout, so repo, branch and
    /// harness are identical on every row — three constants where the inbox
    /// needs to show which item is blocked on the user.
    private func inboxRow(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if let badge = thread.workInboxBadge {
                    WorkInboxLozenge(badge: badge, tint: statusColor)
                }
                if let duration = thread.homeWorkingDuration(at: now) {
                    Text(duration)
                        .font(.system(.footnote, design: .monospaced, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(statusColor)
                }
                Spacer(minLength: 8)
                if thread.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Text(SidebarRelativeAge.compact(since: thread.updatedAt, now: now))
                    .font(T3Typography.homeMetadata.monospacedDigit())
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .frame(minHeight: 20)

            Text(thread.title)
                .font(T3Typography.homeTitle)
                .tracking(-0.14)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(allowsMultilineTitle ? 2 : 1)
                .padding(.top, 3)

            if let preview = previewLine {
                preview
                    .font(T3Typography.homeMetadata)
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
                    .padding(.top, 2)
            }
        }
        .padding(.leading, thread.workInboxBadge?.wantsAttentionRail == true ? 13 : 10)
        .padding(.trailing, 10)
        .padding(.vertical, 9)
        .frame(minHeight: 72)
        .background(
            isSelected ? T3Colors.subtleStrong : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
        .overlay(alignment: .leading) {
            if thread.workInboxBadge?.wantsAttentionRail == true {
                Capsule()
                    .fill(statusColor)
                    .frame(width: 3)
                    .padding(.vertical, 8)
            }
        }
        .padding(.horizontal, 8)
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

    @ViewBuilder
    private func status(at now: Date) -> some View {
        let label = thread.homeStatusLabel
            ?? SidebarRelativeAge.compact(since: thread.updatedAt, now: now)
        HStack(spacing: 5) {
            if let icon = statusIcon {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
            }
            Text(label)
            if let duration = thread.homeWorkingDuration(at: now) {
                Text(duration)
                    .font(.system(.footnote, design: .monospaced, weight: .semibold))
                    .monospacedDigit()
            }
        }
        .font(T3Typography.status)
        .foregroundStyle(statusColor)
    }

    private var statusIcon: String? {
        switch thread.homeStatus {
        case .working: "circle.dotted"
        case .done: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .approval, .input, .ready: nil
        }
    }

    private var statusColor: Color {
        switch thread.homeStatus {
        case .working: T3Colors.statusRunning
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
            "server.rack"
        }
    }

    private var environmentColor: Color {
        switch context.connectionState {
        case .connecting, .reconnecting:
            T3Colors.warning.opacity(0.78)
        case .disconnected:
            T3Colors.danger.opacity(0.78)
        case .connected, nil:
            T3Colors.textTertiary
        }
    }

    private var isConnectionStale: Bool {
        context.connectionState == .connecting
            || context.connectionState == .reconnecting
            || context.connectionState == .disconnected
    }

    private var branchLabel: String {
        if let branch = thread.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
           !branch.isEmpty {
            return branch
        }
        if let worktreePath = thread.worktreePath,
           !worktreePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: worktreePath).lastPathComponent
        }
        return "workspace"
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

    private var environmentLabel: String? {
        context.environmentLabel
    }

    private func providerIcon(size: CGFloat) -> some View {
        ProviderIcon(
            driver: context.providerDriver,
            providerID: context.providerID,
            fallbackName: context.providerName,
            size: size
        )
    }

    private func accessibilityValue(at now: Date) -> String {
        // Work and Chat rows say the same thing about project, branch and
        // harness on every row, so VoiceOver reads what the row actually
        // carries instead of three constants before the useful part.
        switch style {
        case .conversation:
            var values: [String] = []
            if thread.homeStatus == .working {
                values.append("Responding")
            }
            if let preview = thread.preview, !preview.isEmpty {
                values.append(thread.previewIsFromUser ? "You said: \(preview)" : preview)
            }
            values.append(SidebarRelativeAge.compact(since: thread.updatedAt, now: now))
            return values.joined(separator: ". ")
        case .inbox:
            var values = [thread.workInboxBadge?.label ?? "Ready"]
            if let duration = thread.homeWorkingDuration(at: now) {
                values.append("for \(duration)")
            }
            if let preview = thread.preview, !preview.isEmpty {
                values.append(thread.previewIsFromUser ? "You said: \(preview)" : preview)
            }
            if isConnectionStale {
                values.append("last known state")
            }
            return values.joined(separator: ". ")
        case .rich, .slim:
            var values = [thread.homeStatusLabel ?? "Ready", "Project \(context.projectName)"]
            values.append("Harness \(context.providerName)")
            if let duration = thread.homeWorkingDuration(at: now) {
                values.append("for \(duration)")
            }
            if let pullRequest = context.pullRequest {
                values.append(
                    "Pull request #\(pullRequest.number) \(pullRequest.state). \(pullRequest.title)"
                )
            } else {
                values.append("Branch \(branchLabel)")
            }
            if let environmentLabel {
                values.append("on \(environmentLabel)")
            }
            if isConnectionStale {
                values.append("last known state")
            }
            return values.joined(separator: ". ")
        }
    }

}

/// The T3 Work inbox row's status lozenge.
private struct WorkInboxLozenge: View {
    let badge: WorkInboxBadge
    let tint: Color

    var body: some View {
        Text(badge.label.uppercased())
            .font(.system(size: 10, weight: .bold))
            .tracking(0.4)
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
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
