import Foundation

public struct PullRequestReaction: Codable, Equatable, Sendable, Identifiable {
    public let content: String
    public var count: Int
    public let actors: [String]
    public var viewerHasReacted: Bool
    public var id: String { content }
}

public struct PullRequestReactionRequest: Codable, Equatable, Sendable {
    public let subjectId: String?
    public let content: String
    public let reacted: Bool
}
