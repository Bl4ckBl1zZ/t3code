import Foundation

// Presentation for the thread details sheet — the mobile form of the desktop
// thread-details panel. Ported from
// apps/mobile/src/features/threads/details/ (ThreadDetailsSheet.tsx and its
// Ports / Background Tasks / Lineage / Automations sections),
// apps/mobile/src/features/threads/ThreadGitControls.tsx (the git quick action
// that moved into the sheet), packages/client-runtime/src/state/gitActions.ts,
// packages/client-runtime/src/state/threadRelationships.ts,
// packages/client-runtime/src/state/threadWorkflows.ts, and
// packages/shared/src/backgroundProcess.ts.
//
// Foundation only, so every rule the two clients have to agree on is testable
// without a view. ThreadDetailsSheet.swift renders this and
// ThreadDetailsRows.swift holds the row primitives.

// MARK: - Connection notice

/// The warning card the desktop panel puts above Workspace when the
/// environment cannot answer. Nothing else in the sheet works until it does, so
/// it is the one section that renders even when it has nothing good to report.
public enum ThreadDetailsConnection {
    /// `nil` is a saved environment this client has not probed yet — no evidence
    /// of a problem, so no warning. `connected` and `disconnected` split apart
    /// here: the React Native client treats its own `available` (never probed,
    /// or idle-but-reachable) as fine, and this is its native equivalent.
    public static func hasIssue(_ state: FeatureConnection.State?) -> Bool {
        guard let state else { return false }
        return state != .connected
    }

    public static func isReconnecting(_ state: FeatureConnection.State?) -> Bool {
        state == .connecting || state == .reconnecting
    }

    public static func label(_ state: FeatureConnection.State?) -> String {
        guard let state else { return "available" }
        return state.rawValue
    }

    public static let fallbackNoticeBody =
        "Reconnect this environment before sending messages or running actions."

    public static func reconnectLabel(_ state: FeatureConnection.State?) -> String {
        isReconnecting(state) ? "Reconnecting…" : "Reconnect"
    }
}

// MARK: - Version control

/// The pull request a branch row reports, narrowed to what the sheet reads.
public struct ThreadDetailsPullRequest: Equatable, Sendable {
    public let number: Int
    public let state: String
    public let url: String?

    public init(number: Int, state: String, url: String?) {
        self.number = number
        self.state = state
        self.url = url
    }

    public var isOpen: Bool { state == "open" }
}

/// What a person may type to name a pull request they want pinned to a thread.
///
/// Web links one by right-clicking its link in the transcript; a phone has no
/// equivalent gesture over rendered inline text, so the sheet accepts what a
/// reader can reach instead — the number, or the URL they copied from the host.
/// Only the number travels: the repository is the project's, which the client
/// resolves rather than trusting the pasted host to agree about.
public enum ThreadLinkedPullRequestInput {
    public static func parse(_ raw: String) -> Int? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // "#123" and "123" are the same request; a URL is matched on its
        // /pull/<n> or /merge_requests/<n> segment so GitHub and GitLab links
        // both work, and any trailing /files or #discussion is ignored.
        if let match = trimmed.firstMatch(
            of: /(?:pull|pulls|merge_requests)\/(\d+)/
        ), let number = Int(match.1) {
            return number > 0 ? number : nil
        }
        let digits = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard digits.allSatisfy(\.isNumber), let number = Int(digits), number > 0 else {
            return nil
        }
        return number
    }
}

/// The git facts the sheet reads, in the shape
/// packages/contracts' `VcsStatusResult` reports them.
///
/// Modelled separately from Core's `VCSStatus` because the sheet has to be able
/// to build one from whatever status the client actually has: the wire status
/// (`init(_:)`) and the feature-layer status (`init(sourceControl:)`) now carry
/// the same facts, so both paths produce the same rows and the same
/// confirmations.
public struct ThreadDetailsGitStatus: Equatable, Sendable {
    public let isRepo: Bool
    public let refName: String?
    public let hasWorkingTreeChanges: Bool
    public let changedFileCount: Int
    public let insertions: Int
    public let deletions: Int
    public let hasUpstream: Bool
    public let aheadCount: Int
    public let behindCount: Int
    public let isDefaultRef: Bool
    public let hasPrimaryRemote: Bool
    public let pullRequest: ThreadDetailsPullRequest?

    public init(
        isRepo: Bool,
        refName: String?,
        hasWorkingTreeChanges: Bool,
        changedFileCount: Int,
        insertions: Int = 0,
        deletions: Int = 0,
        hasUpstream: Bool,
        aheadCount: Int,
        behindCount: Int,
        isDefaultRef: Bool,
        hasPrimaryRemote: Bool,
        pullRequest: ThreadDetailsPullRequest?
    ) {
        self.isRepo = isRepo
        self.refName = refName
        self.hasWorkingTreeChanges = hasWorkingTreeChanges
        self.changedFileCount = changedFileCount
        self.insertions = insertions
        self.deletions = deletions
        self.hasUpstream = hasUpstream
        self.aheadCount = aheadCount
        self.behindCount = behindCount
        self.isDefaultRef = isDefaultRef
        self.hasPrimaryRemote = hasPrimaryRemote
        self.pullRequest = pullRequest
    }

    /// Lossless read of the wire status. Every field the quick action depends on
    /// is present here, so this is the path that produces the same rows as the
    /// desktop panel.
    public init(_ status: VCSStatus) {
        self.init(
            isRepo: status.isRepo,
            refName: status.refName,
            hasWorkingTreeChanges: status.hasWorkingTreeChanges,
            changedFileCount: status.workingTree.files.count,
            insertions: status.workingTree.insertions,
            deletions: status.workingTree.deletions,
            hasUpstream: status.hasUpstream,
            aheadCount: status.aheadCount,
            behindCount: status.behindCount,
            isDefaultRef: status.isDefaultRef,
            hasPrimaryRemote: status.hasPrimaryRemote,
            pullRequest: status.pr.map {
                ThreadDetailsPullRequest(number: $0.number, state: $0.state, url: $0.url)
            }
        )
    }

