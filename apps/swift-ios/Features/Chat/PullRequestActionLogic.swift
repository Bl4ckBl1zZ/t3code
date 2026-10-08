import Foundation

enum NativePullRequestAction: String, CaseIterable, Identifiable {
    case merge, ready, draft, close, reopen, revert
    case approveWorkflows = "approve-workflows"
    case updateBranch = "update-branch"
    case enableAutoMerge = "enable-auto-merge"
    case disableAutoMerge = "disable-auto-merge"
    var id: String { rawValue }
    /// The menu item and the confirmation sheet's title. An ellipsis marks the
    /// ones that ask before they act.
    var label: String {
        switch self {
        case .revert: "Create Revert PR…"
        case .approveWorkflows: "Approve Workflows…"
        case .merge: "Merge…"
        case .ready: "Mark Ready for Review"
        case .draft: "Convert to Draft"
        case .close: "Close Pull Request…"
        case .reopen: "Reopen Pull Request"
        case .updateBranch: "Update Branch…"
        case .enableAutoMerge: "Enable Auto-Merge…"
        case .disableAutoMerge: "Disable Auto-Merge"
        }
    }
    /// The one prominent button under the header, where this is that action.
    var primaryLabel: String {
        switch self {
        case .merge: "Merge"
        case .ready: "Ready for Review"
        case .reopen: "Reopen"
        default: label
        }
    }
    /// The sheet's confirm button.
    var confirmLabel: String {
        switch self {
        case .merge: "Merge"
        case .revert: "Create"
        case .approveWorkflows: "Approve"
        case .updateBranch: "Update"
        case .enableAutoMerge: "Enable"
        default: primaryLabel
        }
    }
    var systemImage: String {
        switch self {
        case .merge: "arrow.triangle.merge"
        case .ready: "eye"
        case .draft: "pencil.circle"
        case .close: "xmark.circle"
        case .reopen: "arrow.uturn.backward"
        case .revert: "arrow.uturn.backward.circle"
        case .approveWorkflows: "play.circle"
        case .updateBranch: "arrow.triangle.branch"
        case .enableAutoMerge: "clock.badge.checkmark"
        case .disableAutoMerge: "clock.badge.xmark"
        }
    }
    var failureTitle: String {
        switch self {
        case .merge: "Couldn't Merge"
        case .ready: "Couldn't Mark Ready"
        case .draft: "Couldn't Convert to Draft"
        case .close: "Couldn't Close"
        case .reopen: "Couldn't Reopen"
        case .revert: "Couldn't Create Revert PR"
        case .approveWorkflows: "Couldn't Approve Workflows"
        case .updateBranch: "Couldn't Update Branch"
        case .enableAutoMerge: "Couldn't Enable Auto-Merge"
        case .disableAutoMerge: "Couldn't Disable Auto-Merge"
        }
    }
    /// Actions reviewed in a sheet before they run. Close asks in a dialog
    /// instead: it has nothing to choose, only something to confirm.
    var needsReview: Bool { [.merge, .updateBranch, .enableAutoMerge, .revert, .approveWorkflows].contains(self) }
    var explanation: String {
        switch self {
        case .revert: "Open a new pull request that reverses the merged changes. The original pull request stays merged."
        case .approveWorkflows: "Allow workflows from this fork pull request to run. Review its code and workflow changes before approving."
        case .merge: "Merge this pull request on the host. Your local checkout is unchanged."
        case .close: "Close without merging. You can reopen it if the host still permits it."
        case .updateBranch: "Bring the base branch into this PR’s branch on the host. Rebase rewrites the branch’s commits."
        case .enableAutoMerge: "The host merges as soon as its requirements are met. It may merge immediately if they are already met."
        default: label
        }
    }
}

/// The one verb under a pull request's header: the next step its state calls
/// for, or none where there is no main next step (a merged request).
enum PullRequestPrimaryAction: Equatable {
    case action(NativePullRequestAction)
    /// Conflicts block every host action; the agent is what can clear them.
    case resolveConflicts
}

enum PullRequestActionLogic {
    static func mergeMethods(_ detail: PullRequestDetail) -> [String] {
        (detail.capabilities?.mergeMethods ?? []).filter { ["merge", "squash", "rebase"].contains($0) && detail.mergeCapabilities?[$0] == true }
    }
    /// The merge method a merge starts with: the one already chosen for this
    /// pull request, then the server's project or machine default, then the
    /// method last used on this device, each only if the repository allows it,
    /// and otherwise the first it does.
    static func resolveMergeMethod(allowed: [String], current: String?, projectDefault: String?, lastUsed: String?) -> String? {
        [current, projectDefault, lastUsed].compactMap { $0 }.first { allowed.contains($0) } ?? allowed.first
    }

