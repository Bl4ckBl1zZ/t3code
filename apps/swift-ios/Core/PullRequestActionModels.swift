import Foundation

public struct PullRequestActionRequest: Codable, Equatable, Sendable {
    public let action: String
    public let mergeMethod: String?
    public let updateMethod: String?
}

/// Optional host identity belongs inside each PR reference, never its outer RPC envelope.
enum PullRequestWireReference {
    static func withHost(_ host: String?, _ fields: [String: JSONValue]) -> [String: JSONValue] {
        guard let host else { return fields }
        var result = fields
        result["host"] = .string(host.lowercased())
        return result
    }
}
