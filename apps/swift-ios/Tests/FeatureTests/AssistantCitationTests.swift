import Foundation
import Testing
@testable import T3Code

struct AssistantCitationTests {
    private let link = "t3-citation://v1/environment%2Fremote/thread%3Aone/assistant%3Fone?text=Use+%60cache%5Bkey%5D%60+%F0%9F%9A%80&start=0&end=19&prefix=&suffix=&comment=Why%3F"

    @Test func webLinkRoundTripsExactly() throws {
        let citation = try #require(AssistantCitation.parse(link))
        #expect(citation.environmentId == "environment/remote")
        #expect(citation.text == "Use `cache[key]` 🚀")
        #expect(citation.comment == "Why?")
        #expect(citation.href == link)
        #expect(AssistantCitation.matches(in: citation.marker).first?.citation == citation)
    }

    @Test func refusesAmbiguousOrOversizedLinks() {
        #expect(AssistantCitation.parse(link + "&comment=duplicate") == nil)
        #expect(AssistantCitation.parse(link + "#fragment") == nil)
        #expect(AssistantCitation.parse(link.replacingOccurrences(of: "&end=19", with: "&end=0")) == nil)
        #expect(AssistantCitation.parse(link.replacingOccurrences(of: "Why%3F", with: String(repeating: "a", count: 8001))) == nil)
        #expect(AssistantCitation.parse(link.replacingOccurrences(of: "environment%2Fremote", with: "%ZZ")) == nil)
    }

    @Test func voiceEditsKeepQuoteDataWithoutMovingTheVisibleCaret() throws {
        let citation = try #require(AssistantCitation.parse(link))
        let stored = "Explain " + citation.marker
        let edited = AssistantCitation.replacingPlainText(in: stored, with: "Explain this")
        #expect(AssistantCitation.removingMarkers(from: edited) == "Explain this")
        #expect(AssistantCitation.matches(in: edited).first?.citation == citation)
        let next = AssistantCitation.replacingPlainText(in: edited, with: "Explain this now")
        #expect(AssistantCitation.removingMarkers(from: next) == "Explain this now")
        let match = try #require(AssistantCitation.matches(in: stored).first)
        var updated = citation
        updated.comment = "Updated"
        let moved = "Prefix " + stored
        let replaced = AssistantCitation.replacing(match, in: moved, with: updated)
        #expect(AssistantCitation.matches(in: replaced).first?.citation.comment == "Updated")
        #expect(replaced.hasPrefix("Prefix Explain "))
        #expect(AssistantCitation.replacing(match, in: moved, with: nil) == "Prefix Explain ")
    }

    @Test func selectionUsesNormalizedUTF16AndPreservesQuotedLineBreaks() throws {
        let source = "Before.\nUse 🚀\n  carefully.\nAfter."
        let raw = source as NSString
        let range = raw.range(of: "Use 🚀\n  carefully.")
        let citation = try #require(AssistantCitation.capture(text: source, range: range, environmentId: "e", threadId: "t", messageId: "m"))
        #expect(citation.text == "Use 🚀\n  carefully.")
        #expect(citation.prefix == "Before. ")
        #expect(citation.suffix == " After.")
        #expect(citation.start == 8)
        #expect(citation.end == 25)
        #expect(AssistantCitation.parse(citation.href) == citation)
        #expect(AssistantCitation.capture(text: "🚀", range: NSRange(location: 0, length: 1), environmentId: "e", threadId: "t", messageId: "m") == nil)
    }
}
