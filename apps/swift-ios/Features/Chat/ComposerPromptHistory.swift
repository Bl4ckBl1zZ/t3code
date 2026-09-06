import Foundation

struct ComposerPromptHistory {
    struct Entry: Identifiable, Equatable { let id: String; let prompt: String }
    private(set) var position: Entry?

    static func entries(_ messages: [FeatureMessage]) -> [Entry] {
        var result: [Entry] = []
        for message in messages where message.role == .user && !message.isAgentAuthored {
            let prompt = recallable(message.text)
            guard !prompt.isEmpty else { continue }
            if result.last?.prompt == prompt { result.removeLast() }
            result.append(Entry(id: message.id, prompt: prompt))
        }
        return result
    }

    static func recallable(_ text: String) -> String {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("Ultrathink:\n") { text.removeFirst("Ultrathink:\n".count) }
        // Strip only trailing send-time context, never matching prose in the middle.
        let pattern = #"\s*<(terminal_context|element_context|preview_annotation|review_comment)\b[^>]*>(?:(?!</?\1\b)[\s\S])*?</\1>\s*$"#
        while let range = text.range(of: pattern, options: .regularExpression) {
            let block = String(text[range])
            text.removeSubrange(range)
            if block.contains("<terminal_context>") {
                let headers = try? NSRegularExpression(pattern: #"(?m)^- (.+?) lines? (\d+(?:-\d+)?):\s*$"#)
                for match in headers?.matches(in: block, range: NSRange(block.startIndex..., in: block)) ?? [] {
                    guard let nameRange = Range(match.range(at: 1), in: block),
                          let linesRange = Range(match.range(at: 2), in: block) else { continue }
                    let name = block[nameRange].trimmingCharacters(in: .whitespaces)
                        .lowercased().replacingOccurrences(of: #"\s+"#, with: "-", options: .regularExpression)
                    let label = "@\(name):\(block[linesRange])"
                    let escaped = NSRegularExpression.escapedPattern(for: label)
                    if let range = text.range(of: escaped + #"(?![\d-]) ?"#, options: .regularExpression) {
                        text.removeSubrange(range)
                    }
                }
            }
        }
        let result = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if result.hasPrefix("PLEASE IMPLEMENT THIS PLAN:") || result == "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]" { return "" }
        return result
    }

    mutating func select(_ entry: Entry) -> String { position = entry; return entry.prompt }

    mutating func step(backward: Bool, entries: [Entry], current: String) -> String? {
        let active = position.flatMap { position in
            position.prompt == current ? entries.firstIndex(where: { $0.id == position.id })
                ?? entries.lastIndex(where: { $0.prompt == position.prompt }) : nil
        }
        if backward {
            guard active != nil || current.isEmpty else { return nil }
            let index = (active ?? entries.count) - 1
            guard entries.indices.contains(index) else { return nil }
            return select(entries[index])
        }
        guard let active else { return nil }
        if entries.indices.contains(active + 1) { return select(entries[active + 1]) }
        position = nil
        return ""
    }
}
