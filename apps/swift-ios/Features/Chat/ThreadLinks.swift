import Foundation
import SwiftUI

/// Agents mention another thread in Markdown as `[title](t3-thread://v1/<threadId>)`.
/// The id is the reference and resolves in the environment of the message that
/// holds it. Titles change, so the transcript shows the thread's current title;
/// the written label only stands in for a thread this client cannot see.
///
/// Mirrors `packages/shared/src/threadLinks.ts`.
enum ThreadLinks {
    static let hrefPrefix = "t3-thread://v1/"

    /// Code comes first in the alternation so a link written inside a code span
    /// or fence is skipped. Groups: 2 is the fence marker, 4 the span's
    /// backticks, `href` the link target.
    private static let outsideCode = try! NSRegularExpression(
        pattern: #"(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>t3-thread://v1/[^\s)]+)\)"#
    )

    /// The id as written. Thread ids can hold percent escapes of their own, so
    /// it is not decoded.
    static func threadID(href: String) -> String? {
        guard href.hasPrefix(hrefPrefix) else { return nil }
        return validID(String(href.dropFirst(hrefPrefix.count)))
    }

    /// Agents often percent-encode the id anyway. When the id as written names
    /// no thread, clients try this decoded form. Nil when decoding changes
    /// nothing or fails.
    static func percentDecoded(_ threadID: String) -> String? {
        guard let decoded = threadID.removingPercentEncoding, decoded != threadID else { return nil }
        return validID(decoded)
    }

    /// A thread link whose label survives Markdown: no brackets, backslashes,
    /// or line breaks.
    static func format(threadID: String, label: String) -> String {
        let cleaned = label
            .replacingOccurrences(of: #"[\[\]\\\r\n]"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return "[\(cleaned.isEmpty ? threadID : cleaned)](\(hrefPrefix)\(threadID))"
    }

    static func hasLinks(_ markdown: String) -> Bool {
        markdown.contains("](\(hrefPrefix)")
    }

    /// Relabels each thread link with `title(threadID)`, pointing it at the
    /// thread that title came from. A link `title` knows nothing about keeps
    /// its label; so does one written inside code.
    static func relabel(_ markdown: String, title: (String) -> String?) -> String {
        guard hasLinks(markdown) else { return markdown }
        let source = markdown as NSString
        var result = ""
        var cursor = 0
        for match in outsideCode.matches(in: markdown, range: NSRange(location: 0, length: source.length)) {
            let hrefRange = match.range(withName: "href")
            guard hrefRange.location != NSNotFound,
                  let written = threadID(href: source.substring(with: hrefRange)) else { continue }
            // The decoded id only stands in when the id as written names no thread.
            let decoded = percentDecoded(written)
            let resolved = if title(written) == nil, let decoded, title(decoded) != nil { decoded } else { written }
            guard let label = title(resolved)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !label.isEmpty else { continue }
            result += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            result += format(threadID: resolved, label: label)
            cursor = NSMaxRange(match.range)
        }
        guard cursor > 0 else { return markdown }
        return result + source.substring(from: cursor)
    }

    /// Thread ids are non-blank once trimmed, as the contract decodes them.
    private static func validID(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Resolves thread links against the threads of the environment a transcript
/// belongs to.
struct ThreadLinkResolver {
    let environmentID: String?
    /// The thread with this wire id in the transcript's environment.
    let lookup: (String) -> FeatureThread?

    /// The UI id to open for a link. A thread this client cannot see still
    /// gets its scoped id, so the screen says it is unavailable.
    func openID(forLinkID id: String) -> String {
        if let thread = thread(forLinkID: id) { return thread.id }
        return environmentID.map { FeatureScopedID.thread(environmentID: $0, wireID: id) } ?? id
    }

    /// The thread a link names: the id as written, else its percent-decoded form.
    func thread(forLinkID id: String) -> FeatureThread? {
        lookup(id) ?? ThreadLinks.percentDecoded(id).flatMap(lookup)
    }

    /// `markdown` with each link labeled by its thread's current title.
    func relabel(_ markdown: String) -> String {
        guard ThreadLinks.hasLinks(markdown) else { return markdown }
        return ThreadLinks.relabel(markdown) { lookup($0)?.title }
    }
}

extension ThreadLinkResolver {
    /// Threads are matched by wire id within one environment; a thread with no
    /// wire id is the environment's own id.
    init(threads: [FeatureThread], environmentID: String?) {
        self.init(environmentID: environmentID) { id in
            threads.first { $0.environmentID == environmentID && ($0.wireID ?? $0.id) == id }
        }
    }
}

private struct ThreadLinkResolverKey: EnvironmentKey {
    static let defaultValue: ThreadLinkResolver? = nil
}

extension EnvironmentValues {
    var threadLinkResolver: ThreadLinkResolver? {
        get { self[ThreadLinkResolverKey.self] }
        set { self[ThreadLinkResolverKey.self] = newValue }
    }
}
