import Foundation

// Ported from apps/mobile/src/lib/markdownMediaSource.ts, which itself mirrors
// the web `resolveMarkdownMediaSource`. Assistant media arrives three ways — an
// ordinary URL, a path inside the thread workspace, or a Hermes browser
// artifact — and every client has to agree on which one a given `src` means.

/// What a non-URL markdown `src` points at once it has been classified.
///
/// This deliberately does not reuse `AssetResource`: that type has no
/// browser-artifact case yet, and collapsing the two would either lose the
/// Hermes route or force a change to a shared Core type.
public enum MarkdownMediaResource: Equatable, Sendable {
    case workspaceFile(threadID: String, path: String)
    /// A file in the server's browser-artifacts directory (Hermes screenshots
    /// and recordings), served by name rather than by workspace path.
    case browserArtifact(fileName: String)
}

public enum ResolvedMarkdownMediaSource: Equatable, Sendable {
    case direct(url: String)
    case resource(MarkdownMediaResource)
}

public enum MarkdownMediaSource {
    /// Schemes a media view can load itself, without minting an asset URL.
    private static let directPrefixes = ["http:", "https:", "data:", "blob:", "file:", "//"]

    /// Markdown carries no MIME type, so the extension is all we have to decide
    /// between a player and an image view.
    private static let videoExtensions = [".mp4", ".mov", ".m4v", ".webm"]

    private static let pathSeparators: Set<Character> = ["/", "\\"]

    public static func resolve(_ src: String, threadID: String) -> ResolvedMarkdownMediaSource {
        if isDirectlyLoadable(src) {
            // The undecoded src on purpose: it is handed straight to the loader.
            return .direct(url: src)
        }
        let path = mediaPath(from: src)
        if let fileName = browserArtifactFileName(path) {
            return .resource(.browserArtifact(fileName: fileName))
        }
        return .resource(
            .workspaceFile(
                threadID: threadID,
                path: path.hasPrefix("./") ? String(path.dropFirst(2)) : path
            )
        )
    }

    /// Display name for a media source: the last path segment, percent-decoded.
    public static func fileName(_ src: String) -> String {
        let withoutQuery = beforeQueryOrFragment(src)
        let basename = withoutQuery.lastIndex(of: "/").map {
            String(withoutQuery[withoutQuery.index(after: $0)...])
        } ?? withoutQuery
        // A src ending in "/" has no trailing segment; the whole path still reads
        // better than an empty caption.
        return safeDecode(basename.isEmpty ? withoutQuery : basename)
    }

    public static func isVideo(_ src: String) -> Bool {
        let withoutQuery = beforeQueryOrFragment(src).lowercased()
        return videoExtensions.contains { withoutQuery.hasSuffix($0) }
    }

    private static func isDirectlyLoadable(_ src: String) -> Bool {
        let lowered = src.lowercased()
        return directPrefixes.contains { lowered.hasPrefix($0) }
    }

    private static func beforeQueryOrFragment(_ src: String) -> String {
        guard let end = src.firstIndex(where: { $0 == "?" || $0 == "#" }) else { return src }
        return String(src[..<end])
    }

    /// `decodeURIComponent` semantics: a malformed escape leaves the value alone
    /// instead of failing the whole render.
    private static func safeDecode(_ value: String) -> String {
        value.removingPercentEncoding ?? value
    }

    private static func mediaPath(from src: String) -> String {
        let decoded = safeDecode(beforeQueryOrFragment(src))
        // Markdown from a Windows host arrives as "/C:/…"; drop the leading slash.
        return isEscapedWindowsDrivePath(decoded) ? String(decoded.dropFirst()) : decoded
    }

    private static func isEscapedWindowsDrivePath(_ value: String) -> Bool {
        let head = Array(value.prefix(4))
        guard head.count == 4 else { return false }
        return head[0] == "/"
            && head[1].isDriveLetter
            && head[2] == ":"
            && pathSeparators.contains(head[3])
    }

    private static func isAbsolutePath(_ value: String) -> Bool {
        guard let first = value.first else { return false }
        if pathSeparators.contains(first) { return true }
        let head = Array(value.prefix(3))
        guard head.count == 3 else { return false }
        return head[0].isDriveLetter && head[1] == ":" && pathSeparators.contains(head[2])
    }

    /// Only an absolute path qualifies: a workspace can legitimately contain its
    /// own `browser-artifacts` directory, and a relative src is always workspace
    /// relative.
    private static func browserArtifactFileName(_ path: String) -> String? {
        guard isAbsolutePath(path) else { return nil }
        let segments = path.split(omittingEmptySubsequences: false) {
            pathSeparators.contains($0)
        }
        // Three segments is the minimum that puts a separator ahead of the
        // directory, which is what the shared pattern requires.
        guard segments.count >= 3,
              segments[segments.count - 2] == "browser-artifacts",
              let fileName = segments.last,
              !fileName.isEmpty
        else { return nil }
        return String(fileName)
    }
}

extension Character {
    /// `[A-Za-z]` — a Windows drive letter, not any Unicode letter.
    fileprivate var isDriveLetter: Bool { isASCII && isLetter }
}
