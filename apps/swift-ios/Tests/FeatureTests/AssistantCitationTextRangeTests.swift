import Foundation
import Testing
@testable import T3Code

struct AssistantCitationTextRangeTests {
    private func find(_ source: String, _ quote: String, start: Int = 0, end: Int = 0, prefix: String = "", suffix: String = "") -> NSRange? {
        AssistantCitationTextRange.resolve(in: source, quote: quote, start: start, end: end, prefix: prefix, suffix: suffix)
    }
    @Test func normalizedWhitespaceMapsBackToOriginalUTF16() throws {
        let source = "before\n\n  quoted\t text\nafter"
        let range = try #require(find(source, "quoted text", start: 7, end: 18, prefix: "before ", suffix: " after"))
        #expect((source as NSString).substring(with: range) == "quoted\t text")
    }
    @Test func uniqueTextCanRecoverFromShiftedOffsetsAndContext() throws {
        let source = "new introduction · original quote · changed ending"
        let range = try #require(find(source, "original quote", start: 0, end: 14, prefix: "old prefix", suffix: "old suffix"))
        #expect((source as NSString).substring(with: range) == "original quote")
    }
    @Test func contextDisambiguatesRepeatedText() throws {
        let source = "first quote middle second quote end"
        let range = try #require(find(source, "quote", prefix: "second ", suffix: " end"))
        #expect(range.location == (source as NSString).range(of: "quote", options: .backwards).location)
    }
    @Test func ambiguousRepeatedContextIsNotGuessedEvenAtSavedOffset() {
        #expect(find("x quote y x quote y", "quote", start: 2, end: 7, prefix: "x ", suffix: " y") == nil)
        #expect(find("quote and quote", "quote") == nil)
    }
    @Test func unicodeSurrogatesKeepWholeEmoji() throws {
        let source = "前\n\n👩🏽‍💻 says hello"
        let range = try #require(find(source, "👩🏽‍💻 says"))
        #expect((source as NSString).substring(with: range) == "👩🏽‍💻 says")
        #expect(Range(range, in: source) != nil)
    }
    @Test func missingAndWhitespaceOnlyQuotesAreUnresolved() {
        #expect(find("body", "missing") == nil)
        #expect(find("body", " \n ") == nil)
        #expect(find("", "body") == nil)
    }
    @Test func oversizedOrNegativeOffsetsRecoverOnlyUniqueText() {
        #expect(find("body", "body", start: Int.max, end: Int.max) == NSRange(location: 0, length: 4))
        #expect(find("body", "body", start: -1, end: 4) == NSRange(location: 0, length: 4))
    }
}
