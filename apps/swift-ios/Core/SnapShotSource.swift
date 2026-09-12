import Foundation

/// Desktop window context travels with an image through the V2 message projection.
public struct SnapShotSource: Codable, Equatable, Hashable, Sendable {
    public let kind: String
    public let capturedAt: String
    public let appName: String
    public let windowTitle: String
    public let accessibleText: String?
    public let accessibility: Accessibility?
    public let appIdentifier: String?
    public let appIconDataUrl: String?

    public struct Accessibility: Codable, Equatable, Hashable, Sendable {
        public let format: String
        public let text: String?
        public let truncated: Bool
        public let coordinateSpace: String?
        public let imageSize: ImageSize?
        public let root: Node?
    }
    public struct ImageSize: Codable, Equatable, Hashable, Sendable {
        public let width: Int
        public let height: Int
    }
    public struct Bounds: Codable, Equatable, Hashable, Sendable {
        public let x: Int
        public let y: Int
        public let width: Int
        public let height: Int
    }
    public struct Node: Codable, Equatable, Hashable, Sendable {
        public let role: String
        public let name: String?
        public let value: String?
        public let description: String?
        public let bounds: Bounds?
        public let state: State?
        public let actions: [String]?
        public let children: [Node]
    }
    public struct State: Codable, Equatable, Hashable, Sendable {
        public let active: Bool?
        public let busy: Bool?
        public let checked: String?
        public let editable: Bool?
        public let enabled: Bool?
        public let expanded: Bool?
        public let focused: Bool?
        public let selected: Bool?
        public let visible: Bool?
    }

    public var appIconData: Data? {
        guard let value = appIconDataUrl, value.hasPrefix("data:image/png;base64,"), value.count <= 100_000 else { return nil }
        return Data(base64Encoded: String(value.dropFirst("data:image/png;base64,".count)))
    }

    public var accessibilityDetails: String? {
        if let accessibility, accessibility.format == "element-tree" {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            return (try? encoder.encode(accessibility)).flatMap { String(data: $0, encoding: .utf8) }
        }
        let text = (accessibility?.text ?? accessibleText)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return text?.isEmpty == false ? text : nil
    }
}