    /// The one-tap actions a list row offers: the next step for its state and a
    /// way to close it. GitHub only, where the row's state is enough to know
    /// what the host offers; nothing on a merged pull request.
    static func quickActions(_ entry: PullRequestListEntry) -> [NativePullRequestAction] {
        quickActions(isGitHub: entry.provider == "github", state: entry.state, isDraft: entry.isDraft)
    }

    /// The same for a thread's linked pull request, read from the snapshot the
    /// server keeps on the link: nothing until a snapshot says its state, and
    /// no merge on a layer of a known stack, which merges through its stack.
    static func quickActions(_ link: FeatureLinkedPullRequest) -> [NativePullRequestAction] {
        guard let snapshot = link.snapshot, let state = PullRequestState(rawValue: snapshot.state) else { return [] }
        let host = (link.host ?? URL(string: link.url)?.host ?? "").lowercased()
        // `isGitHubHost` from packages/shared/src/sourceControl.ts: Enterprise
        // hosts carry a "github" label.
        let isGitHub = host == "github.com" || host.split(separator: ".").contains("github")
        let actions = quickActions(isGitHub: isGitHub, state: state, isDraft: snapshot.isDraft)
        return link.stack != nil || link.source == "stack" ? actions.filter { $0 != .merge } : actions
    }

    private static func quickActions(isGitHub: Bool, state: PullRequestState, isDraft: Bool) -> [NativePullRequestAction] {
        guard isGitHub, state != .merged else { return [] }
        if state == .closed { return [.reopen] }
        return isDraft ? [.ready, .close] : [.merge, .close]
    }

    /// What a pull request is once the host accepts an action: its new state,
    /// and its draft flag where the action sets one (nil keeps it). Nil for
    /// actions that change neither.
    static func outcome(of action: NativePullRequestAction, state: PullRequestState) -> (state: PullRequestState, isDraft: Bool?)? {
        switch action {
        case .close: (.closed, nil)
        case .reopen: (.open, nil)
        case .merge: (.merged, nil)
        case .draft: (state, true)
        case .ready: (state, false)
        default: nil
        }
    }

    static let stackedQuickMergeRefusal = "Open this pull request to merge its stack."

    /// Why a row's quick merge will not run, read from the detail at the tap:
    /// the row alone cannot tell whether this viewer may merge or how.
    static func quickMergeRefusal(_ detail: PullRequestDetail) -> String? {
        if offered(detail).contains(.merge) { return nil }
        if detail.state == .open, !detail.isDraft, mergeMethods(detail).isEmpty,
           detail.capabilities?.actions.contains("merge") == true {
            return "No merge method is available for this repository."
        }
        return "This pull request cannot be merged."
    }

    static func updateMethods(_ detail: PullRequestDetail) -> [String] {
        (detail.capabilities?.updateMethods ?? []).filter { ["merge", "rebase"].contains($0) && detail.viewerPermissions?.updateMethods?.contains($0) == true }
    }
    static func offered(_ detail: PullRequestDetail) -> [NativePullRequestAction] {
        NativePullRequestAction.allCases.filter { action in
            guard detail.capabilities?.actions.contains(action.rawValue) == true,
                  detail.viewerPermissions?.actions.contains(action.rawValue) == true else { return false }
            if detail.state == .merged { return action == .revert }
            if detail.state == .closed { return action == .reopen }
            guard detail.state == .open else { return false }
            switch action {
            case .revert: return false
            case .approveWorkflows: return (detail.workflowApprovalsRequired ?? 0) > 0
            case .merge: return !detail.isDraft && detail.mergeability != .conflicting && !mergeMethods(detail).isEmpty
            case .ready: return detail.isDraft
            case .draft: return !detail.isDraft
            case .close: return true
            case .reopen: return false
            case .updateBranch: return detail.baseComparison == "behind" && detail.mergeability == .mergeable && !updateMethods(detail).isEmpty
            case .enableAutoMerge: return detail.autoMergeEnabled == false && !detail.isDraft && detail.mergeability != .conflicting && !mergeMethods(detail).isEmpty
            case .disableAutoMerge: return detail.autoMergeEnabled == true
            }
        }
    }

