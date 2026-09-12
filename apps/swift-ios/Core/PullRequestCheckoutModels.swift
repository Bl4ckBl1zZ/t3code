import Foundation

public enum PullRequestCheckoutMode: String, Codable, Sendable { case worktree, local }

public struct PullRequestCheckoutResult: Codable, Equatable, Sendable {
    public let branch: String
    public let worktreePath: String?
    public let isOnPullRequestHead: Bool?
}