    /// Lossless read of the feature-layer status.
    ///
    /// `FeatureSourceControlStatus` reports `hasWorkingTreeChanges`,
    /// `hasUpstream`, `isDefaultRef`, `hasPrimaryRemote` and the working-tree
    /// line counts directly, so nothing here is inferred:
    ///
    /// - `hasWorkingTreeChanges` is the server's own verdict rather than
    ///   `!files.isEmpty`, which misses a dirty tree whose numstat is empty
    ///   (mode-only changes, ignored-but-listed paths).
    /// - `hasUpstream` is the tracking fact, not drift: a branch level with its
    ///   upstream has both counts at zero and is still tracked.
    /// - `isDefaultRef` is what makes the commit confirmation fire before a
    ///   publish lands on the repository's main line, so guessing `false` here
    ///   silently removed that prompt.
    public init(sourceControl status: FeatureSourceControlStatus) {
        self.init(
            isRepo: status.isRepository,
            refName: status.branch,
            hasWorkingTreeChanges: status.hasWorkingTreeChanges,
            changedFileCount: status.files.count,
            insertions: status.insertions,
            deletions: status.deletions,
            hasUpstream: status.hasUpstream,
            aheadCount: status.aheadCount,
            behindCount: status.behindCount,
            isDefaultRef: status.isDefaultRef,
            hasPrimaryRemote: status.hasPrimaryRemote,
            pullRequest: status.pullRequest.map {
                ThreadDetailsPullRequest(
                    number: $0.number,
                    state: $0.state,
                    url: $0.url?.absoluteString
                )
            }
        )
    }
}

public enum ThreadDetailsGitQuickActionKind: String, Equatable, Sendable {
    case runAction = "run_action"
    case runPull = "run_pull"
    case openPullRequest = "open_pr"
    case showHint = "show_hint"
}

/// The single button the desktop panel and this sheet both lead with: the one
/// git action this branch's state actually calls for.
public struct ThreadDetailsGitQuickAction: Equatable, Sendable {
    public let label: String
    public let disabled: Bool
    public let kind: ThreadDetailsGitQuickActionKind
    public let action: GitStackedAction?
    /// Why a disabled action is disabled. Shown as the row's subtitle, because a
    /// greyed-out button with no explanation is the worst of both.
    public let hint: String?

    public init(
        label: String,
        disabled: Bool,
        kind: ThreadDetailsGitQuickActionKind,
        action: GitStackedAction? = nil,
        hint: String? = nil
    ) {
        self.label = label
        self.disabled = disabled
        self.kind = kind
        self.action = action
        self.hint = hint
    }
}

public enum ThreadDetailsGit {
    /// One-line branch state: what changed, how far it has drifted, and whether
    /// a PR is already open.
    /// What the "Linked pull request" row reads on its right-hand side.
    /// "Follows the branch" is the default state, and saying so is what makes
    /// the row worth having when nothing is linked.
    public static func linkedPullRequestSubtitle(
        _ linked: FeatureLinkedPullRequest?
    ) -> String {
        guard let linked else { return "Follows the branch" }
        return "#\(linked.number) · \(linked.repository)"
    }

    public static func statusSummary(_ status: ThreadDetailsGitStatus?) -> String {
        guard let status else { return "Loading branch status…" }
        guard status.isRepo else { return "Not a git repository" }

        var parts: [String] = []
        if status.hasWorkingTreeChanges {
            let count = status.changedFileCount
            parts.append("\(count) file\(count == 1 ? "" : "s") changed")
        } else {
            parts.append("Clean")
        }
        if status.aheadCount > 0 { parts.append("\(status.aheadCount) ahead") }
        if status.behindCount > 0 { parts.append("\(status.behindCount) behind") }
        if let pullRequest = status.pullRequest, pullRequest.isOpen {
            parts.append("PR #\(pullRequest.number) open")
        }
        return parts.joined(separator: " · ")
    }

    /// Branch name for the Version Control heading row. A detached HEAD has no
    /// ref to name, and the thread's recorded branch is the next best answer.
    public static func branchLabel(
        _ status: ThreadDetailsGitStatus?,
        threadBranch: String?
    ) -> String {
        status?.refName ?? threadBranch ?? "Detached HEAD"
    }

    /// `+12 −3` beside "Review changes", or nothing when the tree is clean.
    /// Uses U+2212 rather than a hyphen so the two numbers align.
    public static func workingTreeDelta(_ status: ThreadDetailsGitStatus?) -> String? {
        let insertions = status?.insertions ?? 0
        let deletions = status?.deletions ?? 0
        guard insertions > 0 || deletions > 0 else { return nil }
        return "+\(insertions) −\(deletions)"
    }

    public static func quickActionIcon(_ quickAction: ThreadDetailsGitQuickAction) -> String {
        if quickAction.kind == .runPull { return "arrow.down.circle" }
        if quickAction.kind == .openPullRequest { return "arrow.up.right.circle" }
        if quickAction.action == .commit { return "checkmark.circle" }
        if quickAction.action == .push || quickAction.action == .commitAndPush {
            return "arrow.up.circle"
        }
        return "arrow.up.right.circle"
    }

    /// The sheet's whole decision: a workspace that is not a repository has no
    /// action to offer at all, and says so rather than offering a dead "Commit".
    public static func quickAction(
        for status: ThreadDetailsGitStatus?,
        isBusy: Bool
    ) -> ThreadDetailsGitQuickAction {
        // `nil` is a status still loading, which `resolveQuickAction` already
        // reports as unavailable. Only a *known* non-repository takes this path.
        if let status, !status.isRepo {
            return ThreadDetailsGitQuickAction(
                label: "Git unavailable",
                disabled: true,
                kind: .showHint,
                hint: "This workspace is not a git repository."
            )
        }
        return resolveQuickAction(
            status,
            isBusy: isBusy,
            isDefaultBranch: status?.isDefaultRef ?? false,
            hasOriginRemote: status?.hasPrimaryRemote ?? false
        )
    }

