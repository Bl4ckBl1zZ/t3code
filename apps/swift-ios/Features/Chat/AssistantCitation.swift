import Foundation

/// Origin-independent quote links shared with the web composer. Offsets count
/// UTF-16 units in normalized rendered text, never Markdown source bytes.
struct AssistantCitation: Codable, Equatable, Identifiable, Sendable {
    var id: String { href }
    let version: Int
    let environmentId: String
    let threadId: String
    let messageId: String
    let text: String
    var comment: String?
    let start: Int
    let end: Int
    let prefix: String
    let suffix: String

    var isValid: Bool {
        version == 1 && [environmentId, threadId, messageId].allSatisfy { !$0.isEmpty && $0.utf16.count <= 512 }
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf16.count <= 8_000
            && (comment?.utf16.count ?? 0) <= 8_000 && start >= 0 && end > start && end <= 9_007_199_254_740_991
            && prefix.utf16.count <= 32 && suffix.utf16.count <= 32
    }

    private static func encode(_ text: String, form: Bool) -> String {
        text.utf8.map { byte in
            if (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || [45, 46, 95].contains(byte)
                || (form ? byte == 42 : byte == 126) { return String(UnicodeScalar(byte)) }
            if form && byte == 32 { return "+" }
            return String(format: "%%%02X", byte)
        }.joined()
    }

    var href: String {
        let path = [environmentId, threadId, messageId].map { Self.encode($0, form: false) }.joined(separator: "/")
        var fields = [("text", text), ("start", String(start)), ("end", String(end)), ("prefix", prefix), ("suffix", suffix)]
        if let comment { fields.append(("comment", comment)) }
        return "t3-citation://v1/\(path)?" + fields.map { "\($0.0)=\(Self.encode($0.1, form: true))" }.joined(separator: "&")
    }
    var marker: String { "[Assistant quote](\(href))" }

    static func parse(_ href: String) -> Self? {
        guard href.hasPrefix("t3-citation://v1/"), href.utf16.count <= 160_000,
              href.range(of: "%[^0-9A-Fa-f]|%[0-9A-Fa-f][^0-9A-Fa-f]|%[0-9A-Fa-f]?$", options: .regularExpression) == nil,
              let url = URLComponents(string: href), url.scheme == "t3-citation", url.host == "v1",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              let query = url.percentEncodedQuery else { return nil }
        let parts = url.percentEncodedPath.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var fields: [String: String] = [:]
        for part in query.split(separator: "&", omittingEmptySubsequences: false) {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2, let key = String(pair[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let value = String(pair[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  fields[key] == nil else { return nil }
            fields[key] = value
        }
        guard Set(fields.keys).subtracting(["text", "start", "end", "prefix", "suffix", "comment"]).isEmpty,
              let environment = String(parts[0]).removingPercentEncoding,
              let thread = String(parts[1]).removingPercentEncoding,
              let message = String(parts[2]).removingPercentEncoding,
              let text = fields["text"], let prefix = fields["prefix"], let suffix = fields["suffix"],
              let startText = fields["start"], let endText = fields["end"],
              startText.range(of: "^[0-9]{1,16}$", options: .regularExpression) != nil,
              endText.range(of: "^[0-9]{1,16}$", options: .regularExpression) != nil,
              let start = Int(startText), let end = Int(endText) else { return nil }
        let citation = Self(version: 1, environmentId: environment, threadId: thread, messageId: message,
                            text: text, comment: fields["comment"], start: start, end: end, prefix: prefix, suffix: suffix)
        return citation.isValid ? citation : nil
    }

    struct Match: Identifiable {
        var id: Int { range.location }
        let range: NSRange
        let source: String
        let citation: AssistantCitation
    }
    private static let links = try! NSRegularExpression(pattern: #"\[Assistant quote\]\((t3-citation://v1/[^\s)]{1,160000})\)"#)
    static func matches(in text: String) -> [Match] {
        let source = text as NSString
        return links.matches(in: text, range: NSRange(location: 0, length: source.length)).compactMap { match in
            guard let citation = parse(source.substring(with: match.range(at: 1))) else { return nil }
            return Match(range: match.range, source: source.substring(with: match.range), citation: citation)
        }
    }
    static func plainText(_ text: String) -> String {
        var result = text as NSString
        for match in matches(in: text).reversed() {
            let comment = match.citation.comment.map { "\nComment: " + $0 } ?? ""
            result = result.replacingCharacters(in: match.range, with: match.citation.text + comment) as NSString
        }
        return result as String
    }
    static func removingMarkers(from text: String) -> String {
        var result = text as NSString
        for match in matches(in: text).reversed() { result = result.replacingCharacters(in: match.range, with: "") as NSString }
        return result as String
    }
    static func replacingPlainText(in stored: String, with text: String) -> String {
        let markers = matches(in: stored).map(\.source)
        guard !markers.isEmpty else { return text }
        return text + markers.joined()
    }
    static func replacing(_ match: Match, in text: String, with citation: AssistantCitation?) -> String {
        // Re-read the current draft: offsets from an open editor may have moved.
        guard let current = matches(in: text).first(where: { $0.source == match.source }) else { return text }
        return (text as NSString).replacingCharacters(in: current.range, with: citation?.marker ?? "")
    }

    static func capture(text: String, range: NSRange, environmentId: String, threadId: String, messageId: String) -> Self? {
        let raw = text as NSString
        guard range.location >= 0, range.length > 0, range.location <= raw.length, range.length <= raw.length - range.location,
              Range(range, in: text) != nil else { return nil }
        func splitsSurrogate(_ offset: Int) -> Bool {
            offset > 0 && offset < raw.length && (0xD800...0xDBFF).contains(raw.character(at: offset - 1))
                && (0xDC00...0xDFFF).contains(raw.character(at: offset))
        }
        guard !splitsSurrogate(range.location), !splitsSurrogate(NSMaxRange(range)) else { return nil }
        func normalize(_ value: String) -> String { value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression) }
        let normalized = normalize(text) as NSString
        var start = (normalize(raw.substring(to: range.location)) as NSString).length
        if range.location > 0,
           raw.substring(with: NSRange(location: range.location - 1, length: 1)).range(of: #"\s"#, options: .regularExpression) != nil,
           raw.substring(with: NSRange(location: range.location, length: 1)).range(of: #"\s"#, options: .regularExpression) != nil { start -= 1 }
        let end = (normalize(raw.substring(to: NSMaxRange(range))) as NSString).length
        var prefixStart = max(0, start - 32)
        var suffixEnd = min(normalized.length, end + 32)
        if prefixStart > 0 && prefixStart < normalized.length && (0xDC00...0xDFFF).contains(normalized.character(at: prefixStart)) { prefixStart += 1 }
        if suffixEnd > 0 && suffixEnd < normalized.length && (0xDC00...0xDFFF).contains(normalized.character(at: suffixEnd)) { suffixEnd -= 1 }
        let citation = Self(version: 1, environmentId: environmentId, threadId: threadId, messageId: messageId,
                            text: raw.substring(with: range), start: start, end: end,
                            prefix: normalized.substring(with: NSRange(location: prefixStart, length: start - prefixStart)),
                            suffix: normalized.substring(with: NSRange(location: end, length: suffixEnd - end)))
        return citation.isValid ? citation : nil
    }
}
