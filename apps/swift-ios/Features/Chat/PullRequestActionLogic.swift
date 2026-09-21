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
