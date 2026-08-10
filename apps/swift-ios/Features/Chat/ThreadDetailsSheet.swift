import SwiftUI

// The thread details sheet — the mobile presentation of the desktop
// thread-details panel, opened from the thread header.
//
// Ports apps/mobile/src/features/threads/details/ThreadDetailsSheet.tsx and the
// four section files beside it. Same sections in the same order (Workspace,
// Ports, Background Tasks, Version Control, Automations, Lineage), each hiding
// itself when it has nothing to report, so the sheet is only ever as tall as the
// thread has facts.
//
// Every rule lives in ThreadDetailsSections.swift; this file is the view.

/// Where a row inside the sheet sends the reader. Sheets stack over the thread,
/// so the caller dismisses this one before pushing anything.
enum ThreadDetailsDestination: Equatable {
    case connections
    case files
    case review
    case sourceControl
    case terminal
    case thread(id: String, isArchived: Bool)
}

struct ThreadDetailsSheet: View {
    let thread: FeatureThread
    let environment: FeatureEnvironment?
    let project: FeatureProject?
    let client: any FeatureClient
    let onNavigate: (ThreadDetailsDestination) -> Void
    let onReconnect: () -> Void

    /// Dev servers this thread is running. Empty until the client can report
    /// endpoints, at which point the section appears with no other change.
    var endpoints: [ThreadEndpoint] = []
    var scripts: [ProjectScript] = []
    var activeScriptIDs: [String] = []
    var onRunScript: ((ProjectScript) -> Void)?
    /// The same projection the timeline renders, so this sheet and the rows in
    /// the thread cannot disagree about what is running.
    var turnItems: [OrchestrationV2TurnItem] = []
    var relationships: ThreadRelationshipsModel?
    var onMergeBack: (() async -> Bool)?
    var onDetachSession: (() async -> Void)?
    var automations: [FeatureScheduledTask] = []
    var automationsFailedToLoad = false
    /// Thread-level actions, folded in here from the old toolbar ••• menu so
    /// the details button is the thread's single secondary surface.
    var onTogglePin: (() -> Void)?
    var onReload: (() -> Void)?
    var onToggleArchive: (() -> Void)?
    /// Chat conversations subtract the workbench: no workspace tools, ports,
    /// version control or automations — the environment row, background tasks,
    /// lineage and thread actions remain.
    var isChatConversation = false