    public static func resolveQuickAction(
        _ status: ThreadDetailsGitStatus?,
        isBusy: Bool,
        isDefaultBranch: Bool = false,
        hasOriginRemote: Bool = true
    ) -> ThreadDetailsGitQuickAction {
        if isBusy {
            return ThreadDetailsGitQuickAction(
                label: "Commit",
                disabled: true,
                kind: .showHint,
                hint: "Git action in progress."
            )
        }

        guard let status else {
            return ThreadDetailsGitQuickAction(
                label: "Commit",
                disabled: true,
                kind: .showHint,
                hint: "Git status is unavailable."
            )
        }

        let hasBranch = status.refName != nil
        let hasChanges = status.hasWorkingTreeChanges
        let hasOpenPr = status.pullRequest?.isOpen ?? false
        let isAhead = status.aheadCount > 0
        let isBehind = status.behindCount > 0
        let isDiverged = isAhead && isBehind

        guard hasBranch else {
            return ThreadDetailsGitQuickAction(
                label: "Commit",
                disabled: true,
                kind: .showHint,
                hint: "Create and checkout a branch before pushing or opening a PR."
            )
        }

        if hasChanges {
            if !status.hasUpstream, !hasOriginRemote {
                return ThreadDetailsGitQuickAction(
                    label: "Commit", disabled: false, kind: .runAction, action: .commit
                )
            }
            if hasOpenPr || isDefaultBranch {
                return ThreadDetailsGitQuickAction(
                    label: "Commit & push",
                    disabled: false,
                    kind: .runAction,
                    action: .commitAndPush
                )
            }
            return ThreadDetailsGitQuickAction(
                label: "Commit, push & PR",
                disabled: false,
                kind: .runAction,
                action: .commitPushAndPullRequest
            )
        }

        if !status.hasUpstream {
            if !hasOriginRemote {
                if hasOpenPr, !isAhead {
                    return ThreadDetailsGitQuickAction(
                        label: "View PR", disabled: false, kind: .openPullRequest
                    )
                }
                return ThreadDetailsGitQuickAction(
                    label: "Push",
                    disabled: true,
                    kind: .showHint,
                    hint: "Add an \"origin\" remote before pushing or creating a PR."
                )
            }
            if !isAhead {
                if hasOpenPr {
                    return ThreadDetailsGitQuickAction(
                        label: "View PR", disabled: false, kind: .openPullRequest
                    )
                }
                return ThreadDetailsGitQuickAction(
                    label: "Push",
                    disabled: true,
                    kind: .showHint,
                    hint: "No local commits to push."
                )
            }
            if hasOpenPr || isDefaultBranch {
                return ThreadDetailsGitQuickAction(
                    label: "Push",
                    disabled: false,
                    kind: .runAction,
                    action: isDefaultBranch ? .commitAndPush : .push
                )
            }
            return ThreadDetailsGitQuickAction(
                label: "Push & create PR",
                disabled: false,
                kind: .runAction,
                action: .createPullRequest
            )
        }

        if isDiverged {
            return ThreadDetailsGitQuickAction(
                label: "Sync branch",
                disabled: true,
                kind: .showHint,
                hint: "Branch has diverged from upstream. Rebase/merge first."
            )
        }

        if isBehind {
            return ThreadDetailsGitQuickAction(label: "Pull", disabled: false, kind: .runPull)
        }

        if isAhead {
            if hasOpenPr || isDefaultBranch {
                return ThreadDetailsGitQuickAction(
                    label: "Push",
                    disabled: false,
                    kind: .runAction,
                    action: isDefaultBranch ? .commitAndPush : .push
                )
            }
            return ThreadDetailsGitQuickAction(
                label: "Push & create PR",
                disabled: false,
                kind: .runAction,
                action: .createPullRequest
            )
        }

        if hasOpenPr, status.hasUpstream {
            return ThreadDetailsGitQuickAction(
                label: "View PR", disabled: false, kind: .openPullRequest
            )
        }

        return ThreadDetailsGitQuickAction(
            label: "Commit",
            disabled: true,
            kind: .showHint,
            hint: "Branch is up to date. No action needed."
        )
    }

    /// Publishing straight onto the default branch is the one git action worth
    /// interrupting, because it is the one with no undo on the other side.
    public static func requiresDefaultBranchConfirmation(
        _ action: GitStackedAction,
        isDefaultBranch: Bool
    ) -> Bool {
        guard isDefaultBranch else { return false }
        switch action {
        case .push, .createPullRequest, .commitAndPush, .commitPushAndPullRequest: return true
        case .commit: return false
        }
    }

    /// Subtitle for a disabled quick action. A disabled row with no sentence
    /// under it reads as a bug rather than as a state.
    public static func quickActionSubtitle(
        _ quickAction: ThreadDetailsGitQuickAction
    ) -> String? {
        guard quickAction.disabled else { return nil }
        return quickAction.hint ?? "This action is unavailable."
    }
}

// MARK: - Workspace

public enum ThreadDetailsWorkspace {
    /// Last path segment, matching the React Native client's `basename` down to
    /// its edge cases: a trailing-slash-only path is the root, and an empty
    /// path has no name at all.
    public static func basename(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        var normalized = Substring(path)
        while normalized.hasSuffix("/") { normalized = normalized.dropLast() }
        if normalized.isEmpty { return "/" }
        let segments = normalized.split(separator: "/", omittingEmptySubsequences: false)
        return String(segments.last ?? normalized)
    }

    /// What to call this thread's folder. The worktree it was given names it
    /// best; failing that the project does; failing that the project's root
    /// folder does.
    public static func label(
        worktreePath: String?,
        projectTitle: String?,
        workspaceRoot: String?
    ) -> String {
        if let name = basename(worktreePath) { return name }
        if let projectTitle, !projectTitle.isEmpty { return projectTitle }
        if let name = basename(workspaceRoot) { return name }
        return "Workspace"
    }

