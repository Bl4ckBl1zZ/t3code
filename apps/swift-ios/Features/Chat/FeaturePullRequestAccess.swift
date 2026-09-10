import Foundation

struct FeaturePullRequestProjectScope: Equatable, Sendable {
    let projectID: String
    let host: String
    let repository: String
    var canonicalKey: String { "\(host)/\(repository)".lowercased() }
}

@MainActor
protocol FeatureProjectPullRequestManaging: AnyObject, Sendable {
    func listPullRequests(environmentID: String, input: PullRequestListInput) async throws -> PullRequestListResult
    func pullRequestStats(environmentID: String, entries: [PullRequestListEntry]) async throws -> PullRequestListStatsResult
    func projectPullRequestOverview(scope: FeaturePullRequestProjectScope, number: Int) async throws -> FeaturePullRequestOverview
    func projectPullRequestLabels(scope: FeaturePullRequestProjectScope, number: Int) async throws -> PullRequestLabelCandidateList
    func setProjectPullRequestLabels(scope: FeaturePullRequestProjectScope, number: Int, labels: [String], applied: Bool) async throws
    func projectPullRequestStack(scope: FeaturePullRequestProjectScope, number: Int) async throws -> PullRequestStack?
    func runProjectPullRequestStackAction(scope: FeaturePullRequestProjectScope, number: Int, stack: PullRequestStack, action: String, mergeMethod: String?) async throws
}

/// The same detail, label and reviewed-stack screens work from a thread or a
/// project. A workspace browse never creates a dummy thread just to read a PR.
@MainActor
struct FeaturePullRequestAccess {
    let diff: ((Int, String?, String?) async throws -> PullRequestDiffResult)?
    let overview: (Int) async throws -> FeaturePullRequestOverview
    let labels: (Int) async throws -> PullRequestLabelCandidateList
    let setLabels: (Int, [String], Bool) async throws -> Void
    let stack: (Int) async throws -> PullRequestStack?
    let runStackAction: (Int, PullRequestStack, String, String?) async throws -> Void

    init(client: any FeatureClient, threadID: String) {
        if let reader = client as? any FeaturePullRequestCodeReading {
            diff = { try await reader.pullRequestDiff(scope: .thread(threadID), number: $0, cursor: $1, commit: $2) }
        } else { diff = nil }
        overview = { try await client.pullRequestOverview(threadID: threadID, number: $0) }
        labels = { try await client.pullRequestLabelCandidates(threadID: threadID, number: $0) }
        setLabels = { try await client.setPullRequestLabels(threadID: threadID, number: $0, labels: $1, applied: $2) }
        stack = { try await client.pullRequestStack(threadID: threadID, number: $0) }
        runStackAction = { try await client.runPullRequestStackAction(threadID: threadID, number: $0, stack: $1, action: $2, mergeMethod: $3) }
    }

    init(manager: any FeatureProjectPullRequestManaging, scope: FeaturePullRequestProjectScope) {
        if let reader = manager as? any FeaturePullRequestCodeReading {
            diff = { try await reader.pullRequestDiff(scope: .project(scope), number: $0, cursor: $1, commit: $2) }
        } else { diff = nil }
        overview = { try await manager.projectPullRequestOverview(scope: scope, number: $0) }
        labels = { try await manager.projectPullRequestLabels(scope: scope, number: $0) }
        setLabels = { try await manager.setProjectPullRequestLabels(scope: scope, number: $0, labels: $1, applied: $2) }
        stack = { try await manager.projectPullRequestStack(scope: scope, number: $0) }
        runStackAction = { try await manager.runProjectPullRequestStackAction(scope: scope, number: $0, stack: $1, action: $2, mergeMethod: $3) }
    }
}

/// A host-backed diff is addressed through its project, never the local working tree.
enum FeaturePullRequestScope: Sendable {
    case thread(String)
    case project(FeaturePullRequestProjectScope)
}

@MainActor
protocol FeaturePullRequestCodeReading: AnyObject, Sendable {
    func pullRequestDiff(scope: FeaturePullRequestScope, number: Int, cursor: String?, commit: String?) async throws -> PullRequestDiffResult
}
