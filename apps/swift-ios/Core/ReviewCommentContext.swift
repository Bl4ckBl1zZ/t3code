import Foundation

/// The same review_comment message block rendered by web and desktop. It is
/// readable provider context, so this needs no new server capability or schema.
struct ReviewCommentContext: Equatable, Sendable {
    var sectionID: String
    var sectionTitle: String
    var filePath: String
    var startIndex: Int
    var endIndex: Int
    var rangeLabel: String
    var text: String
    var diff: String
    var language = "diff"

    struct Match: Identifiable, Equatable, Sendable {
        let range: NSRange
        let source: String
        let context: ReviewCommentContext
        var id: String { "\(range.location):\(context.sectionID):\(context.filePath)" }
    }
    private static let block = try! NSRegularExpression(pattern: #"<review_comment\b([^>]*)>\s*([\s\S]*?)</review_comment>"#)
    private static let attribute = try! NSRegularExpression(pattern: #"([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)""#)
    private static let fence = try! NSRegularExpression(pattern: #"(`{3,})([^\s`]*)[^\n]*\n([\s\S]*?)\n\1"#)
    private static let tag = try! NSRegularExpression(pattern: #"</?review_comment\b"#, options: [.caseInsensitive])

    private static func escaped(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
    private static func unescaped(_ text: String) -> String {
        text.replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&amp;", with: "&")
    }
    var formatted: String? {
        guard !filePath.isEmpty, !sectionID.isEmpty, startIndex >= 0, endIndex >= startIndex,
            text.utf16.count <= 32_000, diff.utf16.count <= 32_000,
            Self.tag.firstMatch(in: text + diff, range: NSRange(location: 0, length: (text + diff).utf16.count)) == nil else { return nil }
        let longest = diff.split(omittingEmptySubsequences: true, whereSeparator: { $0 != "`" }).map(\.count).max() ?? 0
        let fence = String(repeating: "`", count: max(3, longest + 1))
        let language = self.language.range(of: "^[a-zA-Z0-9_+-]+$", options: .regularExpression) == nil ? "diff" : self.language
        return "<review_comment sectionId=\"\(Self.escaped(sectionID))\" sectionTitle=\"\(Self.escaped(sectionTitle))\" filePath=\"\(Self.escaped(filePath))\" startIndex=\"\(startIndex)\" endIndex=\"\(endIndex)\" rangeLabel=\"\(Self.escaped(rangeLabel))\">\n\(text.trimmingCharacters(in: .whitespacesAndNewlines))\n\(fence)\(language)\n\(diff)\n\(fence)\n</review_comment>"
    }

    static func matches(in text: String) -> [Match] {
        let source = text as NSString
        return block.matches(in: text, range: NSRange(location: 0, length: source.length)).prefix(32).compactMap { match in
            let rawAttributes = source.substring(with: match.range(at: 1)) as NSString
            var values: [String: String] = [:]
            for item in attribute.matches(in: rawAttributes as String, range: NSRange(location: 0, length: rawAttributes.length)) {
                values[rawAttributes.substring(with: item.range(at: 1))] = unescaped(rawAttributes.substring(with: item.range(at: 2)))
            }
            func integer(_ key: String) -> Int? {
                guard let value = values[key], value.range(of: "^[0-9]+$", options: .regularExpression) != nil else { return nil }
                return Int(value)
            }
            guard let path = values["filePath"], !path.isEmpty, let section = values["sectionId"], !section.isEmpty,
                let first = integer("startIndex"), let last = integer("endIndex") else { return nil }
            let body = source.substring(with: match.range(at: 2)) as NSString
            guard body.length <= 66_000 else { return nil }
            let code = fence.matches(in: body as String, range: NSRange(location: 0, length: body.length)).last
            let comment = body.substring(to: code?.range.location ?? body.length).trimmingCharacters(in: .whitespacesAndNewlines)
            let context = Self(sectionID: section, sectionTitle: values["sectionTitle"] ?? "Review", filePath: path,
                startIndex: min(first, last), endIndex: max(first, last), rangeLabel: values["rangeLabel"] ?? "line",
                text: comment, diff: code.map { body.substring(with: $0.range(at: 3)) } ?? "",
                language: code.map { body.substring(with: $0.range(at: 2)) }.flatMap { $0.isEmpty ? nil : $0 } ?? "diff")
            return Match(range: match.range, source: source.substring(with: match.range), context: context)
        }
    }

    static func removingBlocks(from text: String) -> String {
        var result = text as NSString
        for match in matches(in: text).reversed() {
            var range = match.range
            if range.location >= 2, result.substring(with: NSRange(location: range.location - 2, length: 2)) == "\n\n" {
                range.location -= 2; range.length += 2
            }
            result = result.replacingCharacters(in: range, with: "") as NSString
        }
        return result as String
    }
    static func replacingPlainText(in stored: String, with text: String) -> String {
        let blocks = matches(in: stored).map(\.source)
        return blocks.isEmpty ? text : text + "\n\n" + blocks.joined(separator: "\n\n")
    }
    static func replacing(_ match: Match, in text: String, with context: Self?) -> String {
        guard let current = matches(in: text).first(where: { $0.source == match.source }) else { return text }
        if let context, let replacement = context.formatted { return (text as NSString).replacingCharacters(in: current.range, with: replacement) }
        if context == nil { return (text as NSString).replacingCharacters(in: current.range, with: "") }
        return text
    }
}