    /// A worktree is a branch of its own, and saying so is the difference
    /// between "my edits are isolated" and "I am editing the project in place".
    public static func icon(worktreePath: String?) -> String {
        worktreePath == nil ? "folder" : "arrow.triangle.branch"
    }

    public static func kindLabel(worktreePath: String?) -> String {
        worktreePath == nil ? "Project folder" : "Worktree"
    }

    public static func scriptLabel(_ script: ProjectScript) -> String {
        script.runOnWorktreeCreate ? "\(script.name) (setup)" : script.name
    }

    public static func scriptIcon(_ icon: String) -> String {
        switch icon {
        case "test": "flask"
        case "lint": "checklist"
        case "configure": "wrench.and.screwdriver"
        case "build": "hammer"
        case "debug": "ladybug"
        default: "play"
        }
    }

    /// A running script's row turns into its own stop button — the same row,
    /// because a separate one would leave the user hunting for which of two
    /// rows belongs to the thing that is running.
    public static func scriptRowIcon(_ script: ProjectScript, isActive: Bool) -> String {
        isActive ? "stop.fill" : scriptIcon(script.icon)
    }

    public static func scriptRowTitle(_ script: ProjectScript, isActive: Bool) -> String {
        isActive ? "Stop \(scriptLabel(script))" : scriptLabel(script)
    }
}

// MARK: - Ports

public enum ThreadDetailsPortsSection {
    /// Same ceiling as the desktop panel: past a handful of rows the section
    /// stops being glanceable.
    public static let visibleLimit = 4

    public static func visible(_ endpoints: [ThreadEndpoint]) -> [ThreadEndpoint] {
        Array(endpoints.prefix(visibleLimit))
    }

    public static func overflowFooter(_ endpoints: [ThreadEndpoint]) -> String? {
        guard endpoints.count > visibleLimit else { return nil }
        return "+\(endpoints.count - visibleLimit) more"
    }

    /// An alert instead of an open, with the reason. Both cases here would
    /// otherwise hand the user a connection error and no explanation of it.
    public struct OpenRefusal: Equatable, Sendable {
        public let title: String
        public let message: String
    }

    public static func openRefusal(for endpoint: ThreadEndpoint) -> OpenRefusal? {
        if case let .unreachable(reason) = endpoint.reachability {
            return OpenRefusal(title: "Cannot open this port", message: reason)
        }
        // A stale row is a server that stopped answering.
        if endpoint.status == .stale {
            return OpenRefusal(
                title: "Port no longer responding",
                message: "This server has stopped. Start it again to open it."
            )
        }
        return nil
    }

    public static func openURL(for endpoint: ThreadEndpoint) -> String? {
        guard openRefusal(for: endpoint) == nil,
              case let .reachable(url, _) = endpoint.reachability else { return nil }
        return url
    }

    /// Copy the reachable form when there is one; otherwise the announced URL is
    /// still useful to paste somewhere that *can* reach it.
    public static func copyURL(for endpoint: ThreadEndpoint) -> String {
        if case let .reachable(url, _) = endpoint.reachability { return url }
        return endpoint.url
    }

    public static func copyAccessibilityLabel(
        for endpoint: ThreadEndpoint,
        scripts: [ProjectScript]
    ) -> String {
        "Copy \(ThreadPortsMenu.label(for: endpoint, scripts: scripts)) URL"
    }
}

// MARK: - Background tasks

/// A `command_execution` item unpacked once, so the rules below can read its
/// liveness without re-matching the payload at every call site.
public struct ThreadDetailsBackgroundCommand: Equatable, Sendable, Identifiable {
    public let item: OrchestrationV2TurnItem
    public let input: String
    public let output: String?
    public let exitCode: Int?
    public let liveness: OrchestrationV2CommandLiveness

    public var id: String { item.id }

    public init?(_ item: OrchestrationV2TurnItem) {
        guard case let .commandExecution(input, output, exitCode, liveness) = item.payload else {
            return nil
        }
        self.item = item
        self.input = input
        self.output = output
        self.exitCode = exitCode
        self.liveness = liveness
    }
}

/// One thing the thread is waiting on, with the monitor that watches it folded
/// in rather than listed beside it.
public struct ThreadDetailsBackgroundProcess: Equatable, Sendable, Identifiable {
    public let command: ThreadDetailsBackgroundCommand
    /// The monitor waiting on this command, when one exists.
    public let monitor: ThreadDetailsBackgroundCommand?

    public var id: String { command.id }

    public init(command: ThreadDetailsBackgroundCommand, monitor: ThreadDetailsBackgroundCommand?) {
        self.command = command
        self.monitor = monitor
    }
}

/// How a live command presents itself, chosen by what the provider actually
/// makes knowable rather than by preference.
public enum ThreadDetailsBackgroundVariant: Equatable, Sendable {
    /// Output is readable while it runs — elapsed plus the last line.
    case tail
    /// A timeout was declared but no output is available until it exits.
    case deadline
    /// The command exists only to wait for something; the agent is asleep.
    case monitor
}

public struct ThreadDetailsBackgroundView: Equatable, Sendable {
    public let variant: ThreadDetailsBackgroundVariant
    public let live: Bool
    public let paused: Bool
    public let command: String
    public let taskID: String?
    /// Last line of output, or nil when nothing has been printed yet.
    public let tail: String?
    public let outputTruncated: Bool
    /// Declared timeout, when the provider stated one.
    public let timeoutMilliseconds: Int?
    /// Milliseconds already excluded from elapsed time because it was paused.
    public let pausedMilliseconds: Int
    /// Epoch milliseconds the command started, or `now` when it never stamped one.
    public let startedAtMilliseconds: Int
    /// When it settled. Stops the clock, so a finished command does not keep
    /// counting up for as long as its row stays on screen.
    public let endedAtMilliseconds: Int?
    public let waitingOnTaskID: String?
}

/// Why a stopped background command is worth holding on screen for a moment.
///
/// A clean exit has no tone and never lingers: it already landed in the
/// transcript, and a bar that narrated every success would be chrome within a
/// minute. What the bar exists to catch is the opposite case — work that ended
/// badly while the reader was looking somewhere else.
public enum ThreadBackgroundOutcomeTone: Equatable, Sendable {
    case danger
    case warning
}

