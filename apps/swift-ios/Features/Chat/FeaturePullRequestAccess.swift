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
    let editing: ((Int, String) -> FeaturePullRequestEditingAccess)?
    let invalidate: ((Int) async throws -> Void)?
    let runAction: ((Int, String, PullRequestActionRequest) async throws -> Void)?
    let threads: ((Int, String) -> FeaturePullRequestThreadAccess)?
    let draftKey: String
    let submitReview: ((Int, String, PullRequestReviewSubmission) async throws -> Void)?
    let fileContents: ((Int, String, PullRequestDiffFileInput) async throws -> PullRequestDiffFileContents)?
    let diff: ((Int, String?, String?) async throws -> PullRequestDiffResult)?
    let overview: (Int) async throws -> FeaturePullRequestOverview
    let labels: (Int) async throws -> PullRequestLabelCandidateList
    let setLabels: (Int, [String], Bool) async throws -> Void
    let stack: (Int) async throws -> PullRequestStack?
    let runStackAction: (Int, PullRequestStack, String, String?) async throws -> Void

    init(client: any FeatureClient, threadID: String) {
        if let cache = client as? any FeaturePullRequestCacheInvalidating {
            invalidate = { try await cache.invalidatePullRequest(scope: .thread(threadID), number: $0) }
        } else { invalidate = nil }
        draftKey = "thread:\(threadID)"
        if let reviewer = client as? any FeaturePullRequestReviewWriting {
            editing = { FeaturePullRequestEditingAccess(writer: reviewer, scope: .thread(threadID), number: $0, expectedURL: $1) }
            runAction = { try await reviewer.runPullRequestAction(scope: .thread(threadID), number: $0, expectedURL: $1, request: $2) }
            threads = { FeaturePullRequestThreadAccess(writer: reviewer, scope: .thread(threadID), number: $0, expectedURL: $1) }
            submitReview = { try await reviewer.submitPullRequestReview(scope: .thread(threadID), number: $0, expectedURL: $1, submission: $2) }
        } else { submitReview = nil; threads = nil; runAction = nil; editing = nil }
        if let reader = client as? any FeaturePullRequestCodeReading {
            fileContents = { try await reader.pullRequestFileContents(scope: .thread(threadID), number: $0, expectedURL: $1, input: $2) }
            diff = { try await reader.pullRequestDiff(scope: .thread(threadID), number: $0, cursor: $1, commit: $2) }
        } else { diff = nil; fileContents = nil }
        overview = { try await client.pullRequestOverview(threadID: threadID, number: $0) }
        labels = { try await client.pullRequestLabelCandidates(threadID: threadID, number: $0) }
        setLabels = { try await client.setPullRequestLabels(threadID: threadID, number: $0, labels: $1, applied: $2) }
        stack = { try await client.pullRequestStack(threadID: threadID, number: $0) }
        runStackAction = { try await client.runPullRequestStackAction(threadID: threadID, number: $0, stack: $1, action: $2, mergeMethod: $3) }
    }

    init(manager: any FeatureProjectPullRequestManaging, scope: FeaturePullRequestProjectScope) {
        if let cache = manager as? any FeaturePullRequestCacheInvalidating {
            invalidate = { try await cache.invalidatePullRequest(scope: .project(scope), number: $0) }
        } else { invalidate = nil }
        draftKey = "project:\(scope.projectID):\(scope.canonicalKey)"
        if let reviewer = manager as? any FeaturePullRequestReviewWriting {
            editing = { FeaturePullRequestEditingAccess(writer: reviewer, scope: .project(scope), number: $0, expectedURL: $1) }
            runAction = { try await reviewer.runPullRequestAction(scope: .project(scope), number: $0, expectedURL: $1, request: $2) }
            threads = { FeaturePullRequestThreadAccess(writer: reviewer, scope: .project(scope), number: $0, expectedURL: $1) }
            submitReview = { try await reviewer.submitPullRequestReview(scope: .project(scope), number: $0, expectedURL: $1, submission: $2) }
        } else { submitReview = nil; threads = nil; runAction = nil; editing = nil }
        if let reader = manager as? any FeaturePullRequestCodeReading {
            fileContents = { try await reader.pullRequestFileContents(scope: .project(scope), number: $0, expectedURL: $1, input: $2) }
            diff = { try await reader.pullRequestDiff(scope: .project(scope), number: $0, cursor: $1, commit: $2) }
        } else { diff = nil; fileContents = nil }
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
    func pullRequestFileContents(scope: FeaturePullRequestScope, number: Int, expectedURL: String, input: PullRequestDiffFileInput) async throws -> PullRequestDiffFileContents
    func pullRequestDiff(scope: FeaturePullRequestScope, number: Int, cursor: String?, commit: String?) async throws -> PullRequestDiffResult
}

