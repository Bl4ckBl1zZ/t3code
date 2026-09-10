import Foundation

public struct PullRequestDiffResult: Codable, Equatable, Sendable {
    public let patch: String
    public let truncated: Bool
    public let nextCursor: String?
    public let omittedFileStats: [PullRequestOmittedFileStat]?
}

public struct PullRequestOmittedFileStat: Codable, Equatable, Sendable {
    public let path: String
    public let additions: Int
    public let deletions: Int
}