public struct ThreadBackgroundOutcome: Equatable, Sendable {
    public let tone: ThreadBackgroundOutcomeTone
    public let label: String
    /// Epoch milliseconds it settled, which is when the linger window opens.
    public let endedAtMilliseconds: Int

    public init(tone: ThreadBackgroundOutcomeTone, label: String, endedAtMilliseconds: Int) {
        self.tone = tone
        self.label = label
        self.endedAtMilliseconds = endedAtMilliseconds
    }
}

/// What the glyph on the collapsed capsule draws. Resolved once so the glyph and
/// the label cannot disagree about which state the capsule is reporting.
public enum ThreadBackgroundCapsuleGlyph: Equatable, Sendable {
    /// A command whose output is readable while it runs.
    case command
    /// A declared deadline, with progress toward it when it is knowable.
    case deadline(Double?)
    /// The agent is parked until a condition passes.
    case asleep
    /// Nothing is live; this is the ending still inside its linger window.
    case outcome(ThreadBackgroundOutcomeTone)
}

/// The whole of what the transcript bar's right-hand capsule knows, derived in
/// one pass so a glance at the capsule and a read of the sheet behind it agree.
///
/// The desktop equivalent is the strip above the composer
/// (apps/web/src/components/chat/BackgroundProcessesControl.tsx), which leads
/// with a count and the oldest process's elapsed time. This leads with time when
/// there is one process and a count when there are several, for the reason given
/// on ``ThreadDetailsBackgroundTasks/capsuleLabel(_:nowMilliseconds:)``.
public struct ThreadBackgroundSummary: Equatable, Sendable {
    /// Live processes, monitors already folded into what they watch — the same
    /// count `orchestrationV2BackgroundProcessCount` gives the desktop sidebar.
    public let count: Int
    /// The most active variant present; see `dominantVariant`.
    public let variant: ThreadDetailsBackgroundVariant
    /// Every live process is paused, so the capsule should stop pulsing.
    public let paused: Bool
    /// The only live process, when there is exactly one.
    public let solitary: ThreadDetailsBackgroundView?
    /// A recent bad ending still inside its linger window. Only consulted when
    /// nothing is live: running work is the headline, and a failure that has
    /// already been superseded by more work is history.
    public let outcome: ThreadBackgroundOutcome?

    public init(
        count: Int,
        variant: ThreadDetailsBackgroundVariant,
        paused: Bool,
        solitary: ThreadDetailsBackgroundView?,
        outcome: ThreadBackgroundOutcome?
    ) {
        self.count = count
        self.variant = variant
        self.paused = paused
        self.solitary = solitary
        self.outcome = outcome
    }

    /// A thread with no background work at all, for the path that skips the
    /// clock entirely because there is nothing on it that time could change.
    public static let empty = ThreadBackgroundSummary(
        count: 0, variant: .tail, paused: false, solitary: nil, outcome: nil
    )

    /// Nothing is running and nothing ended badly recently, so the capsule has
    /// nothing to report and leaves rather than sitting there empty.
    public var isEmpty: Bool { count == 0 && outcome == nil }

    /// An ending only speaks for the thread once the work has actually stopped.
    public var reportsOutcome: Bool { count == 0 && outcome != nil }
}

public enum ThreadDetailsBackgroundTasks {
    /// Same ceiling as the ports section, for the same reason.
    public static let visibleLimit = 4

    private static let monitorWaitKind = "monitor"

    public static func isBackgroundProcessItem(_ command: ThreadDetailsBackgroundCommand) -> Bool {
        command.liveness.background == true
    }

    /// Mirrors `orchestrationV2CommandExecutionIsLiveInBackground`: a command
    /// that has outlived the tool call which launched it and is still running.
    public static func isLiveInBackground(_ command: ThreadDetailsBackgroundCommand) -> Bool {
        isBackgroundProcessItem(command) && !command.item.status.isTerminal
    }

    /// Live background commands for a thread, with any monitor folded into the
    /// command it watches.
    ///
    /// Claude reports a monitor as a peer background task, so a plain listing
    /// shows two rows for one thing the user is waiting on. The monitor is an
    /// implementation detail of the wait, not a second process. Row count must
    /// stay equal to `orchestrationV2BackgroundProcessCount`, which drives the
    /// sidebar dot.
    public static func liveProcesses(
        _ items: [OrchestrationV2TurnItem]
    ) -> [ThreadDetailsBackgroundProcess] {
        liveProcesses(commands: backgroundCommands(items))
    }

    /// Every background command in the thread, finished ones included.
    ///
    /// The capsule needs the terminal ones to report a recent failure, and
    /// unpacking the payload once here keeps a per-tick re-render from
    /// re-matching every turn item in the thread.
    public static func backgroundCommands(
        _ items: [OrchestrationV2TurnItem]
    ) -> [ThreadDetailsBackgroundCommand] {
        items.compactMap(ThreadDetailsBackgroundCommand.init).filter(isBackgroundProcessItem)
    }

    public static func liveProcesses(
        commands: [ThreadDetailsBackgroundCommand]
    ) -> [ThreadDetailsBackgroundProcess] {
        let live = commands.filter(isLiveInBackground)
        let monitors = live.filter { $0.liveness.waitKind == monitorWaitKind }

        var foldedMonitorIDs: Set<String> = []
        var processes: [ThreadDetailsBackgroundProcess] = []
        for command in live {
            if command.liveness.waitKind == monitorWaitKind { continue }
            // Guarded on taskId: two commands with no handle must not both match
            // a monitor whose target is likewise absent.
            let monitor: ThreadDetailsBackgroundCommand? = command.liveness.taskId.flatMap { taskID in
                monitors.first { $0.liveness.waitingOnTaskId == taskID }
            }
            if let monitor { foldedMonitorIDs.insert(monitor.id) }
            processes.append(ThreadDetailsBackgroundProcess(command: command, monitor: monitor))
        }
        // An orphan monitor still deserves a row: the agent is asleep either
        // way, and silence is the failure mode this section exists to remove.
        for monitor in monitors where !foldedMonitorIDs.contains(monitor.id) {
            processes.append(ThreadDetailsBackgroundProcess(command: monitor, monitor: nil))
        }
        return processes
    }

