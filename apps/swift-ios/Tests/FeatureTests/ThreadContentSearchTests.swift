import XCTest
@testable import T3Code

final class ThreadContentSearchTests: XCTestCase {
    func testQueriesShorterThanTheServerMinimumAreNotSent() {
        XCTAssertNil(ThreadContentSearch.normalizedQuery(""))
        XCTAssertNil(ThreadContentSearch.normalizedQuery("  a  "))
        XCTAssertEqual(ThreadContentSearch.normalizedQuery("  ab "), "ab")
        XCTAssertEqual(ThreadContentSearch.normalizedQuery(String(repeating: "x", count: 300))?.count, 200)
    }

    func testExcerptEmphasisesEveryOccurrenceRegardlessOfCase() {
        let excerpt = HomeThreadSearchExcerpt(
            match: FeatureThreadSearchMatch(source: .user, snippet: "Varchar(191) or varchar(512)?"),
            query: "varchar"
        )
        XCTAssertEqual(excerpt.speaker, "You:")
        XCTAssertEqual(excerpt.highlightedRanges.map { String(excerpt.match.snippet[$0]) }, ["Varchar", "varchar"])
        let none = HomeThreadSearchExcerpt(match: excerpt.match, query: "missing")
        XCTAssertTrue(none.highlightedRanges.isEmpty)
    }
}
