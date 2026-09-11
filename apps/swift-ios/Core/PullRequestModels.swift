import Foundation

// Pull-request detail and activity, as `packages/contracts/src/pullRequest.ts`
// reports them over the `pullRequests.detail` and `pullRequests.activity` WS
// RPCs. The detail sheet also decodes host capabilities and viewer permissions
// to gate reviewed stack actions. Unused response fields are skipped.
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
    public var reactions: [PullRequestReaction]? = nil
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
    public var reactions: [PullRequestReaction]? = nil
    public let id: String
    public let author: PullRequestActor?
    public var body: String
    public let createdAt: String
    public let url: String?
}

/// A host review conversation with its original diff coordinates. Outdated
/// conversations stay readable without being attached to a newer line.
public struct PullRequestReviewThread: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let path: String
    public let line: Int?
    public let side: String
    public let isResolved: Bool
    public let isOutdated: Bool
    /// Only the first page. The server reads ten per thread so a hundred
    /// threads cannot make GitHub reserve ten thousand nested rows.
    public let comments: [PullRequestThreadComment]
    /// What the host says the thread holds, when it answered in pages.
    public let commentCount: Int?
    /// Feeds `pullRequests.threadComments`. Absent once the thread is whole,
    /// so its presence is what says a page is missing.
    public let nextCommentsCursor: String?
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
    public var provider: String? = nil
    public var headRepositoryNameWithOwner: String? = nil
    public var mergeCapabilities: [String: Bool]? = nil
    public var baseComparison: String? = nil
    public var behindBy: Int? = nil
    public var autoMergeEnabled: Bool? = nil
    public var viewer: String? = nil
    public var capabilities: NativePullRequestCapabilities? = nil
    public var viewerPermissions: NativePullRequestViewerPermissions? = nil
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
    public var reactions: [PullRequestReaction]? = nil
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

public struct PullRequestStack: Codable, Equatable, Sendable {
    public let id: String
    public let number: Int
    public let url: String
    public let base: String
    public let layers: [Layer]

    public struct Layer: Codable, Equatable, Sendable, Identifiable {
        public var id: Int { number }
        public let number: Int
        public let title: String?
        public let isDraft: Bool?
        public let headSha: String?
        public let headBranch: String
        public let state: PullRequestState
    }

    /// Only the reviewed open layers travel; the server revalidates each revision before writing.
    public func affectedLayers(number: Int, action: String) -> [Layer] {
        guard let index = layers.firstIndex(where: { $0.number == number }) else { return [] }
        return (action == "merge" ? Array(layers.prefix(index + 1)) : layers).filter { $0.state != .merged }
    }
}

public struct NativePullRequestCapabilities: Codable, Equatable, Sendable {
    public var reviewers: NativePullRequestReviewerCapabilities? = nil
    public var reactions: Bool? = nil
    public var comment: Bool? = nil
    public var edit: NativePullRequestEditCapabilities? = nil
    public var diff: Bool? = nil
    public var review: NativePullRequestReviewCapabilities? = nil
    public var labels: Bool? = nil
    public let actions: [String]
    public let mergeMethods: [String]
    public let updateMethods: [String]?
}

public struct NativePullRequestViewerPermissions: Codable, Equatable, Sendable {
    public var requestReviewers: Bool? = nil
    public var comment: Bool? = nil
    public var resolve: Bool? = nil
    public var verdicts: [String]? = nil
    public var labels: Bool? = nil
    public let stackRebase: Bool?
    public let actions: [String]
    public let updateMethods: [String]?
}

public struct PullRequestLabelCandidate: Codable, Equatable, Sendable, Identifiable {
    public let name: String
    public let color: String?
    public let description: String?
    public let isApplied: Bool
    public var id: String { name }
}

public struct PullRequestLabelCandidateList: Codable, Equatable, Sendable {
    public let candidates: [PullRequestLabelCandidate]
    public let truncated: Bool
}


/// Persisted V2 link metadata. Dismissed stack members remain on the wire so discovery
/// can respect an unlink across restarts; client lists exclude them.
public struct OrchestrationV2ThreadPullRequestLink: Codable, Equatable, Sendable {
    public let host: String
    public let repository: String
    public let number: Int
    public let projectId: String?
    public let url: String
    public let source: String
    public let linkedAt: String
    public let snapshot: OrchestrationV2ThreadPullRequestSnapshot?
    public let stack: OrchestrationV2ThreadPullRequestStack?

    public var isVisible: Bool { source != "stack-dismissed" }
}

public struct OrchestrationV2ThreadPullRequestSnapshot: Codable, Equatable, Sendable {
    public let state: PullRequestState
    public let title: String
    public let headBranch: String
    public let baseBranch: String
    public let isDraft: Bool
    public let updatedAt: String?
    public let syncedAt: String
    public let closedAt: String?
    public let mergedAt: String?
    public let author: PullRequestActor?
    public let additions: Int?
    public let deletions: Int?
    public let changedFiles: Int?
    public let reviewDecision: String?
    public let checksState: String?
    public let mergeability: PullRequestMergeability?
}

public struct OrchestrationV2ThreadPullRequestStack: Codable, Equatable, Sendable {
    public let kind: String
    public let id: String
    public let number: Int
    public let url: String
    public let base: String
    public let layers: [OrchestrationV2ThreadPullRequestStackLayer]
}

public struct OrchestrationV2ThreadPullRequestStackLayer: Codable, Equatable, Sendable {
    public let number: Int
    public let headBranch: String
    public let state: PullRequestState
}
