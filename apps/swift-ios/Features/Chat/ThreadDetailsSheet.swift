import SwiftUI
import UIKit

// The thread details sheet — the mobile presentation of the desktop
// thread-details panel, opened from the thread header.
//
// Ports apps/mobile/src/features/threads/details/ThreadDetailsSheet.tsx and the
// four section files beside it: Workspace, Actions, Ports, Background Tasks,
// Version Control, Automations, Lineage — each hiding itself when it has
// nothing to report, so the sheet is only ever as tall as the thread has facts.
// It opens at the medium detent for that reason.
//
// One deliberate departure from the Expo client: it appends the project's
// `t3.json` scripts to the Workspace card, and here they get their own Actions
// section. See `actionsSection` for why.
//
// The sheet owns its navigation stack: Files, Review, Source Control,
// Terminal, Linked Pull Requests and a pull request push inside it, so back
// returns to Details and the close button closes them all.
//
// Every rule lives in ThreadDetailsSections.swift; this file is the view.

/// A screen the Details sheet pushes inside its own stack.
enum ThreadDetailsDestination: Hashable {
    case tool(ThreadDetailsWorkspaceTool)
    case linkedPullRequests
    case pullRequest(number: Int)
}

/// The workspace tools the thread view owns. Details pushes them; a deep link
/// from the transcript presents the same tool as its own sheet.
enum ThreadDetailsWorkspaceTool: Hashable {
    case files(path: String?, line: Int?)
    case review(filePath: String?)
    case sourceControl
    /// Opens the exact session that accepted a project action.
    case terminal(terminalID: String?)
}

/// Where a row sends the reader when it leaves the thread. The caller closes
/// Details first, because the destination is not inside it.
enum ThreadDetailsExit: Equatable {
    case connections
    case thread(id: String, isArchived: Bool)
}

struct ThreadDetailsSheet<ToolView: View>: View {
    let thread: FeatureThread
    let environment: FeatureEnvironment?
    let project: FeatureProject?
    let client: any FeatureClient
    let onExit: (ThreadDetailsExit) -> Void
    let onReconnect: () -> Void

    /// Dev servers this thread is running. Empty until the client can report
    /// endpoints, at which point the section appears with no other change.
    var endpoints: [ThreadEndpoint] = []
    var scripts: [ProjectScript] = []
    var activeScriptIDs: [String] = []
    /// Runs a project action. A terminal it returns is pushed, so the output
    /// of what was just started is on screen.
    var onRunScript: ((ProjectScript) async throws -> String?)?
    /// The same projection the timeline renders, so this sheet and the rows in
    /// the thread cannot disagree about what is running.
    var turnItems: [OrchestrationV2TurnItem] = []
    var relationships: ThreadRelationshipsModel?
    var onMergeBack: (() async throws -> Void)?
    var onDetachSession: (() async throws -> Void)?
    /// Thread-level actions, folded in here from the old toolbar ••• menu so
    /// the details button is the thread's single secondary surface.
    var onTogglePin: (() -> Void)?
    var confirmThreadUnpin = false
    var onReload: (() async -> Void)?
    var onToggleArchive: (() -> Void)?
    var onRename: ((String) -> Void)?
    var onDelete: (() -> Void)?
    /// Chat conversations subtract the workbench: no workspace tools, ports,
    /// version control or automations — the environment row, background tasks,
    /// lineage and thread actions remain.
    var isChatConversation = false
    var isHermesConversation = false
    var activeProviderSessionID: String?
    /// Draws a workspace tool pushed from here.
    @ViewBuilder let toolView: (ThreadDetailsWorkspaceTool) -> ToolView

    @State private var path: [ThreadDetailsDestination] = []
    @State private var detent: PresentationDetent = .medium
    @State private var workDetailsReloadID = 0
    @State private var hermes: HermesThreadDetailsModel?

    @State private var sourceControl: FeatureSourceControlStatus?
    @State private var sourceControlError: String?
    @State private var isLoadingStatus = true
    /// The label of the git action in flight, so its row keeps saying what is
    /// running instead of turning into something else.
    @State private var runningQuickActionLabel: String?
    @State private var pendingDefaultBranchAction: PendingGitAction?

    @State private var liveScriptIDs: Set<String> = []
    @State private var runningScriptID: String?
    @State private var automations: [FeatureScheduledTask] = []
    @State private var automationsFailedToLoad = false

    @State private var lineageDecay = ThreadRelationshipDecay()
    @State private var lineageVisible: [ThreadRelationshipRow] = []
    @State private var lineageArchived: [ThreadRelationshipRow] = []
    @State private var showsArchivedLineage = false
    @State private var lineageBusy: LineageAction?
    @State private var confirmingLineageAction: LineageAction?

    @State private var isReloading = false
    @State private var showingUnpinConfirmation = false
    @State private var isRenaming = false
    @State private var renameTitle = ""
    @State private var isConfirmingDelete = false

    @State private var failure: ThreadDetailsFailure?
    @State private var portAlert: ThreadDetailsPortsSection.OpenRefusal?
    @SwiftUI.Environment(\.openURL) private var openURL

    private enum LineageAction: Equatable { case merge, detach }

    private struct PendingGitAction: Equatable {
        let action: GitStackedAction
        let label: String
    }

