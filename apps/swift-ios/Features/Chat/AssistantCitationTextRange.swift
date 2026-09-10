import Foundation

/// Resolves normalized cross-client citation offsets back to native UTF-16 text.
/// Ambiguous repeats are left unmarked, even when a stale offset happens to fit.
enum AssistantCitationTextRange {
    static func resolve(in source: String, quote: String, start: Int, end: Int, prefix: String, suffix: String) -> NSRange? {
        let stream = normalized(source)
        let text = stream.text as NSString
        let wanted = normalized(quote).text as NSString
        guard wanted.length > 0, (wanted as String).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return nil }
        let before = normalized(prefix).text as NSString, after = normalized(suffix).text as NSString
        func matchesContext(_ range: NSRange) -> Bool {
            let prefixStart = max(0, range.location - before.length)
            let suffixEnd = min(text.length, NSMaxRange(range) + after.length)
            return text.substring(with: NSRange(location: prefixStart, length: range.location - prefixStart)) == before as String
                && text.substring(with: NSRange(location: NSMaxRange(range), length: suffixEnd - NSMaxRange(range))) == after as String
        }
        var match: NSRange?
        if start >= 0, end >= start, end <= text.length, end - start == wanted.length {
            let range = NSRange(location: start, length: end - start)
            if text.substring(with: range) == wanted as String, matchesContext(range) { match = range }
        }
        var only: NSRange?
        var count = 0
        var offset = 0
        while offset <= text.length - wanted.length {
            let range = text.range(of: wanted as String, options: .literal, range: NSRange(location: offset, length: text.length - offset))
            if range.location == NSNotFound { break }
            count += 1; only = range
            if matchesContext(range) {
                if let match, match.location != range.location { return nil }
                match = range
            }
            offset = range.location + 1
        }
        guard let selected = match ?? (count == 1 ? only : nil), NSMaxRange(selected) < stream.boundaries.count else { return nil }
        let raw = NSRange(location: stream.boundaries[selected.location], length: stream.boundaries[NSMaxRange(selected)] - stream.boundaries[selected.location])
        return Range(raw, in: source) == nil ? nil : raw
    }

    private static func normalized(_ source: String) -> (text: String, boundaries: [Int]) {
        let raw = source as NSString
        let whitespace = try! NSRegularExpression(pattern: #"\s+"#)
        let matches = whitespace.matches(in: source, range: NSRange(location: 0, length: raw.length))
        var parts: [String] = []
        var boundaries = [0]
        var offset = 0
        for match in matches {
            let gap = match.range.location - offset
            if gap > 0 {
                parts.append(raw.substring(with: NSRange(location: offset, length: gap)))
                boundaries.append(contentsOf: (offset + 1)...match.range.location)
            }
            parts.append(" ")
            offset = NSMaxRange(match.range)
            boundaries.append(offset)
        }
        if offset < raw.length {
            parts.append(raw.substring(from: offset))
            boundaries.append(contentsOf: (offset + 1)...raw.length)
        }
        return (parts.joined(), boundaries)
    }
}