    @State private var sourceControl: FeatureSourceControlStatus?
    @State private var isLoadingStatus = true
    @State private var isRunningAction = false
    @State private var actionError: String?
    @State private var pendingDefaultBranchAction: GitStackedAction?
    @State private var portAlert: ThreadDetailsPortsSection.OpenRefusal?
    @State private var presentedPullRequest: ThreadDetailsPullRequest?
    @SwiftUI.Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                connectionNotice
                workspaceSection
                if !isChatConversation {
                    portsSection
                }
                backgroundTasksSection
                if !isChatConversation {
                    versionControlSection
                    automationsSection
                }
                lineageSection
                threadActionsSection
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 36)
        }
        .scrollIndicators(.hidden)
        .background(T3Colors.background)
        .navigationTitle(thread.title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await loadSourceControl() }
        .task { await loadSourceControl() }
        .alert(
            "Git action failed",
            isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )
        ) {
            Button("OK") {}
        } message: {
            Text(actionError ?? "")
        }
        .alert(
            portAlert?.title ?? "",
            isPresented: Binding(
                get: { portAlert != nil },
                set: { if !$0 { portAlert = nil } }
            )
        ) {
            Button("OK") {}
        } message: {
            Text(portAlert?.message ?? "")
        }
        .confirmationDialog(
            defaultBranchConfirmationTitle,
            isPresented: Binding(
                get: { pendingDefaultBranchAction != nil },
                set: { if !$0 { pendingDefaultBranchAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Continue on this branch") {
                if let action = pendingDefaultBranchAction {
                    pendingDefaultBranchAction = nil
                    Task { await run(action) }
                }
            }
            Button("Cancel", role: .cancel) { pendingDefaultBranchAction = nil }
        } message: {
            Text(
                "This publishes straight to \(gitStatus?.refName ?? "the default branch"), "
                    + "which has no undo on the other side."
            )
        }
        .sheet(item: $presentedPullRequest) { pullRequest in
            NavigationStack {
                PullRequestDetailSheet(
                    client: client,
                    threadID: thread.id,
                    number: pullRequest.number
                )
            }
        }
        .accessibilityIdentifier("thread-details-sheet")
    }

    // MARK: - Derived state

    private var gitStatus: ThreadDetailsGitStatus? {
        sourceControl.map(ThreadDetailsGitStatus.init(sourceControl:))
    }

    /// A Hermes conversation has no project, so it has no folder to name and
    /// nothing under it to browse or run.
    private var workspacePath: String? {
        thread.worktreePath ?? project?.path
    }

    private var connectionState: FeatureConnection.State? {
        environment?.connectionState
    }

    private var quickAction: ThreadDetailsGitQuickAction {
        ThreadDetailsGit.quickAction(
            for: gitStatus,
            isBusy: isRunningAction || (sourceControl?.isBusy ?? false)
        )
    }

    private var backgroundProcesses: [ThreadDetailsBackgroundProcess] {
        ThreadDetailsBackgroundTasks.liveProcesses(turnItems)
    }

    private var boundAutomations: [FeatureScheduledTask] {
        ThreadDetailsAutomationsSection.boundTasks(automations, threadID: thread.id)
    }

    private var defaultBranchConfirmationTitle: String {
        "Publish to \(gitStatus?.refName ?? "default branch")?"
    }

    // MARK: - Connection notice

    @ViewBuilder
    private var connectionNotice: some View {
        if ThreadDetailsConnection.hasIssue(connectionState) {
            ThreadDetailsNotice(
                title: "Environment unavailable",
                message: environment?.connectionDetail
                    ?? ThreadDetailsConnection.fallbackNoticeBody
            ) {
                ThreadDetailsNoticeButton(
                    label: ThreadDetailsConnection.reconnectLabel(connectionState),
                    tone: .primary,
                    isDisabled: ThreadDetailsConnection.isReconnecting(connectionState),
                    action: onReconnect
                )
                ThreadDetailsNoticeButton(label: "Connections") {
                    onNavigate(.connections)
                }
            }
        }
    }

    // MARK: - Workspace

    private var workspaceSection: some View {
        ThreadDetailsSection(title: "Workspace") {
            ThreadDetailsRow(
                systemImage: "server.rack",
                title: environment?.name ?? thread.environmentName ?? "This environment",
                subtitle: ThreadDetailsConnection.label(connectionState)
            ) {
                onNavigate(.connections)
            }

            if let workspacePath, !isChatConversation {
                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: ThreadDetailsWorkspace.icon(worktreePath: thread.worktreePath),
                    title: ThreadDetailsWorkspace.label(
                        worktreePath: thread.worktreePath,
                        projectTitle: project?.name,
                        workspaceRoot: project?.path
                    ),
                    subtitle: workspacePath,
                    action: { onNavigate(.sourceControl) },
                    trailing: {
                        ThreadDetailsRowBadge(
                            text: ThreadDetailsWorkspace.kindLabel(
                                worktreePath: thread.worktreePath
                            )
                        )
                    }
                )

                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: "folder",
                    title: "Files",
                    subtitle: "Browse this thread's workspace"
                ) {
                    onNavigate(.files)
                }

                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: "terminal",
                    title: "Terminal",
                    subtitle: "Run commands in this workspace"
                ) {
                    onNavigate(.terminal)
                }
            }

            ForEach(isChatConversation ? [] : scripts) { script in
                let isActive = activeScriptIDs.contains(script.id)
                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: ThreadDetailsWorkspace.scriptRowIcon(script, isActive: isActive),
                    title: ThreadDetailsWorkspace.scriptRowTitle(script, isActive: isActive),
                    subtitle: script.command,
                    showsChevron: false,
                    action: onRunScript.map { run in { run(script) } }
                )
            }
        }
    }

    // MARK: - Thread actions

    /// Pin, reload and archive — the rows that used to live in the toolbar's
    /// ••• menu. Last in the sheet: they act on the thread rather than report
    /// on it, and archive ends the visit.
    @ViewBuilder
    private var threadActionsSection: some View {
        if onTogglePin != nil || onReload != nil || onToggleArchive != nil {
            ThreadDetailsSection(title: "Thread") {
                if let onTogglePin, thread.canTogglePin, !thread.isArchived {
                    ThreadDetailsRow(
                        systemImage: thread.pinnedAt == nil ? "pin" : "pin.slash",
                        title: thread.pinnedAt == nil ? "Pin" : "Unpin",
                        showsChevron: false,
                        action: onTogglePin
                    )
                    ThreadDetailsDivider()
                }

                if let onReload {
                    ThreadDetailsRow(
                        systemImage: "arrow.clockwise",
                        title: "Reload",
                        subtitle: "Refresh this thread from the server",
                        showsChevron: false,
                        action: onReload
                    )
                }

                if let onToggleArchive {
                    ThreadDetailsDivider()
                    ThreadDetailsRow(
                        systemImage: thread.isArchived ? "arrow.uturn.backward" : "archivebox",
                        title: thread.isArchived ? "Restore" : "Archive",
                        showsChevron: false,
                        action: onToggleArchive
                    )
                }
            }
        }
    }

    // MARK: - Ports

    @ViewBuilder
    private var portsSection: some View {
        if !endpoints.isEmpty {
            ThreadDetailsSection(
                title: "Ports",
                footer: ThreadDetailsPortsSection.overflowFooter(endpoints)
            ) {
                ForEach(
                    Array(ThreadDetailsPortsSection.visible(endpoints).enumerated()),
                    id: \.element.id
                ) { index, endpoint in
                    if index > 0 { ThreadDetailsDivider() }
                    portRow(endpoint)
                }
            }
        }
    }

    private func portRow(_ endpoint: ThreadEndpoint) -> some View {
        // The subtitle is the *resolved* address or the reason there isn't one —
        // never the announced `localhost:PORT`, which on a phone names the
        // handset rather than the machine running the server.
        ThreadDetailsRow(
            systemImage: ThreadPortsMenu.icon(for: endpoint),
            iconTint: endpoint.status == .live ? T3Colors.success : T3Colors.textSecondary,
            title: ThreadPortsMenu.label(for: endpoint, scripts: scripts),
            subtitle: ThreadPortsMenu.subtitle(for: endpoint),
            action: { open(endpoint) },
            trailing: {
                Button {
                    UIPasteboard.general.string = ThreadDetailsPortsSection.copyURL(for: endpoint)
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 36, height: 36)
                        .background(T3Colors.subtle, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    ThreadDetailsPortsSection.copyAccessibilityLabel(
                        for: endpoint, scripts: scripts
                    )
                )
            }
        )
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
            ThreadDetailsSection(
                title: "Background Tasks",
                footer: ThreadDetailsBackgroundTasks.overflowFooter(processes)
            ) {
                ForEach(
                    Array(ThreadDetailsBackgroundTasks.visible(processes).enumerated()),
                    id: \.element.id
                ) { index, process in
                    if index > 0 { ThreadDetailsDivider() }
                    ThreadDetailsBackgroundTaskRow(process: process)
                }
            }
        }
    }

    // MARK: - Version control

    @ViewBuilder
    private var versionControlSection: some View {
        if workspacePath != nil {
            ThreadDetailsSection(title: "Version Control") {
                ThreadDetailsRow(
                    systemImage: "point.topleft.down.curvedto.point.bottomright.up",
                    title: ThreadDetailsGit.branchLabel(gitStatus, threadBranch: thread.branch),
                    subtitle: isLoadingStatus && sourceControl == nil
                        ? ThreadDetailsGit.statusSummary(nil)
                        : ThreadDetailsGit.statusSummary(gitStatus)
                ) {
                    onNavigate(.sourceControl)
                }

                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: "text.bubble",
                    title: "Review changes",
                    subtitle: "Turn diffs and worktree changes",
                    isDisabled: isRunningAction || gitStatus?.isRepo == false,
                    action: { onNavigate(.review) },
                    detail: {
                        if let delta = ThreadDetailsGit.workingTreeDelta(gitStatus) {
                            ThreadDetailsRowBadge(text: delta, monospacedDigits: true)
                        }
                    }
                )

                if let pullRequest = gitStatus?.pullRequest {
                    ThreadDetailsDivider()
                    ThreadDetailsRow(
                        systemImage: "arrow.triangle.pull",
                        title: "Pull Request #\(pullRequest.number)",
                        subtitle: pullRequest.state.capitalized,
                        action: { open(pullRequest) }
                    )
                }

                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: ThreadDetailsGit.quickActionIcon(quickAction),
                    title: quickAction.label,
                    subtitle: ThreadDetailsGit.quickActionSubtitle(quickAction),
                    isDisabled: quickAction.disabled,
                    showsChevron: false,
                    action: { Task { await runQuickAction() } }
                )

                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: "ellipsis",
                    title: "More git actions",
                    subtitle: "Commit, files, branches"
                ) {
                    onNavigate(.sourceControl)
                }
            }
        }
    }

    // MARK: - Automations

    @ViewBuilder
    private var automationsSection: some View {
        if ThreadDetailsAutomationsSection.isVisible(
            tasks: automations,
            threadID: thread.id,
            hasError: automationsFailedToLoad
        ) {
            ThreadDetailsSection(title: "Automations") {
                if automationsFailedToLoad {
                    Text(ThreadDetailsAutomationsSection.loadErrorMessage)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(Array(boundAutomations.enumerated()), id: \.element.id) { index, task in
                        if index > 0 { ThreadDetailsDivider() }
                        ThreadDetailsRow(
                            title: task.title,
                            subtitle: ThreadDetailsAutomationsSection.subtitle(
                                for: task, now: .now
                            ),
                            showsChevron: false,
                            leading: {
                                ThreadDetailsStatusDot(
                                    color: automationTone(task),
                                    dimmed: !task.enabled
                                )
                            }
                        )
                    }
                }
            }
        }
    }

    private func automationTone(_ task: FeatureScheduledTask) -> Color {
        switch ThreadDetailsAutomationsSection.statusTone(for: task) {
        case .dormant: T3Colors.textTertiary
        case .running: T3Colors.statusRunning
        case .success: T3Colors.success
        case .danger: T3Colors.danger
        }
    }

    // MARK: - Lineage

    @ViewBuilder
    private var lineageSection: some View {
        if let relationships, !relationships.isEmpty {
            ThreadDetailsLineageRows(
                relationships: relationships,
                onOpenThread: { threadID, isArchived in
                    onNavigate(.thread(id: threadID, isArchived: isArchived))
                },
                onMergeBack: onMergeBack,
                onDetachSession: onDetachSession
            )
        }
    }

    // MARK: - Actions

    /// The native sheet where the server can answer for it; the host's own
    /// page everywhere else, exactly as this row behaved before the sheet
    /// existed.
    private func open(_ pullRequest: ThreadDetailsPullRequest) {
        if environment?.supportsPullRequests == true {
            presentedPullRequest = pullRequest
            return
        }
        guard let address = pullRequest.url, let url = URL(string: address) else {
            actionError = "This pull request has no link to open."
            return
        }
        openURL(url)
    }

    private func loadSourceControl() async {
        isLoadingStatus = true
        defer { isLoadingStatus = false }
        sourceControl = try? await client.sourceControlStatus(threadID: thread.id)
    }

    private func runQuickAction() async {
        switch quickAction.kind {
        case .openPullRequest:
            guard let address = gitStatus?.pullRequest?.url, let url = URL(string: address) else {
                actionError = "This branch does not have an open pull request."
                return
            }
            openURL(url)
        case .runPull:
            await perform(.pull)
        case .runAction:
            guard let action = quickAction.action else { return }
            // Publishing onto the default branch is the one git action worth
            // interrupting, because it is the one with no undo afterwards.
            if ThreadDetailsGit.requiresDefaultBranchConfirmation(
                action,
                isDefaultBranch: gitStatus?.isDefaultRef ?? false
            ) {
                pendingDefaultBranchAction = action
                return
            }
            await run(action)
        case .showHint:
            break
        }
    }

    private func run(_ action: GitStackedAction) async {
        await perform(featureAction(action))
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

    private func perform(_ action: FeatureSourceControlAction) async {
        isRunningAction = true
        defer { isRunningAction = false }
        do {
            // A nil message lets the server generate the commit text, which is
            // what the quick action means: one tap, no form.
            sourceControl = try await client.performSourceControlAction(
                threadID: thread.id,
                action: action,
                message: nil
            )
        } catch {
            actionError = error.localizedDescription
        }
    }
}

