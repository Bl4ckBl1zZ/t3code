import Foundation

enum NativePullRequestAction: String, CaseIterable, Identifiable {
    case merge, ready, draft, close, reopen, revert
    case approveWorkflows = "approve-workflows"
    case updateBranch = "update-branch"
    case enableAutoMerge = "enable-auto-merge"
    case disableAutoMerge = "disable-auto-merge"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .revert: "Create revert pull request"
        case .approveWorkflows: "Approve workflows to run"
        case .merge: "Merge pull request"
        case .ready: "Mark ready for review"
        case .draft: "Convert to draft"
        case .close: "Close pull request"
        case .reopen: "Reopen pull request"
        case .updateBranch: "Update branch"
        case .enableAutoMerge: "Enable auto-merge"
        case .disableAutoMerge: "Disable auto-merge"
        }
    }
    var needsReview: Bool { [.merge, .close, .updateBranch, .enableAutoMerge, .revert, .approveWorkflows].contains(self) }
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
}
