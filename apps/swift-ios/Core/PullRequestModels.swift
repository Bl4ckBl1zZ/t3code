import Foundation

// Pull-request detail and activity, as `packages/contracts/src/pullRequest.ts`
// reports them over the `pullRequests.detail` and `pullRequests.activity` WS
// RPCs. Only the fields the read-only sheet renders are modelled; the
// capability, permission and merge-method blocks the actions UI would need are
// left undeclared, which `JSONDecoder` simply skips.
//
// Dates stay ISO strings, matching how the other Core models carry
// `IsoDateTime`.

public struct PullRequestActor: Codable, Equatable, Sendable {
    public let login: String
    public let name: String?
    /// Nil where a host does not report one, which is what initials fall back to.
    public let avatarUrl: String?
}

public struct PullRequestLabel: Codable, Equatable, Sendable {
    public let name: String
    public let color: String?
}

public enum PullRequestCheckStatus: String, Codable, Sendable {
    case pending
    case success
    case failure
    case skipped
    case neutral
    case cancelled
}

public struct PullRequestCheck: Codable, Equatable, Sendable {
    public let name: String
    public let status: PullRequestCheckStatus
    public let description: String?
    public let url: String?
}

public enum PullRequestCommentKind: String, Codable, Sendable {
    case issueComment = "issue-comment"
    case reviewComment = "review-comment"
    case review
}

public struct PullRequestComment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: PullRequestCommentKind
    public let author: PullRequestActor?
    public let body: String
    public let createdAt: String
    public let url: String?
    public let path: String?
    public let reviewState: String?
}

public struct PullRequestCommit: Codable, Equatable, Sendable {
    public let oid: String
    public let messageHeadline: String
    public let committedDate: String
    public let additions: Int?
    public let deletions: Int?
    public let authors: [PullRequestActor]?
}

public struct PullRequestThreadComment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let author: PullRequestActor?
    public let body: String
    public let createdAt: String
    public let url: String?
}

/// A conversation anchored to a line of the diff. The sheet has no diff to pin
/// these to, so only what the timeline could ever show is carried; `side` stays
/// the wire string rather than an enum this client makes nothing of.
public struct PullRequestReviewThread: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let path: String
    public let line: Int?
    public let side: String
    public let isResolved: Bool
    public let isOutdated: Bool
    public let comments: [PullRequestThreadComment]
}

public enum PullRequestState: String, Codable, Sendable {
    case open
    case closed
    case merged
}

public enum PullRequestMergeability: String, Codable, Sendable {
    case mergeable
    case conflicting
    case unknown
}

public struct PullRequestDetail: Codable, Equatable, Sendable {
    public let projectId: String
    public let projectTitle: String
    public let repository: String
    public let number: Int
    public let title: String
    public let body: String
    public let url: String
    public let author: PullRequestActor?
    public let state: PullRequestState
    public let isDraft: Bool
    public let mergeability: PullRequestMergeability
    public let additions: Int
    public let deletions: Int
    public let changedFiles: Int
    public let headBranch: String
    public let baseBranch: String
    public let createdAt: String
    public let updatedAt: String
    public let mergedAt: String?
    public let closedAt: String?
    public let reviewers: [PullRequestActor]
    public let labels: [PullRequestLabel]
    public let checks: [PullRequestCheck]
}

/// The slower, conversation-shaped half of a change request, read separately so
/// a deeply paginated review history cannot hold the summary off screen.
public struct PullRequestActivity: Codable, Equatable, Sendable {
    /// Optional enrichments: GitHub's conversation query carries avatars and
    /// completed reviewers that its basic detail does not.
    public let author: PullRequestActor?
    public let reviewers: [PullRequestActor]?
    public let comments: [PullRequestComment]
    /// How many remarks the host itself counts; never less than `comments` holds.
    public let commentCount: Int
    /// The read stopped at a bound of its own before the host ran out.
    public let commentsTruncated: Bool
    public let reviewThreads: [PullRequestReviewThread]
    public let commits: [PullRequestCommit]
}
