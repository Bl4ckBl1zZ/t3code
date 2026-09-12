import Foundation

/// Optional project metadata. Unknown future kinds remain decodable so the
/// client can use the automatic icon until it learns how to render them.
public struct ProjectIconOverride: Codable, Hashable, Sendable {
    public let kind: String
    public var name: String?
    public var color: String?
    public var emoji: String?

    public init(kind: String, name: String? = nil, color: String? = nil, emoji: String? = nil) {
        self.kind = kind
        self.name = name
        self.color = color
        self.emoji = emoji
    }
}
