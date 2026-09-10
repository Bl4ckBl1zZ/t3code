import Foundation
import SwiftUI
import Testing
@testable import T3Code

@MainActor
struct MarkdownCitationHighlightTests {
    private func inline(_ text: String) -> MarkdownRenderedInline { .init(attributedText: AttributedString(text), style: .body) }
    @Test func nestedListsTablesAndCodeUseTheCitationTextOffsets() throws {
        let original = inline("alpha")
        let tableCell = inline("delta")
        let blocks: [MarkdownRenderedBlock] = [
            .paragraph(original),
            .unorderedList([.init(task: nil, blocks: [.paragraph(inline("beta"))]), .init(task: nil, blocks: [.paragraph(inline("gamma"))])]),
            .table(.init(header: [inline("x")], alignments: [.leading], rows: [[tableCell]], columnWidths: [140])),
            .codeBlock(language: "swift", code: "omega"),
        ]
        let document = MarkdownRenderedDocument(revision: .init("source"), blocks: blocks)
        let text = document.citationText as NSString
        let range = text.range(of: "delta")
        let marked = MarkdownCitationHighlight.blocks(blocks, range: range)
        guard case let .paragraph(preserved) = marked[0], case let .table(table) = marked[2] else { Issue.record("Wrong block layout"); return }
        #expect(preserved === original)
        #expect(table.rows[0][0] !== tableCell)
        #expect(tableCell.attributedText.runs.allSatisfy { $0.backgroundColor == nil })
        #expect(table.rows[0][0].attributedText.runs.contains { $0.backgroundColor != nil })
        let codeMarked = MarkdownCitationHighlight.blocks(blocks, range: text.range(of: "meg"))
        guard case let .codeBlock(language, code, local) = codeMarked[3] else { Issue.record("Missing code block"); return }
        #expect(language == "swift")
        #expect(code == "omega")
        #expect(local == NSRange(location: 1, length: 3))
    }
    @Test func crossBlockQuoteHighlightsOnlyIntersectingInlineCharacters() {
        let blocks: [MarkdownRenderedBlock] = [.paragraph(inline("first")), .paragraph(inline("second"))]
        let marked = MarkdownCitationHighlight.blocks(blocks, range: NSRange(location: 3, length: 5))
        let highlighted = marked.compactMap { block -> String? in
            guard case let .paragraph(value) = block else { return nil }
            return value.attributedText.runs.filter { $0.backgroundColor != nil }.map { String(value.attributedText[$0.range].characters) }.joined()
        }
        #expect(highlighted == ["st", "se"])
    }
}
