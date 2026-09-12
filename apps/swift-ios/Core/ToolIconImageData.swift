import Foundation

/// Inline logos share the same byte limit as fetched tool icons.
enum ToolIconImageData {
    static let maximumBytes = 256 * 1024
    static let mimeTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"]

    static func inline(_ raw: String) -> Data? {
        guard raw.utf8.count <= maximumBytes * 3,
              raw.lowercased().hasPrefix("data:"), let comma = raw.firstIndex(of: ",") else { return nil }
        let fields = raw[raw.index(raw.startIndex, offsetBy: 5)..<comma].lowercased().split(separator: ";")
        guard let mime = fields.first, mimeTypes.contains(String(mime)) else { return nil }
        let body = String(raw[raw.index(after: comma)...])
        let data = fields.contains("base64") ? Data(base64Encoded: body) : body.removingPercentEncoding.map { Data($0.utf8) }
        guard let data, !data.isEmpty, data.count <= maximumBytes else { return nil }
        return data
    }
}
