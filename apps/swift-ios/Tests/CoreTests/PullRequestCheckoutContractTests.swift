import XCTest
@testable import T3Code

final class PullRequestCheckoutContractTests: XCTestCase {
    func testPreparedWorktreeMatchesHostContract() throws {
        struct Input: Decodable { let mode: PullRequestCheckoutMode; let threadId: String }
        struct Fixture: Decodable { let input: Input; let result: PullRequestCheckoutResult }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestCheckout.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.input.mode, .worktree)
        XCTAssertEqual(fixture.input.threadId, "checkout-thread")
        XCTAssertEqual(fixture.result.worktreePath, "/repo.worktrees/pr-3")
        XCTAssertEqual(fixture.result.isOnPullRequestHead, false)
    }
}
