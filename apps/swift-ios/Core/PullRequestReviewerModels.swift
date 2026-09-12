import Foundation

public struct NativePullRequestReviewerCapabilities: Codable, Equatable, Sendable {
    public let request: Bool
    public let listCandidates: Bool
}

public struct PullRequestReviewerCandidate: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let login: String
    public let name: String?
    public let avatarUrl: String?
    public var isRequested: Bool
    public var key: String { "\(kind):\(id)" }
}

public struct PullRequestReviewerCandidateList: Codable, Equatable, Sendable {
    public let candidates: [PullRequestReviewerCandidate]
    public let truncated: Bool
}

public struct PullRequestReviewerRequest: Codable, Equatable, Sendable {
    public struct Reviewer: Codable, Equatable, Sendable {
        public let id: String
        public let kind: String
    }
    public let reviewers: [Reviewer]
    public let requested: Bool
}
