import XCTest
@testable import T3Code

final class PullRequestWorkspaceContractTests: XCTestCase {
    private struct Fixture: Decodable {
        let input: PullRequestListInput
        let result: PullRequestListResult
        let stats: PullRequestListStatsResult
    }

    func testHostIdentityPaginationFiltersAndMeasuredZeroMatchContracts() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestWorkspace.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.input.filters?.labels, [["bug", "docs"]])
        XCTAssertEqual(fixture.input.filters?.excludedLabels, ["wontfix"])
        XCTAssertEqual(fixture.input.cursors, ["github.com owner/repo": "opaque-next"])
        XCTAssertEqual(fixture.result.entries.count, 2)
        XCTAssertEqual(Set(fixture.result.entries.map(\.id)).count, 2)
        XCTAssertEqual(fixture.result.entries[0].reviewDecision, "approved")
        XCTAssertEqual(fixture.result.entries[0].checksState, "passing")
        XCTAssertTrue(fixture.result.truncated)
        XCTAssertEqual(fixture.result.nextCursors, fixture.input.cursors)
        XCTAssertEqual(fixture.result.errors.first?.message, "Host unavailable")
        XCTAssertEqual(fixture.stats.stats.first?.additions, 0)
        XCTAssertEqual(fixture.stats.stats.first?.deletions, 0)
        let roundTrip = try JSONDecoder().decode(PullRequestListInput.self, from: JSONEncoder().encode(fixture.input))
        XCTAssertEqual(roundTrip, fixture.input)
    }
}
