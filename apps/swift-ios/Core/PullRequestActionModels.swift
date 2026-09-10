import Foundation

public struct PullRequestActionRequest: Codable, Equatable, Sendable {
    public let action: String
    public let mergeMethod: String?
    public let updateMethod: String?
}
