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
            guard let raw, raw.count <= 4096, let url = URL(string: raw),
                ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
            return url
        }
        switch _tag {
        case "themed-logo": return image(dark ? logoUrlDark ?? logoUrl : logoUrl)
        case "website":
            if dark, let explicit = image(faviconUrlDark) { return explicit }
            if dark, let page = image(pageUrl), page.host?.lowercased() == "github.com" {
                return URL(string: "https://github.githubassets.com/favicons/favicon-dark.svg")
            }
            if let explicit = image(faviconUrl) { return explicit }
            if let page = image(pageUrl), page.host?.lowercased() == "github.com" {
                return URL(string: "https://github.githubassets.com/favicons/favicon.svg")
            }
            guard let page = image(pageUrl), var parts = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return nil }
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
}