/// Item-presented so the sheet always opens on the request the row named; a
/// branch has one change request at a time, so the number identifies it.
extension ThreadDetailsPullRequest: Identifiable {
    public var id: Int { number }
}

// MARK: - Background task row

/// Self-ticking elapsed time. The live set does not change while a command runs,
/// so a value rendered once by the parent would sit frozen.
private struct ThreadDetailsBackgroundTaskRow: View {
    let process: ThreadDetailsBackgroundProcess

    var body: some View {
        // The cadence coarsens past ten minutes, where the seconds are noise and
        // a per-second re-render is pure waste.
        TimelineView(.periodic(from: .now, by: tickInterval)) { context in
            let now = Int(context.date.timeIntervalSince1970 * 1000)
            let view = ThreadDetailsBackgroundTasks.resolveView(
                process.command, nowMilliseconds: now
            )
            ThreadDetailsRow(
                title: ThreadDetailsBackgroundTasks.title(view),
                titleIsMonospaced: ThreadDetailsBackgroundTasks.titleIsMonospaced(view),
                subtitle: ThreadDetailsBackgroundTasks.subtitle(
                    view, hasMonitor: process.monitor != nil
                ),
                showsChevron: false,
                leading: {
                    // `bg-info` on the web; here the same "a command is running"
                    // blue the composer strip paints, dimmed while paused.
                    ThreadDetailsStatusDot(color: T3Colors.statusRunning, dimmed: view.paused)
                },
                detail: {
                    ThreadDetailsRowBadge(
                        text: ThreadDetailsBackgroundTasks.detailLabel(view, nowMilliseconds: now),
                        monospacedDigits: true
                    )
                }
            )
        }
    }