    var body: some View {
        NavigationStack(path: $path) {
            list
                .navigationTitle("Details")
                .navigationBarTitleDisplayMode(.inline)
                .t3NavigationChrome()
                .t3SheetToolbar(.close)
                .navigationDestination(for: ThreadDetailsDestination.self) { destination in
                    destinationView(destination)
                }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .t3GlassSheetBackground()
        // A pushed tool needs the room; Details alone is only as tall as its facts.
        .onChange(of: path) { _, newPath in
            if !newPath.isEmpty { detent = .large }
        }
    }

    // MARK: - List

    private var list: some View {
        List {
            headerSection
            connectionBanner
            workspaceSection
            if let hermes { HermesThreadDetailsSections(model: hermes) }
            if !isHermesConversation { actionsSection }
            if !isChatConversation { portsSection }
            backgroundTasksSection
            if !isChatConversation && !isHermesConversation {
                versionControlSection
                automationsSection
            }
            lineageSection
            threadActionsSection
            deleteSection
        }
        .t3SheetList()
        .environment(\.defaultMinListRowHeight, T3Metrics.minimumTapTarget)
        .refreshable {
            if let hermes {
                hermes.retry()
            } else {
                await loadSourceControl()
                await loadAutomations()
            }
        }
        .task { await loadSourceControl() }
        .task { await loadAutomations() }
        .task(id: thread.id) {
            guard !scripts.isEmpty, !isHermesConversation else { return }
            for await sessions in client.terminalSessions(threadID: thread.id) {
                liveScriptIDs = Set(sessions.filter { $0.hasRunningSubprocess }.compactMap(\.activeScriptID))
            }
        }
        .task(id: relationships?.rows ?? []) { await trackLineageDecay() }
        .onAppear(perform: makeHermesModelIfNeeded)
        .task(id: "\(hermes == nil):\(workDetailsReloadID):\(hermes?.changeRevision ?? 0)") {
            guard let hermes else { return }
            await hermes.load(afterChange: hermes.changeRevision > 0)
        }
        .task(id: "\(hermes?.details?.providerInstanceId ?? ""):\(workDetailsReloadID):\(hermes?.updatesRetry ?? 0)") {
            await hermes?.observeChanges()
        }
        .onChange(of: thread.updatedAt) { _, _ in
            if isHermesConversation, thread.state != .working, thread.state != .queued { workDetailsReloadID += 1 }
        }
        .onChange(of: activeProviderSessionID) { _, _ in
            if isHermesConversation { workDetailsReloadID += 1 }
        }
        .onChange(of: thread.state) { _, _ in
            if isHermesConversation { workDetailsReloadID += 1 }
        }
        .alert(
            failure?.title ?? "",
            isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }),
            presenting: failure
        ) { _ in
            Button("OK") {}
        } message: { failure in
            Text(failure.message)
        }
        .alert(
            portAlert?.title ?? "",
            isPresented: Binding(get: { portAlert != nil }, set: { if !$0 { portAlert = nil } })
        ) {
            Button("OK") {}
        } message: {
            Text(portAlert?.message ?? "")
        }
        .alert("Rename Thread", isPresented: $isRenaming) {
            TextField("Thread title", text: $renameTitle)
            Button("Cancel", role: .cancel) {}
            renameConfirmButton
        }
        .accessibilityIdentifier("thread-details-sheet")
    }

    @ViewBuilder
    private func destinationView(_ destination: ThreadDetailsDestination) -> some View {
        switch destination {
        case let .tool(tool):
            toolView(tool)
        case .linkedPullRequests:
            ThreadLinkedPullRequestSheet(
                thread: thread,
                branchPullRequest: thread.branchPullRequest.map {
                    ThreadDetailsPullRequest(number: $0.number, state: $0.snapshot?.state ?? "", url: $0.url)
                } ?? gitStatus?.pullRequest,
                client: client
            )
        case let .pullRequest(number):
            PullRequestDetailSheet(client: client, threadID: thread.id, number: number)
        }
    }

    // MARK: - Derived state

    private var gitStatus: ThreadDetailsGitStatus? {
        sourceControl.map(ThreadDetailsGitStatus.init(sourceControl:))
    }

    /// Code uses its T3 checkout; Hermes reports its native workspace separately.
    private var workspacePath: String? {
        thread.worktreePath ?? project?.path
    }

    private var connectionState: FeatureConnection.State? {
        environment?.connectionState
    }

    private var backgroundProcesses: [ThreadDetailsBackgroundProcess] {
        ThreadDetailsBackgroundTasks.liveProcesses(turnItems)
    }

    private var boundAutomations: [FeatureScheduledTask] {
        ThreadDetailsAutomationsSection.boundTasks(automations, threadID: thread.id)
    }

    private var isRunningQuickAction: Bool {
        runningQuickActionLabel != nil || (sourceControl?.isBusy ?? false)
    }

    private var quickActionRow: ThreadDetailsGitQuickActionRow {
        ThreadDetailsGit.quickActionRow(
            for: gitStatus,
            loadFailed: sourceControlError != nil,
            isRunning: isRunningQuickAction,
            runningLabel: runningQuickActionLabel
        )
    }

    // MARK: - Header

    private var headerSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(thread.title)
                    .font(T3Typography.threadHeading2)
                    .foregroundStyle(T3Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(ThreadDetailsHeader.meta(
                    providerName: thread.providerName,
                    state: thread.state,
                    updatedAt: thread.updatedAt
                ))
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
        }
    }

    // MARK: - Connection

    /// Red only when the environment is actually gone. Connecting shows as
    /// progress on the environment row instead.
    @ViewBuilder
    private var connectionBanner: some View {
        if ThreadDetailsConnection.hasIssue(connectionState) {
            Section {
                ThreadSheetBanner(
                    tone: .error,
                    title: ThreadDetailsConnection.noticeTitle(
                        environmentName: environment?.name ?? thread.environmentName
                    ),
                    message: environment?.connectionDetail ?? ThreadDetailsConnection.fallbackNoticeBody
                ) {
                    Button("Reconnect", action: onReconnect)
                    Button("Connections") { onExit(.connections) }
                }
                .listRowBackground(ThreadSheetBannerTone.error.fill)
            }
        }
    }

    // MARK: - Workspace

    private var workspaceSection: some View {
        Section("Workspace") {
            Button {
                onExit(.connections)
            } label: {
                HStack {
                    ThreadSheetRowLabel(
                        title: environment?.name ?? thread.environmentName ?? "This Environment",
                        systemImage: environment?.machineSymbol ?? "server.rack",
                        tint: .gray
                    ) {
                        HStack(spacing: 6) {
                            if ThreadDetailsConnection.isReconnecting(connectionState) {
                                ProgressView().controlSize(.small)
                            }
                            Text(ThreadDetailsConnection.label(connectionState))
                        }
                    }
                    ThreadSheetDisclosure()
                }
            }
            .accessibilityHint("Opens connection management")

            if let workspacePath, !isChatConversation, !isHermesConversation {
                NavigationLink(value: ThreadDetailsDestination.tool(.sourceControl)) {
                    ThreadSheetRowLabel(
                        title: ThreadDetailsWorkspace.label(
                            worktreePath: thread.worktreePath,
                            projectTitle: project?.name,
                            workspaceRoot: project?.path
                        ),
                        subtitle: workspacePath,
                        monospacedSubtitle: true,
                        systemImage: ThreadDetailsWorkspace.icon(worktreePath: thread.worktreePath),
                        tint: .indigo,
                        value: ThreadDetailsWorkspace.kindLabel(worktreePath: thread.worktreePath)
                    )
                }
                NavigationLink(value: ThreadDetailsDestination.tool(.files(path: nil, line: nil))) {
                    ThreadSheetRowLabel(title: "Files", systemImage: "folder", tint: .blue)
                }
                NavigationLink(value: ThreadDetailsDestination.tool(.terminal(terminalID: nil))) {
                    ThreadSheetRowLabel(title: "Terminal", systemImage: "terminal", tint: .ink)
                }
            }
        }
        .t3GroupedRow()
    }

    // MARK: - Actions

    /// The project's `t3.json` scripts, which the app calls actions.
    ///
    /// Their own section rather than the tail of Workspace: every other row
    /// there reports where the thread lives and pushes a screen when tapped,
    /// while these run a command in place. Sharing one card made a destructive
    /// script look like one more way to browse, and put a row whose subtitle is
    /// a shell command next to rows whose subtitle is a description.
    ///
    /// One tap runs, with no confirmation, matching the desktop.
    @ViewBuilder
    private var actionsSection: some View {
        if !isChatConversation, !scripts.isEmpty {
            Section("Actions") {
                ForEach(scripts) { script in
                    scriptRow(script)
                }
            }
            .t3GroupedRow()
        }
    }

    private func scriptRow(_ script: ProjectScript) -> some View {
        let isActive = script.singleRun == true
            && (activeScriptIDs.contains(script.id) || liveScriptIDs.contains(script.id))
        return Button {
            run(script)
        } label: {
            ThreadSheetRowLabel(
                title: ThreadDetailsWorkspace.scriptRowTitle(script, isActive: isActive),
                subtitle: script.command,
                monospacedSubtitle: true,
                systemImage: ThreadDetailsWorkspace.scriptRowIcon(script, isActive: isActive),
                tint: isActive ? .red : .gray
            ) {
                if runningScriptID == script.id {
                    ProgressView()
                } else {
                    Image(systemName: isActive ? "stop.fill" : "play.fill")
                        .foregroundStyle(isActive ? T3Colors.danger : T3Colors.accent)
                        .imageScale(.small)
                }
            }
        }
        .disabled(onRunScript == nil || runningScriptID != nil)
    }

    private func run(_ script: ProjectScript) {
        guard let onRunScript, runningScriptID == nil else { return }
        runningScriptID = script.id
        Task {
            defer { runningScriptID = nil }
            do {
                if let terminalID = try await onRunScript(script) {
                    path.append(.tool(.terminal(terminalID: terminalID)))
                }
            } catch {
                failure = ThreadDetailsFailure(
                    title: "Couldn't Run \(ThreadDetailsWorkspace.scriptLabel(script))",
                    message: error.localizedDescription
                )
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }

    // MARK: - Ports

    @ViewBuilder
    private var portsSection: some View {
        if !endpoints.isEmpty {
            Section {
                ForEach(ThreadDetailsPortsSection.visible(endpoints)) { endpoint in
                    portRow(endpoint)
                }
            } header: {
                Text("Ports")
            } footer: {
                if let overflow = ThreadDetailsPortsSection.overflowFooter(endpoints) { Text(overflow) }
            }
            .t3GroupedRow()
        }
    }

    private func portRow(_ endpoint: ThreadEndpoint) -> some View {
        // The subtitle is the *resolved* address or the reason there isn't one —
        // never the announced `localhost:PORT`, which on a phone names the
        // handset rather than the machine running the server.
        Button {
            open(endpoint)
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ThreadPortsMenu.label(for: endpoint, scripts: scripts))
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                    Text(ThreadPortsMenu.subtitle(for: endpoint))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(2)
                }
            } icon: {
                Image(systemName: ThreadPortsMenu.icon(for: endpoint))
                    .foregroundStyle(endpoint.status == .live ? T3Colors.success : T3Colors.textSecondary)
            }
        }
        .contextMenu {
            Button("Copy URL", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = ThreadDetailsPortsSection.copyURL(for: endpoint)
                T3HUD.show("Copied", systemImage: "doc.on.doc")
            }
        }
        .accessibilityAction(named: ThreadDetailsPortsSection.copyAccessibilityLabel(for: endpoint, scripts: scripts)) {
            UIPasteboard.general.string = ThreadDetailsPortsSection.copyURL(for: endpoint)
            T3HUD.show("Copied", systemImage: "doc.on.doc")
        }
    }

    private func open(_ endpoint: ThreadEndpoint) {
        if let refusal = ThreadDetailsPortsSection.openRefusal(for: endpoint) {
            portAlert = refusal
            return
        }
        guard let address = ThreadDetailsPortsSection.openURL(for: endpoint),
              let url = URL(string: address) else { return }
        openURL(url)
    }

    // MARK: - Background tasks

    @ViewBuilder
    private var backgroundTasksSection: some View {
        let processes = backgroundProcesses
        if !processes.isEmpty {
            Section {
                ForEach(ThreadDetailsBackgroundTasks.visible(processes)) { process in
                    ThreadDetailsBackgroundTaskRow(process: process, style: .list)
                }
            } header: {
                Text("Background Tasks")
            } footer: {
                if let overflow = ThreadDetailsBackgroundTasks.overflowFooter(processes) { Text(overflow) }
            }
            .t3GroupedRow()
        }
    }

    // MARK: - Version control

    @ViewBuilder
    private var versionControlSection: some View {
        if workspacePath != nil {
            let quickAction = quickActionRow
            Section {
                branchRow
                NavigationLink(value: ThreadDetailsDestination.tool(.review(filePath: nil))) {
                    ThreadSheetRowLabel(title: "Review Changes", systemImage: "text.bubble", tint: .teal) {
                        if let gitStatus, gitStatus.insertions > 0 || gitStatus.deletions > 0 {
                            HStack(spacing: 4) {
                                Text("+\(gitStatus.insertions)").foregroundStyle(T3Colors.diffAddition)
                                Text("−\(gitStatus.deletions)").foregroundStyle(T3Colors.diffDeletion)
                            }
                            .monospacedDigit()
                        }
                    }
                }
                .disabled(gitStatus?.isRepo == false)

                if let pullRequest = displayedPullRequest {
                    pullRequestRow(pullRequest)
                }

                if thread.supportsPullRequestLinking == true {
                    NavigationLink(value: ThreadDetailsDestination.linkedPullRequests) {
                        ThreadSheetRowLabel(
                            title: thread.supportsMultiplePullRequests == true ? "Linked Pull Requests" : "Linked Pull Request",
                            systemImage: "link",
                            tint: .gray,
                            value: ThreadLinkedPullRequestPresentation.linkedValue(thread.allLinkedPullRequests)
                        )
                    }
                }

                quickActionRowView(quickAction)

                NavigationLink(value: ThreadDetailsDestination.tool(.sourceControl)) {
                    ThreadSheetRowLabel(title: "More Git Actions", systemImage: "ellipsis", tint: .gray)
                }
            } header: {
                Text("Version Control")
            } footer: {
                versionControlFooter(quickAction)
            }
            .t3GroupedRow()
        }
    }

    /// The branch, and how the status read went. A failed read says so and
    /// offers Retry in place, rather than claiming to load forever.
    @ViewBuilder
    private var branchRow: some View {
        let title = ThreadDetailsGit.branchLabel(gitStatus, threadBranch: thread.branch)
        if let gitStatus {
            NavigationLink(value: ThreadDetailsDestination.tool(.sourceControl)) {
                ThreadSheetRowLabel(
                    title: title,
                    subtitle: ThreadDetailsGit.statusSummary(gitStatus),
                    systemImage: "arrow.triangle.branch",
                    tint: .indigo
                )
            }
        } else if sourceControlError != nil {
            ThreadSheetRowLabel(title: title, subtitle: "Couldn't load status", systemImage: "arrow.triangle.branch", tint: .indigo) {
                Button("Retry") { Task { await loadSourceControl() } }
                    .buttonStyle(.bordered)
                    .tint(T3Colors.textPrimary)
                    .disabled(isLoadingStatus)
            }
        } else {
            ThreadSheetRowLabel(title: title, systemImage: "arrow.triangle.branch", tint: .indigo) {
                ProgressView()
                    .accessibilityLabel("Loading branch status")
            }
        }
    }

    @ViewBuilder
    private func quickActionRowView(_ row: ThreadDetailsGitQuickActionRow) -> some View {
        switch row {
        case .placeholder:
            // Static, not shimmering: the shape of the row that is coming.
            ThreadSheetRowLabel(title: "Commit & Push", systemImage: "arrow.up", tint: .gray)
                .redacted(reason: .placeholder)
                .accessibilityHidden(true)
        case .hidden:
            EmptyView()
        case let .action(label, isRunning):
            Button {
                runQuickAction()
            } label: {
                ThreadSheetRowLabel(
                    title: label,
                    systemImage: gitStatus.map {
                        ThreadDetailsGit.quickActionIcon(ThreadDetailsGit.quickAction(for: $0, isBusy: false))
                    } ?? "arrow.up",
                    tint: .ink,
                    titleColor: T3Colors.accent
                ) {
                    if isRunning { ProgressView() }
                }
            }
            .disabled(isRunning)
            .accessibilityValue(isRunning ? "In progress" : "")
            .confirmationDialog(
                "Push to \(gitStatus?.refName ?? "the default branch")?",
                isPresented: Binding(
                    get: { pendingDefaultBranchAction != nil },
                    set: { if !$0 { pendingDefaultBranchAction = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingDefaultBranchAction
            ) { pending in
                Button("Push to \(gitStatus?.refName ?? "Default Branch")", role: .destructive) {
                    Task { await perform(featureAction(pending.action), label: pending.label) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text(
                    "This publishes straight to \(gitStatus?.refName ?? "the default branch"), "
                        + "which has no undo on the other side."
                )
            }
        }
    }

    @ViewBuilder
    private func versionControlFooter(_ quickAction: ThreadDetailsGitQuickActionRow) -> some View {
        if let sourceControlError {
            Text("\(sourceControlError) Pull down or tap Retry.")
        } else if case let .hidden(footer?) = quickAction {
            Text(footer)
        }
    }

    // MARK: - Pull request row

    /// A linked request outranks the branch's: it is the thread's own answer,
    /// and it is what the sidebar badge and the merge settle rule already
    /// follow.
    private var displayedPullRequest: ThreadDetailsPullRequest? {
        guard let linked = thread.linkedPullRequest ?? thread.branchPullRequest else { return gitStatus?.pullRequest }
        return ThreadDetailsPullRequest(
            number: linked.number,
            state: branchPullRequestState(matching: linked) ?? "",
            url: linked.url
        )
    }

    private var displayedLink: FeatureLinkedPullRequest? {
        thread.linkedPullRequest ?? thread.branchPullRequest
    }

    /// State when the branch happens to resolve to the linked request. The git
    /// status only speaks for the branch, so a linked request from elsewhere
    /// has no state to report here.
    private func branchPullRequestState(
        matching linked: FeatureLinkedPullRequest
    ) -> String? {
        if let snapshot = linked.snapshot { return snapshot.state }
        guard let branch = gitStatus?.pullRequest, branch.number == linked.number, branch.url == linked.url else {
            return nil
        }
        return branch.state
    }

    @ViewBuilder
    private func pullRequestRow(_ pullRequest: ThreadDetailsPullRequest) -> some View {
        let snapshot = displayedLink?.snapshot
        let state = PullRequestState(rawValue: snapshot?.state ?? pullRequest.state)
        let isDraft = snapshot?.isDraft ?? false
        let label = pullRequestLabel(pullRequest, snapshot: snapshot, state: state, isDraft: isDraft)
        // The native detail where the server can answer for it; the host's
        // own page everywhere else.
        if environment?.supportsPullRequests == true {
            NavigationLink(value: ThreadDetailsDestination.pullRequest(number: pullRequest.number)) { label }
        } else {
            Button {
                openInBrowser(pullRequest)
            } label: {
                HStack {
                    label
                    Image(systemName: "arrow.up.right")
                        .foregroundStyle(T3Colors.textTertiary)
                        .imageScale(.small)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityHint("Opens in the browser")
        }
    }

    private func pullRequestLabel(
        _ pullRequest: ThreadDetailsPullRequest,
        snapshot: FeaturePullRequestSnapshot?,
        state: PullRequestState?,
        isDraft: Bool
    ) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(snapshot?.title ?? "Pull Request #\(pullRequest.number)")
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if let state {
                        PullRequestStateBadge(state: state, isDraft: isDraft)
                    }
                    Text(pullRequestMeta(pullRequest, snapshot: snapshot, hasState: state != nil))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(1)
                }
            }
        } icon: {
            T3SettingsTile(T3Symbol.pullRequest, tint: pullRequestTileTint(state: state, isDraft: isDraft))
        }
    }

    /// "#412 · Checks passed", or the repository when the request was linked
    /// from elsewhere and nothing else is known about it.
    private func pullRequestMeta(
        _ pullRequest: ThreadDetailsPullRequest,
        snapshot: FeaturePullRequestSnapshot?,
        hasState: Bool
    ) -> String {
        var parts = ["#\(pullRequest.number)"]
        if let checks = ThreadLinkedPullRequestPresentation.checksLabel(snapshot?.checksState) {
            parts.append(checks)
        } else if !hasState, let repository = displayedLink?.repository {
            parts.append(repository)
        }
        if thread.linkedPullRequest != nil { parts.append("Linked") }
        return parts.joined(separator: " · ")
    }

    private func pullRequestTileTint(state: PullRequestState?, isDraft: Bool) -> T3SettingsTile.Tint {
        guard let state else { return .gray }
        switch PullRequestDetailSections.stateTone(state: state, isDraft: isDraft) {
        case .success: return .green
        case .danger: return .red
        case .merged: return .purple
        default: return .gray
        }
    }

    private func openInBrowser(_ pullRequest: ThreadDetailsPullRequest) {
        guard let address = pullRequest.url, let url = URL(string: address) else {
            failure = ThreadDetailsFailure(title: "Couldn't Open Pull Request", message: "This pull request has no link to open.")
            return
        }
        openURL(url)
    }

    // MARK: - Automations

    @ViewBuilder
    private var automationsSection: some View {
        if ThreadDetailsAutomationsSection.isVisible(
            tasks: automations,
            threadID: thread.id,
            hasError: automationsFailedToLoad
        ) {
            Section("Automations") {
                if automationsFailedToLoad {
                    HStack {
                        Label(ThreadDetailsAutomationsSection.loadErrorMessage, systemImage: "exclamationmark.circle")
                            .foregroundStyle(T3Colors.danger)
                        Spacer(minLength: 8)
                        Button("Retry") { Task { await loadAutomations() } }
                            .buttonStyle(.bordered)
                            .tint(T3Colors.textPrimary)
                    }
                    .font(T3Typography.supporting)
                } else {
                    ForEach(boundAutomations) { task in
                        ThreadSheetRowLabel(
                            title: task.title,
                            subtitle: ThreadDetailsAutomationsSection.subtitle(for: task, now: .now),
                            systemImage: "clock",
                            tint: automationTint(task),
                            value: task.enabled ? nil : "Off"
                        )
                    }
                }
            }
            .t3GroupedRow()
        }
    }

    private func automationTint(_ task: FeatureScheduledTask) -> T3SettingsTile.Tint {
        guard task.enabled else { return .gray }
        switch ThreadDetailsAutomationsSection.statusTone(for: task) {
        case .dormant: return .gray
        case .running: return .blue
        case .success: return .green
        case .danger: return .red
        }
    }

    private func loadAutomations() async {
        guard !isChatConversation, !isHermesConversation,
              let manager = client as? any FeatureScheduledTaskManaging,
              let environmentID = environment?.id ?? thread.environmentID else { return }
        do {
            automations = try await manager.loadScheduledTasks(environmentID: environmentID)
            automationsFailedToLoad = false
        } catch {
            guard !Task.isCancelled else { return }
            automationsFailedToLoad = true
        }
    }

    // MARK: - Lineage

    /// The thread's parents, forks, transfers and subagents, plus the
    /// merge-back and detach actions the desktop panel offers beside them.
    /// Derivation is `ThreadRelationships`', shared with the lineage banner
    /// above the transcript.
    @ViewBuilder
    private var lineageSection: some View {
        if let relationships, !relationships.isEmpty {
            Section {
                ForEach(lineageVisible) { row in
                    relationshipRow(row, in: relationships)
                }
                if !lineageArchived.isEmpty {
                    DisclosureGroup(isExpanded: $showsArchivedLineage) {
                        ForEach(lineageArchived) { row in
                            relationshipRow(row, in: relationships)
                        }
                    } label: {
                        LabeledContent("Done") {
                            Text("\(lineageArchived.count)").monospacedDigit()
                        }
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                    }
                    .accessibilityLabel(
                        ThreadDetailsLineageSection.doneGroupAccessibilityLabel(count: lineageArchived.count)
                    )
                }
                if relationships.canMerge, onMergeBack != nil {
                    lineageActionRow(
                        .merge,
                        title: "Merge Back to Source…",
                        systemImage: "arrow.triangle.merge",
                        relationships: relationships
                    )
                }
                if relationships.canDetach, onDetachSession != nil {
                    lineageActionRow(
                        .detach,
                        title: "Disconnect Agent Session…",
                        systemImage: "bolt.slash",
                        relationships: relationships
                    )
                }
            } header: {
                Text(ThreadDetailsLineageSection.title(rows: relationships.rows))
            }
            .t3GroupedRow()
        }
    }

    private func relationshipRow(_ row: ThreadRelationshipRow, in relationships: ThreadRelationshipsModel) -> some View {
        let availability = relationships.availability(for: row.threadID)
        let isArchived = ThreadDetailsLineageSection.isArchived(availability: availability)
        let status = row.edge.kind == .subagent ? WorkRowStatus(agentStatus: row.edge.status) : nil
        return Button {
            onExit(.thread(id: row.threadID, isArchived: isArchived))
        } label: {
            HStack {
                LabeledContent {
                    if let availability {
                        Text(availability)
                    } else if row.edge.kind == .subagent {
                        Text(status?.accessibilityLabel ?? "Done")
                            .foregroundStyle(status == .failed ? T3Colors.danger : T3Colors.textSecondary)
                    }
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(relationships.title(for: row.threadID))
                                .font(T3Typography.threadBody)
                                .foregroundStyle(T3Colors.textPrimary)
                                .lineLimit(2)
                            Text(ThreadRelationships.label(row.edge, currentThreadID: relationships.currentThreadID))
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                    } icon: {
                        if row.edge.kind == .subagent {
                            AgentOrb(
                                seed: relationships.subagent(for: row.threadID)?.orbSeed ?? row.threadID,
                                size: 28,
                                state: orbState(row)
                            )
                        } else {
                            Image(systemName: ThreadRelationships.symbol(row.edge))
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                }
                if availability == nil { ThreadSheetDisclosure() }
            }
        }
        .disabled(ThreadDetailsLineageSection.isDisabled(availability: availability))
    }

    private func lineageActionRow(
        _ action: LineageAction,
        title: String,
        systemImage: String,
        relationships: ThreadRelationshipsModel
    ) -> some View {
        Button {
            confirmingLineageAction = action
        } label: {
            HStack {
                Label(title, systemImage: systemImage)
                    .foregroundStyle(action == .detach ? T3Colors.danger : T3Colors.accent)
                Spacer(minLength: 8)
                if lineageBusy == action { ProgressView() }
            }
        }
        .disabled(lineageBusy != nil)
        .confirmationDialog(
            action == .merge
                ? "Merge back into “\(relationships.mergeTargetThreadID.map { relationships.title(for: $0) } ?? "the source thread")”?"
                : "Disconnect the agent session?",
            isPresented: Binding(
                get: { confirmingLineageAction == action },
                set: { if !$0 { confirmingLineageAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            if action == .merge {
                Button("Merge Back") { Task { await mergeBack(relationships) } }
            } else {
                Button("Disconnect", role: .destructive) { Task { await detachSession() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(action == .merge
                ? "The latest run’s changes are applied to the source thread. This can’t be undone."
                : "The agent stops where it is. The thread and its history stay.")
        }
    }

    private func mergeBack(_ relationships: ThreadRelationshipsModel) async {
        guard let onMergeBack, lineageBusy == nil else { return }
        lineageBusy = .merge
        defer { lineageBusy = nil }
        do {
            try await onMergeBack()
            PlatformHapticEngine.shared.play(.success)
            if let target = relationships.mergeTargetThreadID {
                onExit(.thread(id: target, isArchived: false))
            }
        } catch {
            failure = ThreadDetailsFailure(title: "Couldn't Merge Back", message: error.localizedDescription)
            PlatformHapticEngine.shared.play(.error)
        }
    }

    private func detachSession() async {
        guard let onDetachSession, lineageBusy == nil else { return }
        lineageBusy = .detach
        defer { lineageBusy = nil }
        do {
            try await onDetachSession()
            PlatformHapticEngine.shared.play(.success)
        } catch {
            failure = ThreadDetailsFailure(title: "Couldn't Disconnect", message: error.localizedDescription)
            PlatformHapticEngine.shared.play(.error)
        }
    }

    /// `ThreadRelationships` reports orb state in the lifecycle timeline's
    /// vocabulary; `AgentOrb` takes its own. One mapping, here, so a rename on
    /// either side is a single line rather than a hunt.
    private func orbState(_ row: ThreadRelationshipRow) -> AgentOrbState {
        switch ThreadRelationships.subagentOrbState(row.edge.status) {
        case .active: .active
        case .done: .done
        case .failed: .failed
        }
    }

    /// Re-splits when the rows change, then sleeps exactly until the next row is
    /// due to collapse rather than polling.
    private func trackLineageDecay() async {
        guard let relationships else { return }
        while !Task.isCancelled {
            let split = lineageDecay.split(rows: relationships.rows)
            lineageVisible = split.visible
            lineageArchived = split.archived
            guard let next = split.nextRefresh else { return }
            let delay = next.timeIntervalSinceNow + 0.05
            guard delay > 0 else { continue }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    // MARK: - Thread actions

    /// Rename, pin, reload and archive — the thread's own actions, last
    /// because they act on the thread rather than report on it.
    @ViewBuilder
    private var threadActionsSection: some View {
        if onRename != nil || onTogglePin != nil || onReload != nil || onToggleArchive != nil {
            Section {
                if onRename != nil {
                    Button {
                        renameTitle = thread.title
                        isRenaming = true
                    } label: {
                        ThreadSheetRowLabel(title: "Rename…", systemImage: "pencil", tint: .gray, titleColor: T3Colors.accent)
                    }
                }

                if let onTogglePin, thread.canTogglePin, !thread.isArchived {
                    Button {
                        if thread.pinnedAt != nil, confirmThreadUnpin {
                            showingUnpinConfirmation = true
                        } else {
                            PlatformHapticEngine.shared.playSelection()
                            onTogglePin()
                        }
                    } label: {
                        ThreadSheetRowLabel(
                            title: thread.pinnedAt == nil ? "Pin" : "Unpin",
                            systemImage: thread.pinnedAt == nil ? "pin" : "pin.slash",
                            tint: .orange,
                            titleColor: T3Colors.accent
                        )
                    }
                    .confirmationDialog(
                        "Unpin \(thread.title)?",
                        isPresented: $showingUnpinConfirmation,
                        titleVisibility: .visible
                    ) {
                        Button("Unpin", role: .destructive) {
                            PlatformHapticEngine.shared.playSelection()
                            onTogglePin()
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This thread will return to its normal place in the list.")
                    }
                }

                if let onReload {
                    Button {
                        guard !isReloading else { return }
                        isReloading = true
                        Task {
                            await onReload()
                            isReloading = false
                            PlatformHapticEngine.shared.play(.success)
                        }
                    } label: {
                        ThreadSheetRowLabel(title: "Reload", systemImage: "arrow.clockwise", tint: .blue, titleColor: T3Colors.accent) {
                            if isReloading { ProgressView() }
                        }
                    }
                    .disabled(isReloading)
                }

                if let onToggleArchive {
                    Button(action: onToggleArchive) {
                        ThreadSheetRowLabel(
                            title: thread.isArchived ? "Restore" : "Archive",
                            systemImage: thread.isArchived ? "arrow.uturn.backward" : "archivebox",
                            tint: .indigo,
                            titleColor: canArchive ? T3Colors.accent : T3Colors.textTertiary
                        )
                    }
                    .disabled(!canArchive)
                }
            } header: {
                Text("Thread")
            } footer: {
                if !canArchive {
                    Text("Archive is available once the current turn finishes.")
                }
            }
            .t3GroupedRow()
        }
    }

    /// Archiving must not detach a provider that is still executing a turn;
    /// restoring is always safe.
    private var canArchive: Bool {
        thread.isArchived || thread.state != .working
    }

    @ViewBuilder
    private var renameConfirmButton: some View {
        let title = renameTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if #available(iOS 26, *) {
            Button("Rename", role: .confirm) { onRename?(title) }
                .disabled(title.isEmpty)
        } else {
            Button("Rename") { onRename?(title) }
                .disabled(title.isEmpty)
        }
    }

    @ViewBuilder
    private var deleteSection: some View {
        if let onDelete {
            Section {
                Button(role: .destructive) {
                    isConfirmingDelete = true
                } label: {
                    ThreadSheetRowLabel(title: "Delete Thread…", systemImage: "trash", tint: .red, titleColor: T3Colors.danger)
                }
                .confirmationDialog("Delete Thread?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
                    Button("Delete Thread", role: .destructive, action: onDelete)
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Thread history will be deleted. Worktree files stay on the environment.")
                }
            }
            .t3GroupedRow()
        }
    }

    // MARK: - Loading and git actions

    private func makeHermesModelIfNeeded() {
        guard hermes == nil, isHermesConversation,
              let manager = client as? any FeatureWorkManaging,
              let environmentID = environment?.id ?? thread.environmentID else { return }
        hermes = HermesThreadDetailsModel(
            manager: manager,
            environmentID: environmentID,
            threadID: thread.wireID ?? thread.id
        )
    }

    private func loadSourceControl() async {
        guard !isHermesConversation, !isChatConversation else { isLoadingStatus = false; return }
        isLoadingStatus = true
        defer { isLoadingStatus = false }
        do {
            sourceControl = try await client.sourceControlStatus(threadID: thread.id)
            sourceControlError = nil
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            sourceControlError = error.localizedDescription
        }
    }

    private func runQuickAction() {
        guard !isRunningQuickAction, let gitStatus else { return }
        let quickAction = ThreadDetailsGit.quickAction(for: gitStatus, isBusy: false)
        let label = ThreadDetailsGit.titleCase(quickAction.label)
        switch quickAction.kind {
        case .openPullRequest:
            guard let pullRequest = gitStatus.pullRequest else { return }
            if environment?.supportsPullRequests == true {
                path.append(.pullRequest(number: pullRequest.number))
            } else {
                openInBrowser(pullRequest)
            }
        case .runPull:
            Task { await perform(.pull, label: label) }
        case .runAction:
            guard let action = quickAction.action else { return }
            // Publishing onto the default branch is the one git action worth
            // interrupting, because it is the one with no undo afterwards.
            if ThreadDetailsGit.requiresDefaultBranchConfirmation(action, isDefaultBranch: gitStatus.isDefaultRef) {
                pendingDefaultBranchAction = PendingGitAction(action: action, label: label)
                return
            }
            Task { await perform(featureAction(action), label: label) }
        case .showHint:
            break
        }
    }

    private func featureAction(_ action: GitStackedAction) -> FeatureSourceControlAction {
        switch action {
        case .commit: .commit
        case .push: .push
        case .createPullRequest: .createPullRequest
        case .commitAndPush: .commitAndPush
        case .commitPushAndPullRequest: .commitPushAndCreatePullRequest
        }
    }

    private func perform(_ action: FeatureSourceControlAction, label: String) async {
        guard runningQuickActionLabel == nil else { return }
        runningQuickActionLabel = label
        defer { runningQuickActionLabel = nil }
        do {
            // A nil message lets the server generate the commit text, which is
            // what the quick action means: one tap, no form.
            sourceControl = try await client.performSourceControlAction(
                threadID: thread.id,
                action: action,
                message: nil
            )
            sourceControlError = nil
            PlatformHapticEngine.shared.play(.success)
        } catch {
            failure = ThreadDetailsFailure(
                title: ThreadDetailsGit.failureTitle(for: action),
                message: error.localizedDescription
            )
            PlatformHapticEngine.shared.play(.error)
        }
    }
}

/// A failed action, titled by what did not happen.
struct ThreadDetailsFailure: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String
}

// MARK: - Background task row

/// A background command drawn as an ordinary row: its glyph, the command, and
/// the clock, mirroring apps/web/src/components/chat/BackgroundProcessRow.tsx.
///
/// Self-ticking elapsed time. The live set does not change while a command runs,
/// so a value rendered once by the parent would sit frozen. The tick only
/// rewrites text; nothing on the row animates while it waits.
///
/// Shared with the transcript bar's background capsule, which presents these
/// same rows in a card. That sheet also shows the one command whose ending it
/// is reporting, so a settled row keeps the capsule's tint for that ending.
struct ThreadDetailsBackgroundTaskRow: View {
    enum Style { case card, list }

    let process: ThreadDetailsBackgroundProcess
    var style: Style = .card

    var body: some View {
        // The cadence coarsens past ten minutes, where the seconds are noise and
        // a per-second re-render is pure waste.
        TimelineView(.periodic(from: .now, by: tickInterval)) { context in
            let now = Int(context.date.timeIntervalSince1970 * 1000)
            let view = ThreadDetailsBackgroundTasks.resolveView(
                process.command, nowMilliseconds: now
            )
            let symbol = view.variant == .monitor ? "moon.zzz.fill" : "terminal"
            let tint = ThreadBackgroundTint.color(
                live: view.live,
                ending: view.outcome?.tone,
                monitor: view.variant == .monitor,
                paused: view.paused
            )
            let title = ThreadDetailsBackgroundTasks.title(view)
            let subtitle = ThreadDetailsBackgroundTasks.subtitle(view, hasMonitor: process.monitor != nil)
            let detail = ThreadDetailsBackgroundTasks.detailLabel(view, nowMilliseconds: now)
            switch style {
            case .card:
                ThreadDetailsRow(
                    systemImage: symbol,
                    iconTint: tint,
                    title: title,
                    subtitle: subtitle,
                    showsChevron: false,
                    detail: {
                        ThreadDetailsRowBadge(text: detail, monospacedDigits: true)
                    }
                )
            case .list:
                LabeledContent {
                    Text(detail).monospacedDigit()
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title)
                                .font(T3Typography.threadBody)
                                .foregroundStyle(T3Colors.textPrimary)
                                .lineLimit(2)
                            if let subtitle, !subtitle.isEmpty {
                                Text(subtitle)
                                    .font(T3Typography.supporting)
                                    .foregroundStyle(T3Colors.textTertiary)
                                    .lineLimit(2)
                            }
                        }
                    } icon: {
                        Image(systemName: symbol).foregroundStyle(tint)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var tickInterval: TimeInterval {
        let view = ThreadDetailsBackgroundTasks.resolveView(
            process.command,
            nowMilliseconds: Int(Date().timeIntervalSince1970 * 1000)
        )
        // A paused or settled clock has nothing to count.
        guard view.live, !view.paused else { return 60 }
        let elapsed = ThreadDetailsBackgroundTasks.elapsedMilliseconds(
            view,
            nowMilliseconds: Int(Date().timeIntervalSince1970 * 1000)
        )
        return TimeInterval(ThreadDetailsBackgroundTasks.elapsedTickSeconds(elapsed))
    }
}
