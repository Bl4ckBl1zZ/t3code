import Observation
import SwiftUI

@MainActor @Observable
final class AssistantCitationHighlight {
    var citation: AssistantCitation?
    @ObservationIgnored private var clearTask: Task<Void, Never>?
    func show(_ citation: AssistantCitation) {
        clearTask?.cancel()
        self.citation = citation
        clearTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            self?.citation = nil
        }
    }
}
private struct AssistantCitationHighlightKey: EnvironmentKey {
    static let defaultValue: AssistantCitationHighlight? = nil
}
extension EnvironmentValues {
    var assistantCitationHighlight: AssistantCitationHighlight? {
        get { self[AssistantCitationHighlightKey.self] }
        set { self[AssistantCitationHighlightKey.self] = newValue }
    }
}

@MainActor
enum MarkdownCitationHighlight {
    static func mark(_ text: AttributedString, range: NSRange) -> AttributedString {
        let plain = String(text.characters)
        guard let stringRange = Range(range, in: plain),
              let lower = AttributedString.Index(stringRange.lowerBound, within: text),
              let upper = AttributedString.Index(stringRange.upperBound, within: text) else { return text }
        var result = text
        result[lower..<upper].backgroundColor = T3Colors.accent.opacity(0.28)
        return result
    }

    /// Same separators as citationText: newlines between blocks/list items and
    /// table rows, tabs between cells. Cached inline objects are never mutated.
    static func blocks(_ blocks: [MarkdownRenderedBlock], range: NSRange) -> [MarkdownRenderedBlock] {
        var offset = 0
        func localRange(_ text: String) -> NSRange? {
            let count = text.utf16.count
            defer { offset += count }
            let start = max(offset, range.location), end = min(offset + count, NSMaxRange(range))
            return end > start ? NSRange(location: start - offset, length: end - start) : nil
        }
        func inline(_ value: MarkdownRenderedInline) -> MarkdownRenderedInline {
            guard let local = localRange(String(value.attributedText.characters)) else { return value }
            return MarkdownRenderedInline(attributedText: mark(value.attributedText, range: local), style: value.style)
        }
        func items(_ values: [MarkdownRenderedListItem]) -> [MarkdownRenderedListItem] {
            values.enumerated().map { index, value in
                if index > 0 { offset += 1 }
                return MarkdownRenderedListItem(task: value.task, blocks: walk(value.blocks))
            }
        }
        func cells(_ values: [MarkdownRenderedInline]) -> [MarkdownRenderedInline] {
            values.enumerated().map { index, value in
                if index > 0 { offset += 1 }
                return inline(value)
            }
        }
        func walk(_ values: [MarkdownRenderedBlock]) -> [MarkdownRenderedBlock] {
            values.enumerated().map { index, block in
                if index > 0 { offset += 1 }
                switch block {
                case .paragraph(let value): return .paragraph(inline(value))
                case .heading(let level, let value): return .heading(level: level, inline: inline(value))
                case .unorderedList(let values): return .unorderedList(items(values))
                case .orderedList(let start, let values): return .orderedList(start: start, items: items(values))
                case .blockquote(let values): return .blockquote(walk(values))
                case .githubAlert(let kind, let values): return .githubAlert(kind: kind, blocks: walk(values))
                case .table(let table):
                    let header = cells(table.header)
                    let rows = table.rows.map { row in offset += 1; return cells(row) }
                    return .table(MarkdownRenderedTable(header: header, alignments: table.alignments, rows: rows, columnWidths: table.columnWidths))
                case .codeBlock(let language, let code, _):
                    return .codeBlock(language: language, code: code, citationRange: localRange(code))
                case .image, .htmlEmbed, .artifactTemplate, .thematicBreak: return block
                }
            }
        }
        return walk(blocks)
    }
}