    private var tickInterval: TimeInterval {
        let view = ThreadDetailsBackgroundTasks.resolveView(
            process.command,
            nowMilliseconds: Int(Date().timeIntervalSince1970 * 1000)
        )
        guard !view.paused else { return 60 }
        let elapsed = ThreadDetailsBackgroundTasks.elapsedMilliseconds(
            view,
            nowMilliseconds: Int(Date().timeIntervalSince1970 * 1000)
        )
        return TimeInterval(ThreadDetailsBackgroundTasks.elapsedTickSeconds(elapsed))
    }
}

// MARK: - Lineage rows

/// The thread's parents, forks, transfers and subagents, plus the merge-back and
/// detach actions the desktop panel offers on the same rows.
///
/// Derivation is `ThreadRelationships`', shared with the lineage banner above
/// the transcript; this is the details sheet's compact presentation of it.
private struct ThreadDetailsLineageRows: View {
    let relationships: ThreadRelationshipsModel
    let onOpenThread: (_ threadID: String, _ isArchived: Bool) -> Void
    let onMergeBack: (() async -> Bool)?
    let onDetachSession: (() async -> Void)?

    @State private var decay = ThreadRelationshipDecay()
    @State private var visibleRows: [ThreadRelationshipRow] = []
    @State private var archivedRows: [ThreadRelationshipRow] = []
    @State private var showsArchived = false
    @State private var busyAction: BusyAction?