    public static func visible(
        _ processes: [ThreadDetailsBackgroundProcess]
    ) -> [ThreadDetailsBackgroundProcess] {
        Array(processes.prefix(visibleLimit))
    }

    public static func overflowFooter(_ processes: [ThreadDetailsBackgroundProcess]) -> String? {
        guard processes.count > visibleLimit else { return nil }
        return "+\(processes.count - visibleLimit) more"
    }

    /// Last non-empty line, which is what "doing right now" means to a reader.
    public static func tail(_ output: String?) -> String? {
        guard let output else { return nil }
        for line in output.split(separator: "\n", omittingEmptySubsequences: false).reversed() {
            let trimmedEnd = String(line).replacingTrailingWhitespace()
            if !trimmedEnd.trimmingCharacters(in: .whitespaces).isEmpty { return trimmedEnd }
        }
        return nil
    }

    private static func variant(
        _ command: ThreadDetailsBackgroundCommand
    ) -> ThreadDetailsBackgroundVariant {
        if command.liveness.waitKind == monitorWaitKind { return .monitor }
        // Output beats a bar: a command that is visibly printing needs no
        // estimate, and one with a deadline but no output has nothing else.
        if command.liveness.hasOutputStream == true || !(command.output ?? "").isEmpty {
            return .tail
        }
        return command.liveness.timeoutMs == nil ? .tail : .deadline
    }

    public static func resolveView(
        _ command: ThreadDetailsBackgroundCommand,
        nowMilliseconds: Int
    ) -> ThreadDetailsBackgroundView {
        let startedAt =
            ThreadDetailsTimestamp.epochMilliseconds(command.item.base.startedAt) ?? nowMilliseconds
        return ThreadDetailsBackgroundView(
            variant: variant(command),
            live: !command.item.status.isTerminal,
            paused: command.liveness.paused == true,
            command: command.input,
            taskID: command.liveness.taskId,
            tail: tail(command.output),
            outputTruncated: command.liveness.outputTruncated == true,
            timeoutMilliseconds: command.liveness.timeoutMs,
            pausedMilliseconds: command.liveness.pausedMs ?? 0,
            startedAtMilliseconds: startedAt,
            endedAtMilliseconds: ThreadDetailsTimestamp.epochMilliseconds(
                command.item.base.completedAt
            ),
            waitingOnTaskID: command.liveness.waitingOnTaskId
        )
    }

    public static func elapsedMilliseconds(
        _ view: ThreadDetailsBackgroundView,
        nowMilliseconds: Int
    ) -> Int {
        let end = view.live ? nowMilliseconds : (view.endedAtMilliseconds ?? nowMilliseconds)
        return max(0, end - view.startedAtMilliseconds - view.pausedMilliseconds)
    }

    /// A monitor is named by what it is doing, not by the shell it runs; the
    /// command it watches already occupies the row above it.
    public static func title(_ view: ThreadDetailsBackgroundView) -> String {
        view.variant == .monitor ? "Waiting on a condition" : view.command
    }

    /// Monospaced only for a real command line. "Waiting on a condition" is
    /// prose and would read as code.
    public static func titleIsMonospaced(_ view: ThreadDetailsBackgroundView) -> Bool {
        view.variant != .monitor
    }

    public static func subtitle(
        _ view: ThreadDetailsBackgroundView,
        hasMonitor: Bool
    ) -> String {
        if view.variant == .monitor { return "the agent is asleep until this passes" }
        var parts = [view.tail ?? "no output yet"]
        if view.outputTruncated { parts.append("output capped") }
        if hasMonitor { parts.append("the agent is waiting on it") }
        return parts.joined(separator: " · ")
    }

    /// A monitor counts down to the moment it gives up; everything else counts
    /// up from when it started.
    public static func detailLabel(
        _ view: ThreadDetailsBackgroundView,
        nowMilliseconds: Int
    ) -> String {
        let elapsed = elapsedMilliseconds(view, nowMilliseconds: nowMilliseconds)
        if view.variant == .monitor, let timeout = view.timeoutMilliseconds {
            return "\(formatElapsed(max(0, timeout - elapsed))) left"
        }
        return formatElapsed(elapsed)
    }

    /// Coarse on purpose. Under ten minutes a reader wants seconds; past that
    /// the seconds are noise, and dropping them lets the row re-render a
    /// hundredth as often.
    public static func formatElapsed(_ milliseconds: Int) -> String {
        let totalSeconds = max(0, milliseconds / 1000)
        if totalSeconds < 60 { return "\(totalSeconds)s" }
        let minutes = totalSeconds / 60
        if minutes < 10 {
            let seconds = totalSeconds % 60
            return "\(minutes)m \(seconds < 10 ? "0" : "")\(seconds)s"
        }
        let hours = minutes / 60
        return hours == 0 ? "\(minutes)m" : "\(hours)h \(minutes % 60)m"
    }

    /// Tick cadence matched to the precision on screen — no wasted renders.
    public static func elapsedTickSeconds(_ milliseconds: Int) -> Int {
        milliseconds < 10 * 60 * 1000 ? 1 : 30
    }

    // MARK: Collapsed capsule

    /// How long a bad ending stays on the transcript bar after the work stops.
    ///
    /// Long enough to catch an eye already on the screen, short enough that the
    /// bar never becomes a place where old news accumulates. The failure keeps
    /// its permanent home in the transcript either way.
    public static let outcomeLingerMilliseconds = 6000

