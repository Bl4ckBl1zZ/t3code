import Foundation

public enum FeatureFilePreviewPath {
    public static func isAbsolute(_ path: String) -> Bool {
        path.hasPrefix("/") || path.hasPrefix("\\") || path.range(of: #"^[A-Za-z]:[/\\]"#, options: .regularExpression) != nil
    }
    public static func parent(_ path: String) -> String? {
        guard let separator = path.lastIndex(where: { $0 == "/" || $0 == "\\" }) else { return nil }
        return separator == path.startIndex ? String(path.prefix(1)) : String(path[..<separator])
    }
    public static func resolve(_ path: String, relativeTo directory: String?) -> String {
        guard let directory, !directory.isEmpty, !isAbsolute(path) else { return path }
        return directory + (directory.hasSuffix("/") || directory.hasSuffix("\\") ? "" : "/") + path
    }
    public static func isDocument(_ path: String) -> Bool {
        ["pdf", "html", "htm"].contains(URL(fileURLWithPath: path).pathExtension.lowercased())
    }
}
