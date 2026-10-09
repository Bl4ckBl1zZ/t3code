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

/// A painted span of rendered Markdown text, in UTF-16 offsets of
/// `MarkdownRenderedDocument.citationText`.
struct MarkdownTextMark: Equatable {
    let range: NSRange
    let background: Color
    var foreground: Color? = nil
    /// Code and diagram sources take one range and paint it their own way;
    /// only marks that ask for it reach them.
    var marksCode = false
}

@MainActor
enum MarkdownCitationHighlight {
    static func mark(_ text: AttributedString, range: NSRange) -> AttributedString {
        mark(text, marks: [MarkdownTextMark(range: range, background: T3Colors.accent.opacity(0.28))])
    }

    static func mark(_ text: AttributedString, marks: [MarkdownTextMark]) -> AttributedString {
        let plain = String(text.characters)
        var result = text
        for mark in marks {
            guard let stringRange = Range(mark.range, in: plain),
                  let lower = AttributedString.Index(stringRange.lowerBound, within: text),
                  let upper = AttributedString.Index(stringRange.upperBound, within: text) else { continue }
            result[lower..<upper].backgroundColor = mark.background
            if let foreground = mark.foreground { result[lower..<upper].foregroundColor = foreground }
        }
        return result
    }

    static func blocks(_ blocks: [MarkdownRenderedBlock], range: NSRange) -> [MarkdownRenderedBlock] {
        self.blocks(blocks, marks: [MarkdownTextMark(range: range, background: T3Colors.accent.opacity(0.28), marksCode: true)])
    }

    /// Same separators as citationText: newlines between blocks/list items and
    /// table rows, tabs between cells. Cached inline objects are never mutated.
    static func blocks(_ blocks: [MarkdownRenderedBlock], marks: [MarkdownTextMark]) -> [MarkdownRenderedBlock] {
        guard !marks.isEmpty else { return blocks }
        var offset = 0
        func localMarks(_ text: String) -> [MarkdownTextMark] {
            let count = text.utf16.count
            defer { offset += count }
            return marks.compactMap { mark in
                let start = max(offset, mark.range.location), end = min(offset + count, NSMaxRange(mark.range))
                guard end > start else { return nil }
                return MarkdownTextMark(range: NSRange(location: start - offset, length: end - start),
                    background: mark.background, foreground: mark.foreground, marksCode: mark.marksCode)
            }
        }
        func codeRange(_ text: String) -> NSRange? {
            localMarks(text).first(where: \.marksCode)?.range
        }
        func inline(_ value: MarkdownRenderedInline) -> MarkdownRenderedInline {
            let local = localMarks(String(value.attributedText.characters))
            guard !local.isEmpty else { return value }
            return MarkdownRenderedInline(attributedText: mark(value.attributedText, marks: local), style: value.style)
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
                    return .table(MarkdownRenderedTable(header: header, alignments: table.alignments, rows: rows, columnWidths: table.columnWidths, source: table.source))
                case .codeBlock(let language, let code, _, let title, let terminated):
                    return .codeBlock(language: language, code: code, citationRange: codeRange(code), title: title, terminated: terminated)
                case .details(let details):
                    let summary = inline(details.summary)
                    offset += 1
                    return .details(details.replacingSummary(summary).replacingBlocks(walk(details.blocks)))
                case .mermaid(let source, let terminated, _):
                    return .mermaid(source: source, terminated: terminated, citationRange: codeRange(source))
                case .image, .htmlEmbed, .artifactTemplate, .thematicBreak: return block
                }
            }
        }
        return walk(blocks)
    }
}
