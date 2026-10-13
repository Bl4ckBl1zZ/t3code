import Foundation

public struct ToolActivityNativeAppReference: Codable, Equatable, Sendable {
    public let _tag: String
    public let appId: String?
    public let displayName: String?
}

public struct ToolActivityIcon: Codable, Equatable, Sendable {
    public let _tag: String
    public let pageUrl: String?
    public let faviconUrl: String?
    public let faviconUrlDark: String?
    public let app: ToolActivityNativeAppReference?
    public let logoUrl: String?
    public let logoUrlDark: String?

    public func imageURL(dark: Bool) -> URL? {
        func image(_ raw: String?) -> URL? {
            guard let raw else { return nil }
            if ToolIconImageData.inline(raw) != nil { return URL(string: raw) }
            guard raw.count <= 4096, let url = URL(string: raw),
                ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                url.host != nil else { return nil }
            return url
        }
        switch _tag {
        case "themed-logo": return image(dark ? logoUrlDark ?? logoUrl : logoUrl)
        case "website":
            if dark, let explicit = image(faviconUrlDark) { return explicit }
            if dark, let page = image(pageUrl), ["http", "https"].contains(page.scheme?.lowercased() ?? ""), page.host?.lowercased() == "github.com" {
                return URL(string: "https://github.githubassets.com/favicons/favicon-dark.svg")
            }
            if let explicit = image(faviconUrl) { return explicit }
            if let page = image(pageUrl), ["http", "https"].contains(page.scheme?.lowercased() ?? ""), page.host?.lowercased() == "github.com" {
                return URL(string: "https://github.githubassets.com/favicons/favicon.svg")
            }
            guard let page = image(pageUrl), ["http", "https"].contains(page.scheme?.lowercased() ?? ""), var parts = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return nil }
            parts.path = "/favicon.ico"; parts.query = nil; parts.fragment = nil; parts.user = nil; parts.password = nil
            return parts.url
        default: return nil
        }
    }
}

public struct ToolActivitySource: Codable, Equatable, Sendable {
    public let key: String
    public let name: String
    public let kind: String
    public let icon: ToolActivityIcon?

    /// What a computer-use call reads as before (or without) result metadata.
    static let computerUse = ToolActivitySource(key: "computer-use", name: "Computer Use", kind: "computer", icon: nil)
}

/// JavaScript REPL tools (Codex's computer use and node REPL). Ported from
/// `isJavaScriptReplTool`, `dynamicToolSurface` and `dynamicToolTitle` in
/// packages/shared/src/toolActivity.ts.
public enum JavaScriptReplTool {
    public static func matches(_ toolName: String?) -> Bool {
        toolName == "js" || toolName == "cua_repl.js" || toolName == "node_repl.js"
    }

    /// "computer" for a computer-use call, which may fail or still be running
    /// before result metadata says so; nil otherwise.
    public static func surface(toolName: String?, input: JSONValue?) -> String? {
        if toolName == "cua_repl.js" { return "computer" }
        guard matches(toolName), let code = input?["code"]?.stringValue else { return nil }
        let sky = code.range(of: #"\bsky\s*\."#, options: .regularExpression) != nil
            || code.range(of: #"["']@oai/sky["']"#, options: .regularExpression) != nil
        return sky ? "computer" : nil
    }

    /// The row heading: the call's own `title` argument, then a meaningful
    /// retained title (not the raw tool name), then "Computer use" or "Run
    /// JavaScript". Nil for any other tool.
    public static func title(toolName: String?, input: JSONValue?, retainedTitle: String?) -> String? {
        guard matches(toolName) else { return nil }
        func trimmed(_ value: String?) -> String? {
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return value
        }
        let retained = trimmed(retainedTitle).flatMap { title in
            title.lowercased() == "js" || title.lowercased() == toolName?.lowercased() ? nil : title
        }
        return trimmed(input?["title"]?.stringValue)
            ?? retained
            ?? (surface(toolName: toolName, input: input) == "computer" ? "Computer use" : "Run JavaScript")
    }
}

extension OrchestrationV2TurnItem {
    /// `toolSurface`, else the retained source's browser/computer kind, else
    /// a computer-use REPL call recognized from its code.
    var presentedToolSurface: String? {
        if toolSurface == "browser" || toolSurface == "computer" { return toolSurface }
        if let kind = toolSource?.kind, kind == "computer" || kind == "browser" { return kind }
        guard case let .dynamicTool(toolName, input, _) = payload else { return nil }
        return JavaScriptReplTool.surface(toolName: toolName, input: input)
    }

    /// A computer-use call names Computer Use even when its retained source is
    /// the generic node REPL integration.
    var presentedToolSource: ToolActivitySource? {
        presentedToolSurface == "computer" && toolSource?.kind != "computer" ? .computerUse : toolSource
    }
}