@MainActor
protocol FeaturePullRequestReviewWriting: AnyObject, Sendable {
    func updatePullRequestText(scope: FeaturePullRequestScope, number: Int, expectedURL: String, update: PullRequestTextUpdate) async throws
    func updatePullRequestComment(scope: FeaturePullRequestScope, number: Int, expectedURL: String, commentID: String, kind: String, body: String) async throws
    func commentOnPullRequest(scope: FeaturePullRequestScope, number: Int, expectedURL: String, body: String) async throws
    func runPullRequestAction(scope: FeaturePullRequestScope, number: Int, expectedURL: String, request: PullRequestActionRequest) async throws
    func pullRequestThreadComments(scope: FeaturePullRequestScope, number: Int, threadID: String, cursor: String) async throws -> PullRequestThreadCommentsResult
    func replyToPullRequestThread(scope: FeaturePullRequestScope, number: Int, expectedURL: String, threadID: String, body: String) async throws
    func setPullRequestThreadResolution(scope: FeaturePullRequestScope, number: Int, expectedURL: String, threadID: String, resolved: Bool) async throws
    func submitPullRequestReview(scope: FeaturePullRequestScope, number: Int, expectedURL: String, submission: PullRequestReviewSubmission) async throws
}

@MainActor
struct FeaturePullRequestThreadAccess {
    let loadMore: (String, String) async throws -> PullRequestThreadCommentsResult
    let reply: (String, String) async throws -> Void
    let resolve: (String, Bool) async throws -> Void
    init(writer: any FeaturePullRequestReviewWriting, scope: FeaturePullRequestScope, number: Int, expectedURL: String) {
        loadMore = { try await writer.pullRequestThreadComments(scope: scope, number: number, threadID: $0, cursor: $1) }
        reply = { try await writer.replyToPullRequestThread(scope: scope, number: number, expectedURL: expectedURL, threadID: $0, body: $1) }
        resolve = { try await writer.setPullRequestThreadResolution(scope: scope, number: number, expectedURL: expectedURL, threadID: $0, resolved: $1) }
    }
}

@MainActor
protocol FeaturePullRequestCacheInvalidating: AnyObject, Sendable {
    func invalidatePullRequest(scope: FeaturePullRequestScope, number: Int) async throws
    func invalidatePullRequestListings(environmentID: String) async throws
}

@MainActor
struct FeaturePullRequestEditingAccess {
    let update: (PullRequestTextUpdate) async throws -> Void
    let updateComment: (String, String, String) async throws -> Void
    let comment: (String) async throws -> Void
    init(update: @escaping (PullRequestTextUpdate) async throws -> Void,
         updateComment: @escaping (String, String, String) async throws -> Void,
         comment: @escaping (String) async throws -> Void) {
        self.update = update; self.updateComment = updateComment; self.comment = comment
    }
    init(writer: any FeaturePullRequestReviewWriting, scope: FeaturePullRequestScope, number: Int, expectedURL: String) {
        update = { try await writer.updatePullRequestText(scope: scope, number: number, expectedURL: expectedURL, update: $0) }
        updateComment = { try await writer.updatePullRequestComment(scope: scope, number: number, expectedURL: expectedURL, commentID: $0, kind: $1, body: $2) }
        comment = { try await writer.commentOnPullRequest(scope: scope, number: number, expectedURL: expectedURL, body: $0) }
    }
}