    /// A command's ending in the terms a reader would act on, mirroring
    /// `backgroundProcessOutcome` in packages/shared/src/backgroundProcess.ts.
    ///
    /// Returns nil for a clean exit. The distinction that matters most is
    /// between a command that failed and one that never got to finish — those
    /// look identical in a status field and mean opposite things.
    public static func outcome(_ command: ThreadDetailsBackgroundCommand) -> ThreadBackgroundOutcome? {
        guard command.item.status.isTerminal,
              let endedAt = ThreadDetailsTimestamp.epochMilliseconds(command.item.base.completedAt)
        else { return nil }

        switch command.liveness.exitReason {
        case "unknown":
            return ThreadBackgroundOutcome(
                tone: .warning, label: "outcome unknown", endedAtMilliseconds: endedAt
            )
        case "killed":
            return ThreadBackgroundOutcome(
                tone: .warning, label: "stopped", endedAtMilliseconds: endedAt
            )
        case "timeout":
            return ThreadBackgroundOutcome(
                tone: .warning, label: "timed out", endedAtMilliseconds: endedAt
            )
        default:
            break
        }

        if command.item.status == .cancelled || command.item.status == .interrupted {
            return ThreadBackgroundOutcome(
                tone: .warning, label: "stopped", endedAtMilliseconds: endedAt
            )
        }
        if command.item.status == .failed || (command.exitCode ?? 0) != 0 {
            return ThreadBackgroundOutcome(
                tone: .danger,
                label: command.exitCode.map { "exit \($0)" } ?? "failed",
                endedAtMilliseconds: endedAt
            )
        }
        return nil
    }

    /// The most recent bad ending still inside its window, carrying the command
    /// it came from so a tap on the capsule can land on that command rather than
    /// on an empty sheet.
    ///
    /// The window is a half-open range rather than a `<` on the elapsed gap so
    /// that a clock running behind the server cannot resurrect an ending from an
    /// hour ago as though it had just happened.
    public static func recentOutcomeCommand(
        commands: [ThreadDetailsBackgroundCommand],
        nowMilliseconds: Int
    ) -> (command: ThreadDetailsBackgroundCommand, outcome: ThreadBackgroundOutcome)? {
        commands
            .compactMap { command in outcome(command).map { (command: command, outcome: $0) } }
            .filter {
                (0..<outcomeLingerMilliseconds).contains(
                    nowMilliseconds - $0.outcome.endedAtMilliseconds
                )
            }
            .max { $0.outcome.endedAtMilliseconds < $1.outcome.endedAtMilliseconds }
    }

    public static func recentOutcome(
        commands: [ThreadDetailsBackgroundCommand],
        nowMilliseconds: Int
    ) -> ThreadBackgroundOutcome? {
        recentOutcomeCommand(commands: commands, nowMilliseconds: nowMilliseconds)?.outcome
    }

    /// What the capsule's sheet lists. Everything live; or, when nothing is
    /// live, the one command whose ending the capsule is currently reporting.
    public static func capsuleProcesses(
        commands: [ThreadDetailsBackgroundCommand],
        nowMilliseconds: Int
    ) -> [ThreadDetailsBackgroundProcess] {
        let live = liveProcesses(commands: commands)
        guard live.isEmpty,
              let recent = recentOutcomeCommand(commands: commands, nowMilliseconds: nowMilliseconds)
        else { return live }
        return [ThreadDetailsBackgroundProcess(command: recent.command, monitor: nil)]
    }

    /// Tail beats deadline beats monitor.
    ///
    /// The capsule has room for one glyph and should spend it on the most active
    /// thing happening: a command that is printing is the strongest signal the
    /// thread is alive, and a monitor only speaks for the thread once everything
    /// else has gone quiet.
    private static func dominantVariant(
        _ views: [ThreadDetailsBackgroundView]
    ) -> ThreadDetailsBackgroundVariant {
        if views.contains(where: { $0.variant == .tail }) { return .tail }
        if views.contains(where: { $0.variant == .deadline }) { return .deadline }
        return views.isEmpty ? .tail : .monitor
    }

    public static func summary(
        commands: [ThreadDetailsBackgroundCommand],
        nowMilliseconds: Int
    ) -> ThreadBackgroundSummary {
        let views = liveProcesses(commands: commands)
            .map { resolveView($0.command, nowMilliseconds: nowMilliseconds) }
        return ThreadBackgroundSummary(
            count: views.count,
            variant: dominantVariant(views),
            paused: !views.isEmpty && views.allSatisfy(\.paused),
            solitary: views.count == 1 ? views[0] : nil,
            outcome: recentOutcome(commands: commands, nowMilliseconds: nowMilliseconds)
        )
    }

    /// Milliseconds left on a declared deadline, or nil when none was declared.
    public static func remainingMilliseconds(
        _ view: ThreadDetailsBackgroundView,
        nowMilliseconds: Int
    ) -> Int? {
        guard let timeout = view.timeoutMilliseconds else { return nil }
        return max(0, timeout - elapsedMilliseconds(view, nowMilliseconds: nowMilliseconds))
    }

    /// 0–1 progress toward a declared deadline. Nil without one, because a bar
    /// that invents its own scale is a lie the reader cannot check.
    public static func deadlineFraction(
        _ view: ThreadDetailsBackgroundView,
        nowMilliseconds: Int
    ) -> Double? {
        guard let timeout = view.timeoutMilliseconds, timeout > 0 else { return nil }
        let elapsed = elapsedMilliseconds(view, nowMilliseconds: nowMilliseconds)
        return min(1, max(0, Double(elapsed) / Double(timeout)))
    }

    public static func capsuleGlyph(
        _ summary: ThreadBackgroundSummary,
        nowMilliseconds: Int
    ) -> ThreadBackgroundCapsuleGlyph {
        if summary.reportsOutcome, let outcome = summary.outcome {
            return .outcome(outcome.tone)
        }
        switch summary.variant {
        case .tail:
            return .command
        case .deadline:
            return .deadline(
                summary.solitary.flatMap { deadlineFraction($0, nowMilliseconds: nowMilliseconds) }
            )
        case .monitor:
            return .asleep
        }
    }

