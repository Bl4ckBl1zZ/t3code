import Foundation
import SwiftUI

// Host markdown (descriptions, comments, guide prose) prepared for the native
// renderer, which reads markdown but not HTML. Ported in spirit from upstream
// `packages/client-runtime/src/pullRequestMarkdown.ts` (standalone media),
// `packages/shared/src/githubMarkdownLinks.ts` (GitHub references) and mobile's
// `botBadgeImages.ts`.
//
// What changes, outside code: HTML comments (PR templates) are dropped, as
// GitHub hides them; a line of `<img>` tags (how GitHub writes a dropped
// image) or a standalone image or video link becomes markdown media; bot and
// CI badges are left out of those media blocks, where each would take a full
// media frame; a bare GitHub video upload becomes a tappable link; and `#123`,
// `owner/repo#123`, commit SHAs and `@mentions` link to the host.
enum PullRequestMarkdown {
    static func prepare(_ markdown: String, pullRequestURL: String?) -> String {
        let key = "\(pullRequestURL ?? "")\u{0}\(markdown)" as NSString
        if let cached = cache.object(forKey: key) { return cached as String }
        let prepared = linkGitHubReferences(liftMedia(markdown), pullRequestURL: pullRequestURL)
        cache.setObject(prepared as NSString, forKey: key)
        return prepared
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, NSString> = {
        let cache = NSCache<NSString, NSString>()
        cache.countLimit = 200
        return cache
    }()

    // MARK: - Media

    /// Lines are rewritten one at a time outside fenced and indented code, so
    /// a code example is never turned into media.
    static func liftMedia(_ markdown: String) -> String {
        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var output: [String] = []
        var fence: String?
        var inComment = false
        var index = 0
        while index < lines.count {
            var line = lines[index]
            index += 1
            if inComment {
                guard let end = line.range(of: "-->") else { continue }
                inComment = false
                line = String(line[end.upperBound...])
                if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            }
            if let marker = fenceMarker(line) {
                if fence == nil { fence = marker } else if closes(line, marker: marker, opening: fence!) { fence = nil }
                output.append(line)
                continue
            }
            if fence != nil || isIndentedCode(line, previous: output.last) {
                output.append(line)
                continue
            }
            // A comment that opens a line hides through its close.
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("<!--") {
                let start = line.range(of: "<!--")!
                if let end = line.range(of: "-->", range: start.upperBound..<line.endIndex) {
                    line = String(line[..<start.lowerBound]) + String(line[end.upperBound...])
                    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                } else {
                    inComment = true
                    continue
                }
            }
            if let video = videoTag(lines, at: index - 1) {
                output.append(mediaMarkdown(url: video.url, video: true))
                index = video.next
                continue
            }
            if let lifted = liftedLine(line) {
                if !lifted.isEmpty { output.append(lifted) }
                continue
            }
            output.append(line)
        }
        return output.joined(separator: "\n")
    }

    /// The replacement for a line that is only media, or nil to keep it as is.
    /// An empty string drops the line: badges with nothing else beside them.
    private static func liftedLine(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if let url = standaloneLink(trimmed), isWebURL(url) {
            if hasExtension(url, videoExtensions) { return mediaMarkdown(url: url, video: true) }
            if isGitHubAsset(url) { return trimmed.hasPrefix("[") ? nil : "[Video](\(url))" }
            if hasExtension(url, imageExtensions), !isBotBadgeImage(url) { return mediaMarkdown(url: url, video: false) }
            return nil
        }
        if let images = MarkdownImageLine.images(in: trimmed) {
            let kept = images.filter { !isBotBadgeImage($0.src) }
            guard kept.count != images.count else { return nil }
            return kept.map { "![\(escapeAlt($0.alt))](\(destination($0.src)))" }.joined(separator: " ")
        }
        guard trimmed.lowercased().contains("<img") else { return nil }
        let leftover = htmlWrapperPattern.stringByReplacingMatches(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed), withTemplate: "")
        guard leftover.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        let images = imgTagPattern.matches(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)).compactMap { match -> (src: String, alt: String)? in
            guard let tagRange = Range(match.range, in: trimmed) else { return nil }
            let tag = String(trimmed[tagRange])
            guard let src = attribute("src", in: tag), isWebURL(src) else { return nil }
            return (src, attribute("alt", in: tag) ?? "Image")
        }
        return images.filter { !isBotBadgeImage($0.src) }
            .map { "![\(escapeAlt($0.alt))](\(destination($0.src)))" }
            .joined(separator: " ")
    }

    /// A `<video>` tag that owns its line, closed within a few lines.
    private static func videoTag(_ lines: [String], at start: Int) -> (url: String, next: Int)? {
        guard lines[start].trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("<video") else { return nil }
        var end = start
        while end < min(start + 8, lines.count) {
            if lines[end].trimmingCharacters(in: .whitespaces).lowercased().hasSuffix("</video>") {
                let tag = lines[start...end].joined(separator: "\n")
                guard let match = videoSourcePattern.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)),
                      let range = Range(match.range(at: 1), in: tag) else { return nil }
                let url = String(tag[range])
                return isWebURL(url) ? (url, end + 1) : nil
            }
            end += 1
        }
        return nil
    }

    /// Video with a file extension plays inline; a GitHub upload without one
    /// cannot be told from an image, so it stays a link the browser plays.
    private static func mediaMarkdown(url: String, video: Bool) -> String {
        if video, !hasExtension(url, videoExtensions) { return "[Video](\(url))" }
        let name = video ? "Video" : (URL(string: url)?.lastPathComponent).flatMap { $0.isEmpty ? nil : $0 } ?? "Image"
        return "![\(escapeAlt(name))](\(destination(url)))"
    }

    /// Logos, buttons and status icons review bots, agents and CI stamp into
    /// pull requests. Each prefix serves only those assets, so screenshots on
    /// the same services stay visible.
    static func isBotBadgeImage(_ url: String) -> Bool {
        var path = url.lowercased()
        for scheme in ["https://", "http://"] where path.hasPrefix(scheme) { path.removeFirst(scheme.count) }
        if path.hasPrefix("www.") { path.removeFirst(4) }
        return botBadgePrefixes.contains { path.hasPrefix($0) }
    }

    private static let botBadgePrefixes = [
        // Coding agents and review bots
        "static.devin.ai/assets/", "cursor.com/assets/images/", "storage.googleapis.com/coderabbit_public_assets/",
        "greptile-static-assets.s3.amazonaws.com/badges/", "static.graphite.dev/", "qodo.ai/wp-content/uploads/",
        "cubic.dev/buttons/", "github.githubassets.com/static/images/icons/copilot-code-review/",
        "gstatic.com/codereviewagent/", "vercel.com/vercel-agent-view-suggestion-", "agents-vade-review.vercel.sh/",
        "new-codeant-butcket.s3.us-west-1.amazonaws.com/badges/", "pr-comments-assets.blacksmith.sh/",
        "app.roocode.com/cloud-agents/github/", "app.parameter.ai/_static/icons/",
        // CI, deploy and dependency bots
        "img.shields.io/", "raster.shields.io/", "dependabot-badges.githubapp.com/", "developer.mend.io/api/mc/badges/",
        "api.securityscorecards.dev/projects/", "github-app-statics.socket.dev/", "static.deepsource.com/comment_artifacts/",
        "sonarsource.github.io/sonarcloud-github-static-resources/", "codescene.io/imgs/svg/", "app.codecov.io/gh/",
        "github.com/codecov/engineering-team/assets/", "codspeed.io/pr-report/", "static.trunk.io/assets/",
        "res.cloudinary.com/snyk/", "api.segment.io/v1/pixel/", "cla-assistant.io/pull/badge/", "vercel.com/static/status/",
        "vercel.com/api/www/avatar", "app.netlify.com/qr-code/", "workers.cloudflare.com/logo.svg",
        // Cloudflare Pages reuses one old GitHub upload as its logo.
        "user-images.githubusercontent.com/23264/106598434-9e719e00-654f-11eb-9e59-6167043cfa01.png",
        "qr.expo.dev/",
    ]

    private static let imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "svg"]
    private static let videoExtensions = ["mp4", "mov", "m4v", "webm"]

    private static func hasExtension(_ url: String, _ extensions: [String]) -> Bool {
        guard let path = URL(string: url)?.path.lowercased() else { return false }
        return extensions.contains { path.hasSuffix(".\($0)") }
    }

    private static func isGitHubAsset(_ url: String) -> Bool {
        url.range(of: #"^https://github\.com/user-attachments/assets/[\w-]+$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func isWebURL(_ url: String) -> Bool {
        guard let scheme = URL(string: url)?.scheme?.lowercased() else { return false }
        return scheme == "https" || scheme == "http"
    }

    /// A bare URL, `<url>`, or `[text](url)` alone on its line.
    private static func standaloneLink(_ line: String) -> String? {
        if let match = line.range(of: #"^<?https?://\S+?>?$"#, options: .regularExpression) {
            var url = String(line[match])
            if url.hasPrefix("<") { url.removeFirst() }
            if url.hasSuffix(">") { url.removeLast() }
            return url
        }
        let range = NSRange(line.startIndex..., in: line)
        guard let match = markdownLinkPattern.firstMatch(in: line, range: range),
              let url = Range(match.range(at: 1), in: line) else { return nil }
        return String(line[url])
    }

    private static func attribute(_ name: String, in tag: String) -> String? {
        let pattern = #"\b"# + name + #"\s*=\s*["']([^"']*)["']"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
              let match = regex.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)),
              let range = Range(match.range(at: 1), in: tag) else { return nil }
        return String(tag[range]).replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func escapeAlt(_ alt: String) -> String {
        alt.replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
    }

    private static func destination(_ url: String) -> String {
        url.contains(" ") || url.contains(")") ? "<\(url)>" : url
    }

    private static let markdownLinkPattern = try! NSRegularExpression(pattern: #"^\[[^\]]*\]\((https?://[^\s)]+)\)$"#)
    private static let imgTagPattern = try! NSRegularExpression(pattern: #"<img\b[^>]*>"#, options: .caseInsensitive)
    /// What may wrap a row of images on a line of their own.
    private static let htmlWrapperPattern = try! NSRegularExpression(
        pattern: #"<img\b[^>]*>|</?(?:p|a|div|picture|span)\b[^>]*>|<source\b[^>]*>|<br\s*/?>|&nbsp;"#, options: .caseInsensitive)
    private static let videoSourcePattern = try! NSRegularExpression(
        pattern: #"<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']"#, options: .caseInsensitive)

    // MARK: - Code

    private static func fenceMarker(_ line: String) -> String? {
        let indent = line.prefix { $0 == " " }.count
        guard indent <= 3 else { return nil }
        let rest = line.dropFirst(indent)
        guard let first = rest.first, first == "`" || first == "~" else { return nil }
        let run = rest.prefix { $0 == first }
        return run.count >= 3 ? String(run) : nil
    }

    /// A fence closes only on the same marker, at least as long, with nothing after it.
    private static func closes(_ line: String, marker: String, opening: String) -> Bool {
        marker.first == opening.first && marker.count >= opening.count
            && line.trimmingCharacters(in: .whitespaces).allSatisfy { $0 == marker.first }
    }

    /// Four spaces open an indented code block only after a blank line (or
    /// another code line); inside a paragraph or list they are continuation.
    private static func isIndentedCode(_ line: String, previous: String?) -> Bool {
        guard line.hasPrefix("    ") || line.hasPrefix("\t") else { return false }
        guard let previous else { return true }
        return previous.trimmingCharacters(in: .whitespaces).isEmpty || previous.hasPrefix("    ") || previous.hasPrefix("\t")
    }

    // MARK: - GitHub references

    /// Links `#123`, `owner/repo#123`, commit SHAs and `@login` or
    /// `@org/team` in prose, leaving code, links, URLs and HTML alone.
    /// Only for GitHub pull requests, whose URL names the repository.
    static func linkGitHubReferences(_ markdown: String, pullRequestURL: String?) -> String {
        guard let pullRequestURL, let url = URL(string: pullRequestURL), let host = url.host?.lowercased(),
              host.contains("github"), let scheme = url.scheme, scheme == "https" || scheme == "http" else { return markdown }
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return markdown }
        let origin = "\(scheme)://\(url.host!)\(url.port.map { ":\($0)" } ?? "")"
        let owner = parts[0], repo = parts[1]
        guard markdown.contains("#") || markdown.contains("@") || markdown.range(of: #"\b[a-f\d]{7,40}\b"#, options: [.regularExpression, .caseInsensitive]) != nil else {
            return markdown
        }

        func repository(_ qualifier: String?) -> String {
            guard let qualifier else { return "\(owner)/\(repo)" }
            return qualifier.contains("/") ? qualifier : "\(qualifier)/\(repo)"
        }

        func link(_ text: Substring) -> String {
            let source = String(text)
            let ns = source as NSString
            var result = ""
            var cursor = 0
            for match in referencePattern.matches(in: source, range: NSRange(location: 0, length: ns.length)) {
                func group(_ index: Int) -> String? {
                    let range = match.range(at: index)
                    return range.location == NSNotFound ? nil : ns.substring(with: range)
                }
                let label = ns.substring(with: match.range)
                let path: String?
                if let number = group(2) {
                    path = "\(repository(group(1)))/issues/\(number)"
                } else if let sha = group(4) {
                    path = sha.range(of: "[a-f]", options: [.regularExpression, .caseInsensitive]) == nil
                        ? nil : "\(repository(group(3)))/commit/\(sha)"
                } else if let mention = group(5) {
                    let pieces = mention.split(separator: "/")
                    path = pieces.count == 2 ? "orgs/\(pieces[0])/teams/\(pieces[1])" : mention
                } else {
                    path = nil
                }
                guard let path else { continue }
                result += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
                result += "[\(label)](\(origin)/\(path))"
                cursor = match.range.location + match.range.length
            }
            return result + ns.substring(from: cursor)
        }

        var output: [String] = []
        var fence: String?
        for line in markdown.components(separatedBy: "\n") {
            if let marker = fenceMarker(line) {
                if fence == nil { fence = marker } else if closes(line, marker: marker, opening: fence!) { fence = nil }
                output.append(line)
                continue
            }
            if fence != nil || isIndentedCode(line, previous: output.last) {
                output.append(line)
                continue
            }
            var rewritten = ""
            var cursor = line.startIndex
            let ns = NSRange(line.startIndex..., in: line)
            for match in protectedPattern.matches(in: line, range: ns) {
                guard let range = Range(match.range, in: line) else { continue }
                rewritten += link(line[cursor..<range.lowerBound])
                rewritten += line[range]
                cursor = range.upperBound
            }
            rewritten += link(line[cursor...])
            output.append(rewritten)
        }
        return output.joined(separator: "\n")
    }

    /// Spans a reference must not be linked inside: code spans, HTML anchors
    /// and code with their contents, links and images, autolinks and bare
    /// URLs, and HTML tags.
    private static let protectedPattern = try! NSRegularExpression(
        pattern: #"(`+)[^`]*?\1|<(a|code|pre)\b[^>]*>.*?</\2\s*>|!?\[(?:[^\[\]]|\[[^\]]*\])*\]\([^)]*\)|!?\[(?:[^\[\]]|\[[^\]]*\])*\]\[[^\]]*\]|<https?://[^>]*>|https?://\S+|<[a-zA-Z/!][^>]*>"#)

    /// `githubMarkdownLinks.ts`'s reference pattern: issue, commit, mention.
    private static let referencePattern = try! NSRegularExpression(
        pattern: #"(?<![\w/\\])(?:([\w.-]+/[\w.-]+|[\w-]+)?#([1-9]\d*)|(?:([\w.-]+/[\w.-]+|[\w-]+)@)?([a-f\d]{7,40})(?!\w)|@([a-z\d](?:[a-z\d-]*[a-z\d])?(?:/[a-z\d][a-z\d-]*)?))(?!\w)"#,
        options: .caseInsensitive)
}

/// Host markdown in the pull-request screens, prepared by ``PullRequestMarkdown``.
struct PullRequestMarkdownView: View {
    private let source: String

    init(_ markdown: String, pullRequestURL: String?) {
        source = PullRequestMarkdown.prepare(markdown, pullRequestURL: pullRequestURL)
    }

    var body: some View {
        MarkdownMessageView(source)
    }
}
