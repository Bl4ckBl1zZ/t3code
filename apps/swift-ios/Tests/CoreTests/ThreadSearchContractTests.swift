import XCTest
@testable import T3Code

final class ThreadSearchContractTests: XCTestCase {
    /// Generated from `OrchestrationSearchThreadsResult` by
    /// scripts/generate-swift-contract-fixtures.ts.
    func testTypeScriptSearchResultDecodes() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/threadSearch.json")
        let result = try JSONDecoder().decode(ThreadSearchResult.self, from: Data(contentsOf: url))
        XCTAssertEqual(result.matches.map(\.threadId), ["thread-search-user", "thread-search-agent"])
        XCTAssertEqual(result.matches.map(\.source), [.user, .assistant])
        XCTAssertEqual(result.matches[0].messageCreatedAt, "2026-09-19T10:00:00.000Z")
        XCTAssertNil(result.matches[1].messageCreatedAt)
        XCTAssertTrue(result.matches[1].snippet.hasPrefix("…"))
    }
}