    /// One process reports time; several report a count.
    ///
    /// A bare "1" is the least useful thing a capsule this size could say — the
    /// glyph already told you a command is running. With several, their clocks
    /// disagree and no one of them speaks for the set, so the count is the only
    /// honest summary. A deadline counts down, everything else counts up.
    public static func capsuleLabel(
        _ summary: ThreadBackgroundSummary,
        nowMilliseconds: Int
    ) -> String {
        if summary.reportsOutcome, let outcome = summary.outcome { return outcome.label }
        guard let solitary = summary.solitary else { return "\(summary.count)" }
        if let remaining = remainingMilliseconds(solitary, nowMilliseconds: nowMilliseconds) {
            return formatElapsed(remaining)
        }
        return formatElapsed(elapsedMilliseconds(solitary, nowMilliseconds: nowMilliseconds))
    }

    /// Spoken form. The visible label is a bare duration or digit, which reads as
    /// nonsense without the noun the glyph is carrying.
    public static func capsuleAccessibilityLabel(
        _ summary: ThreadBackgroundSummary,
        nowMilliseconds: Int
    ) -> String {
        if summary.reportsOutcome, let outcome = summary.outcome {
            return "Background task \(outcome.label). Show background tasks"
        }
        let label = capsuleLabel(summary, nowMilliseconds: nowMilliseconds)
        var lead: String
        if let solitary = summary.solitary {
            // A monitor is named by what it is doing, the same way its row is.
            lead = solitary.variant == .monitor ? "Waiting on a condition" : "1 background task"
            lead += remainingMilliseconds(solitary, nowMilliseconds: nowMilliseconds) == nil
                ? ", running \(label)"
                : ", \(label) left"
        } else {
            lead = "\(summary.count) background tasks"
        }
        if summary.paused { lead += ", paused" }
        return "\(lead). Show background tasks"
    }

    /// Tick cadence for the capsule, matched to what is actually moving on it.
    public static func capsuleTickSeconds(
        _ summary: ThreadBackgroundSummary,
        nowMilliseconds: Int
    ) -> Int {
        // A linger window has to close on time, or a failure would sit on the
        // bar until some unrelated change forced a re-render.
        if summary.outcome != nil { return 1 }
        guard let solitary = summary.solitary else { return 30 }
        if solitary.paused { return 30 }
        // A ring that only advanced twice a minute would read as stuck.
        if solitary.variant == .deadline { return 1 }
        return elapsedTickSeconds(elapsedMilliseconds(solitary, nowMilliseconds: nowMilliseconds))
    }
}

// MARK: - Lineage

/// What the details sheet adds on top of `ThreadRelationships`, which already
/// derives the graph, the rows, the decay split and the row labels for the
/// lineage banner. Only the section's own framing lives here.
public enum ThreadDetailsLineageSection {
    /// "Lineage" only earns its name when something other than this thread's own
    /// subagents is listed; otherwise the section is exactly a list of subagents.
    public static func title(rows: [ThreadRelationshipRow]) -> String {
        rows.contains { $0.edge.kind != .subagent } ? "Lineage" : "Subagents"
    }

    /// An unavailable or deleted thread cannot be opened. An archived one can —
    /// it routes to the archive rather than the thread stack.
    public static func isDisabled(availability: String?) -> Bool {
        availability == "Unavailable" || availability == "Deleted"
    }

    public static func isArchived(availability: String?) -> Bool {
        availability == "Archived"
    }

    public static func doneGroupLabel(count: Int) -> String {
        "Done · \(count)"
    }

    public static func doneGroupAccessibilityLabel(count: Int) -> String {
        "\(count) finished \(count == 1 ? "subagent" : "subagents")"
    }
}

// MARK: - Automations

/// Scheduled tasks bound to this thread. Reads the automations settings
/// screen's `FeatureScheduledTask` so the two surfaces cannot show a task
/// differently, and so the sheet lights up the moment the scheduled-task RPCs
/// land behind `FeatureScheduledTaskManaging`.
public enum ThreadDetailsAutomationsSection {
    public static func boundTasks(
        _ tasks: [FeatureScheduledTask],
        threadID: String
    ) -> [FeatureScheduledTask] {
        tasks.filter { $0.threadID == threadID }
    }

    /// Hidden when nothing is bound — but a load error must not look like "no
    /// automations": tasks may exist whose controls would silently vanish.
    public static func isVisible(
        tasks: [FeatureScheduledTask],
        threadID: String,
        hasError: Bool
    ) -> Bool {
        hasError || !boundTasks(tasks, threadID: threadID).isEmpty
    }

    public static let loadErrorMessage = "Could not load automations."

    /// A run in flight outranks the next fire, and a bound thread's automation
    /// is worth naming by what it will do next.
    public static func subtitle(for task: FeatureScheduledTask, now: Date) -> String {
        ScheduledTaskLabels.subtitle(for: task.summary, now: now)
    }

    public static func statusTone(for task: FeatureScheduledTask) -> ScheduledTaskStatusTone {
        ScheduledTaskLabels.statusTone(task.lastRunStatus)
    }
}

// MARK: - Timestamps

enum ThreadDetailsTimestamp {
    /// Epoch milliseconds for a wire timestamp. The fractional form is what the
    /// server emits; the plain form covers records written before it stamped
    /// milliseconds.
    static func epochMilliseconds(_ value: OrchestrationV2Timestamp?) -> Int? {
        guard let value else { return nil }
        let date = threadDetailsFractionalFormatter.date(from: value)
            ?? threadDetailsPlainFormatter.date(from: value)
        guard let date else { return nil }
        return Int((date.timeIntervalSince1970 * 1000).rounded())
    }
}

private let threadDetailsFractionalFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private let threadDetailsPlainFormatter = ISO8601DateFormatter()

private extension String {
    /// `trimEnd` — the tail rule trims only the right-hand side, so a line's
    /// leading indentation survives into the row.
    func replacingTrailingWhitespace() -> String {
        var result = Substring(self)
        while let last = result.last, last.isWhitespace { result = result.dropLast() }
        return String(result)
    }
}