    /// Conflicts first, because nothing else can land until they are gone;
    /// then the state's own next step. `canResolveInAgent` is whether this
    /// screen can hand the request to an agent at all.
    static func primary(_ detail: PullRequestDetail, canResolveInAgent: Bool) -> PullRequestPrimaryAction? {
        if detail.state == .open, detail.mergeability == .conflicting {
            return canResolveInAgent ? .resolveConflicts : nil
        }
        let offered = offered(detail)
        for action in [NativePullRequestAction.ready, .merge, .reopen] where offered.contains(action) {
            return .action(action)
        }
        return nil
    }

    /// Everything the menu offers besides the primary, destructive last.
    static func menuActions(_ detail: PullRequestDetail, primary: PullRequestPrimaryAction?) -> [NativePullRequestAction] {
        let rest = offered(detail).filter { primary != .action($0) }
        return rest.filter { $0 != .close } + rest.filter { $0 == .close }
    }

    /// The host's own wording for a merge or update method.
    static func methodLabel(_ method: String) -> String {
        switch method {
        case "squash": "Squash and Merge"
        case "merge": "Create a Merge Commit"
        case "rebase": "Rebase and Merge"
        default: method.capitalized
        }
    }

    static func updateMethodLabel(_ method: String) -> String {
        switch method {
        case "merge": "Merge Base Branch"
        case "rebase": "Rebase on Base Branch"
        default: method.capitalized
        }
    }
}

/// What a quick action just did to a thread's linked pull request, shown on its
/// row until the server's next read of the request lands on the thread.
struct LinkedPullRequestOverlay: Equatable {
    let state: PullRequestState
    let isDraft: Bool
    /// The thread's snapshot of the request when the action ran. Any other
    /// snapshot is a newer read, and the server's word wins from then on.
    let basis: FeaturePullRequestSnapshot
}

enum LinkedPullRequestOverlays {
    /// Per thread and per link: a request linked again starts without one.
    static func key(threadID: String, link: FeatureLinkedPullRequest) -> String {
        "\(threadID)|\(link.identity)|\(link.linkedAt ?? "")"
    }

    /// The overlay an accepted action leaves: the state the row showed, moved
    /// on by the action, over the thread's current snapshot.
    static func overlay(after action: NativePullRequestAction, shown: FeaturePullRequestSnapshot?,
                        basis: FeaturePullRequestSnapshot?) -> LinkedPullRequestOverlay? {
        guard let shown, let basis, let state = PullRequestState(rawValue: shown.state),
              let outcome = PullRequestActionLogic.outcome(of: action, state: state) else { return nil }
        return LinkedPullRequestOverlay(state: outcome.state, isDraft: outcome.isDraft ?? shown.isDraft, basis: basis)
    }

    /// Only while the thread still reports the snapshot it was written over,
    /// and that snapshot does not already say the same.
    static func holds(_ overlay: LinkedPullRequestOverlay, over snapshot: FeaturePullRequestSnapshot?) -> Bool {
        guard let snapshot, snapshot == overlay.basis else { return false }
        return snapshot.state != overlay.state.rawValue || snapshot.isDraft != overlay.isDraft
    }

    /// The link as its row shows it, and the state its actions start from.
    static func shown(_ link: FeatureLinkedPullRequest, overlay: LinkedPullRequestOverlay?) -> FeatureLinkedPullRequest {
        guard let overlay, holds(overlay, over: link.snapshot) else { return link }
        var shown = link
        shown.snapshot?.state = overlay.state.rawValue
        shown.snapshot?.isDraft = overlay.isDraft
        return shown
    }

    /// Keeps the overlays that still hold for a link the thread has: one whose
    /// link was unlinked, or whose request the server has read again, goes.
    static func reconcile(_ overlays: [String: LinkedPullRequestOverlay], threadID: String,
                          links: [FeatureLinkedPullRequest]) -> [String: LinkedPullRequestOverlay] {
        guard !overlays.isEmpty else { return overlays }
        let byKey = Dictionary(links.map { (key(threadID: threadID, link: $0), $0) }, uniquingKeysWith: { first, _ in first })
        return overlays.filter { key, overlay in byKey[key].map { holds(overlay, over: $0.snapshot) } ?? false }
    }
}

/// The merge method last chosen on this device, which a merge falls back to
/// when the server sets no default for the project or machine.
enum PullRequestMergeMethodMemory {
    private static let key = "swift-ios.pullRequests.lastMergeMethod"

    static func lastUsed(_ defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: key)
    }

    static func remember(_ method: String, _ defaults: UserDefaults = .standard) {
        guard ["merge", "squash", "rebase"].contains(method) else { return }
        defaults.set(method, forKey: key)
    }
}
