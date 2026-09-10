import Foundation

public struct NativePullRequestReviewCapabilities: Codable, Equatable, Sendable {
    public let inlineComment: Bool
    public let reply: Bool
    public let resolve: Bool
    public let verdicts: [String]
}

public struct PullRequestReviewPosition: Codable, Equatable, Sendable {
    public let kind: String
    public let oldLine: Int?
    public let newLine: Int?
    public let side: String?
}

public struct PullRequestReviewCommentDraft: Codable, Equatable, Sendable {
    public let path: String
    public let oldPath: String?
    public let position: PullRequestReviewPosition
    public let body: String
}

public struct PullRequestReviewSubmission: Codable, Equatable, Sendable {
    public let verdict: String
    public let body: String
    public let comments: [PullRequestReviewCommentDraft]
}