    private enum BusyAction: Equatable { case merge, detach }

    var body: some View {
        ThreadDetailsSection(title: ThreadDetailsLineageSection.title(rows: relationships.rows)) {
            ForEach(Array(visibleRows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { ThreadDetailsDivider() }
                relationshipRow(row)
            }

            if !archivedRows.isEmpty {
                if !visibleRows.isEmpty { ThreadDetailsDivider() }
                doneGroupToggle
                if showsArchived {
                    ForEach(archivedRows) { row in
                        ThreadDetailsDivider()
                        relationshipRow(row)
                    }
                }
            }

            if relationships.canMerge, let onMergeBack {
                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: "arrow.triangle.merge",
                    title: "Merge back to source",
                    isDisabled: busyAction != nil,
                    showsChevron: false,
                    action: {
                        Task {
                            busyAction = .merge
                            let merged = await onMergeBack()
                            busyAction = nil
                            if merged, let target = relationships.mergeTargetThreadID {
                                onOpenThread(target, false)
                            }
                        }
                    },
                    trailing: {
                        if busyAction == .merge { ProgressView() }
                    }
                )
            }

            if relationships.canDetach, let onDetachSession {
                ThreadDetailsDivider()
                ThreadDetailsRow(
                    systemImage: "bolt.slash",
                    title: "Disconnect agent session",
                    isDisabled: busyAction != nil,
                    showsChevron: false,
                    action: {
                        Task {
                            busyAction = .detach
                            await onDetachSession()
                            busyAction = nil
                        }
                    },
                    trailing: {
                        if busyAction == .detach { ProgressView() }
                    }
                )
            }
        }
        .task(id: relationships.rows) { await trackDecay() }
    }

