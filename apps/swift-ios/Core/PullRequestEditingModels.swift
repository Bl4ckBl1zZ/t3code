import Foundation

public struct NativePullRequestEditCapabilities: Codable, Equatable, Sendable {
    public let changeRequest: Bool
    public let comment: Bool
}

public struct PullRequestTextUpdate: Codable, Equatable, Sendable {
    public let title: String?
    public let body: String?
}
