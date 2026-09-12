import XCTest
@testable import T3Code

final class PullRequestReviewContractTests: XCTestCase {
    func testThreadPageMatchesHostContract() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestThread.json")
        let page = try JSONDecoder().decode(PullRequestThreadCommentsResult.self, from: Data(contentsOf: url))
        XCTAssertEqual(page.comments.first?.body, "  Markdown reply  ")
        XCTAssertNil(page.comments.first?.author)
        XCTAssertEqual(page.nextCursor, "opaque/thread/page3")
    }

    func testReviewSubmissionCoordinatesMatchContracts() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestReview.json")
        let submission = try JSONDecoder().decode(PullRequestReviewSubmission.self, from: Data(contentsOf: url))
        XCTAssertEqual(submission.body, "  Markdown  ")
        XCTAssertEqual(submission.comments.map(\.position.kind), ["added", "deleted", "context"])
        XCTAssertEqual(submission.comments.first?.oldPath, "old.swift")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(submission)) as! [String: Any]
        let comments = encoded["comments"] as! [[String: Any]]
        XCTAssertNil((comments[0]["position"] as! [String: Any])["oldLine"])
        XCTAssertNil(comments[1]["oldPath"])
        XCTAssertEqual((comments[2]["position"] as! [String: Any])["side"] as? String, "right")
    }
}