    private var doneGroupToggle: some View {
        Button {
            showsArchived.toggle()
        } label: {
            HStack(spacing: 8) {
                Text(ThreadDetailsLineageSection.doneGroupLabel(count: archivedRows.count))
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
                Image(systemName: showsArchived ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            ThreadDetailsLineageSection.doneGroupAccessibilityLabel(count: archivedRows.count)
        )
    }

    @ViewBuilder
    private func relationshipRow(_ row: ThreadRelationshipRow) -> some View {
        let availability = relationships.availability(for: row.threadID)
        let isArchived = ThreadDetailsLineageSection.isArchived(availability: availability)
        ThreadDetailsRow(
            title: relationships.title(for: row.threadID),
            subtitle: ThreadRelationships.label(
                row.edge, currentThreadID: relationships.currentThreadID
            ),
            isDisabled: ThreadDetailsLineageSection.isDisabled(availability: availability),
            showsChevron: availability == nil,
            action: { onOpenThread(row.threadID, isArchived) },
            leading: {
                if row.edge.kind == .subagent {
                    AgentOrb(
                        seed: relationships.subagent(for: row.threadID)?.orbSeed ?? row.threadID,
                        size: 32,
                        state: orbState(row)
                    )
                } else {
                    ThreadDetailsRowIcon(systemName: ThreadRelationships.symbol(row.edge))
                }
            },
            detail: {
                if let availability {
                    ThreadDetailsRowBadge(text: availability)
                }
            }
        )
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
    private func trackDecay() async {
        while !Task.isCancelled {
            let split = decay.split(rows: relationships.rows)
            visibleRows = split.visible
            archivedRows = split.archived
            guard let next = split.nextRefresh else { return }
            let delay = next.timeIntervalSinceNow + 0.05
            guard delay > 0 else { continue }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }
}
