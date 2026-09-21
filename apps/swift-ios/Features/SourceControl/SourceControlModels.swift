import Foundation

/// Where a running source-control action is, folded from the server's
/// `git.runStackedAction` progress events.
///
/// Mirrors the web client's reducer (packages/client-runtime/src/state/vcsAction.ts):
/// a phase names the step, a hook running inside that phase stands in for it
/// until the hook finishes, and hook output lines are not shown.
public struct FeatureSourceControlProgress: Sendable, Equatable {
    /// The phases the server announced up front, e.g. `["commit", "push"]`.
    public var phases: [String] = []
    public var phase: String?
    public var phaseLabel: String?
    public var hookName: String?

    public init() {}

    /// Folds one event in and reports whether anything the row shows changed.
    @discardableResult
    public mutating func apply(
        kind: String,
        phases: [String]? = nil,
        phase: String? = nil,
        label: String? = nil,
        hookName: String? = nil
    ) -> Bool {
        let before = self
        switch kind {
        case "action_started":
            self.phases = phases ?? []
        case "phase_started":
            self.phase = phase
            phaseLabel = label
            self.hookName = nil
        case "hook_started":
            self.hookName = hookName
        case "hook_finished":
            self.hookName = nil
        default:
            break
        }
        return self != before
    }

    /// The line under the running action: "Pushing… (2 of 2)".
    public var stepText: String? {
        let text: String
        if let hookName {
            text = "Running \(hookName)…"
        } else if let phaseLabel {
            text = phaseLabel.hasSuffix("...") ? String(phaseLabel.dropLast(3)) + "…" : phaseLabel
        } else {
            return nil
        }
        guard phases.count > 1, let phase, let index = phases.firstIndex(of: phase) else {
            return text
        }
        return "\(text) (\(index + 1) of \(phases.count))"
    }
}

/// A source-control action that failed, kept on screen until it is dismissed
/// or the next action succeeds.
struct SourceControlFailure: Equatable {
    let action: FeatureSourceControlAction
    let message: String

    var title: String {
        "Couldn't \(action.verb)"
    }

    /// The one follow-up that usually fixes this failure, when there is one.
    /// A push the remote rejected because it moved on is fixed by pulling first.
    var nextStep: FeatureSourceControlAction? {
        guard action.publishes else { return nil }
        let text = message.lowercased()
        let remoteMovedOn = ["rejected", "non-fast-forward", "fetch first", "behind its remote"]
            .contains { text.contains($0) }
        return remoteMovedOn ? .pull : nil
    }
}

extension FeatureSourceControlAction {
    /// The stacked git action this runs on the server. Pull has its own
    /// endpoint and publishes nothing.
    var stackedAction: GitStackedAction? {
        switch self {
        case .commit: .commit
        case .push: .push
        case .pull: nil
        case .createPullRequest: .createPullRequest
        case .commitAndPush: .commitAndPush
        case .commitPushAndCreatePullRequest: .commitPushAndPullRequest
        }
    }

    /// Whether running this on the default branch asks first, by the same rule
    /// the Thread Details quick action uses.
    func requiresDefaultBranchConfirmation(isDefaultBranch: Bool) -> Bool {
        guard let stackedAction else { return false }
        return ThreadDetailsGit.requiresDefaultBranchConfirmation(
            stackedAction,
            isDefaultBranch: isDefaultBranch
        )
    }

    /// Whether the action sends commits to the remote.
    var publishes: Bool {
        switch self {
        case .push, .createPullRequest, .commitAndPush, .commitPushAndCreatePullRequest: true
        case .commit, .pull: false
        }
    }

    /// Commit actions ask for a message in a sheet before they run.
    var requiresMessage: Bool {
        switch self {
        case .commit, .commitAndPush, .commitPushAndCreatePullRequest: true
        case .push, .pull, .createPullRequest: false
        }
    }

    /// The action named as a verb, for "Couldn't …" and the commit sheet.
    var verb: String {
        switch self {
        case .commit: "Commit"
        case .push: "Push"
        case .pull: "Pull"
        case .createPullRequest: "Create Pull Request"
        case .commitAndPush: "Commit & Push"
        case .commitPushAndCreatePullRequest: "Commit, Push & Create PR"
        }
    }
}

/// Copy for the Source Control screen's branch row and subtitle.
enum SourceControlBranchSummary {
    /// Under the branch name: what "ahead" and "behind" mean for this branch.
    static func detail(_ status: FeatureSourceControlStatus) -> String {
        guard status.branch != nil else { return "New commits here aren't on any branch." }
        guard status.hasPrimaryRemote else { return "No remote" }
        guard status.hasUpstream else {
            return status.aheadCount > 0
                ? "Not published · \(commits(status.aheadCount)) not on the remote"
                : "Not published"
        }
        var parts: [String] = []
        if status.aheadCount > 0 { parts.append("\(commits(status.aheadCount)) to push") }
        if status.behindCount > 0 { parts.append("\(commits(status.behindCount)) to pull") }
        return "Published · " + (parts.isEmpty ? "up to date" : parts.joined(separator: ", "))
    }

    /// The navigation subtitle: the branch, then its most useful fact.
    static func subtitle(_ status: FeatureSourceControlStatus, step: String?) -> String {
        let branch = status.branch ?? "Detached HEAD"
        if let step { return "\(branch) · \(step)" }
        if status.hasConflicts { return "\(branch) · Conflicts" }
        if status.isDefaultRef { return "\(branch) · default branch" }
        if status.branch != nil, status.hasPrimaryRemote, !status.hasUpstream {
            return "\(branch) · Not published"
        }
        if status.aheadCount > 0 { return "\(branch) · \(status.aheadCount) to push" }
        if status.behindCount > 0 { return "\(branch) · \(status.behindCount) to pull" }
        return branch
    }

    static func commits(_ count: Int) -> String {
        count == 1 ? "1 commit" : "\(count) commits"
    }
}
