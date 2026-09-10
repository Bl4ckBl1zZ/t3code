import Foundation

public struct PullRequestListFilters: Codable, Equatable, Sendable {
    public var draft: String?
    public var review: String?
    public var checks: String?
    public var labels: [[String]]?
    public var excludedLabels: [String]?
    public var author: String?
}

public struct PullRequestListInput: Codable, Equatable, Sendable {
    public var state = "open"
    public var involvement = "all"
    public var filters: PullRequestListFilters?
    public var projectId: String?
    public var projectIds: [String]?
    public var host: String?
    public var limit = 50
    public var cursors: [String: String]?
    public var query: String?
}

public struct PullRequestListEntry: Codable, Equatable, Sendable, Identifiable {
    public let provider: String
    public let host: String
    public let projectId: String
    public let projectTitle: String
    public let repository: String
    public let number: Int
    public let title: String
    public let url: String
    public let author: PullRequestActor?
    public let headBranch: String
    public let baseBranch: String
    public let state: PullRequestState
    public let isDraft: Bool
    public let mergeability: PullRequestMergeability
    public var additions: Int
    public var deletions: Int
    public let createdAt: String
    public let updatedAt: String
    public let viewerReviewRequested: Bool
    public let labels: [PullRequestLabel]
    public let reviewDecision: String?
    public let checksState: String?
    /// The host is part of identity: Enterprise and public repositories may
    /// have the same owner/name and change-request number.
    public var id: String { "\(host.lowercased())|\(repository.lowercased())|\(number)" }
}

public struct PullRequestProviderSummary: Codable, Equatable, Sendable {
    public let host: String
    public let kind: String
    public let searchesOnHost: Bool
    public let projectCount: Int
    public let configured: Bool
    public let detail: String?
}

public struct PullRequestListProjectError: Codable, Equatable, Sendable {
    public let projectId: String
    public let projectTitle: String
    public let message: String
}

public struct PullRequestListResult: Codable, Equatable, Sendable {
    public let viewers: [String: String]
    public let providers: [PullRequestProviderSummary]
    public var entries: [PullRequestListEntry]
    public let errors: [PullRequestListProjectError]
    public let truncated: Bool
    public let nextCursors: [String: String]
}

public struct PullRequestDiffStat: Codable, Equatable, Sendable {
    public let projectId: String
    public let repository: String
    public let number: Int
    public let additions: Int
    public let deletions: Int
}
public struct PullRequestListStatsResult: Codable, Equatable, Sendable {
    public let stats: [PullRequestDiffStat]
}
