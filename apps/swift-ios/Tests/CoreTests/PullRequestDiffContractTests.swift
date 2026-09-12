import XCTest
@testable import T3Code

final class PullRequestDiffContractTests: XCTestCase {
    func testHostFileContentsContractKeepsVersionAndRenameScope() throws {
        struct Fixture: Decodable { let fileInput: PullRequestDiffFileInput; let fileContents: PullRequestDiffFileContents }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestDiff.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.fileInput.changeType, "rename-changed")
        XCTAssertEqual(fixture.fileInput.oldPath, "old.swift")
        XCTAssertEqual(fixture.fileInput.newPath, "new.swift")
        XCTAssertEqual(fixture.fileInput.commit, "abc123")
        XCTAssertEqual(fixture.fileContents.oldContents, "old\n")
        XCTAssertEqual(fixture.fileContents.newContents, "new\n")
    }

    func testPagedDiffDecodesTheGeneratedHostContract() throws {
        struct Fixture: Decodable { let result: PullRequestDiffResult }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestDiff.json")
        let result = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).result
        XCTAssertTrue(result.truncated)
        XCTAssertEqual(result.nextCursor, "opaque/last")
        XCTAssertEqual(result.omittedFileStats?.first?.path, "large.txt")
        XCTAssertEqual(result.omittedFileStats?.first?.additions, 1200)
        XCTAssertEqual(result.omittedFileStats?.first?.deletions, 87)
        XCTAssertEqual(try JSONDecoder().decode(PullRequestDiffResult.self, from: JSONEncoder().encode(result)), result)
    }
}
