import XCTest
@testable import T3Code

final class PullRequestEditingTests: XCTestCase {
    private var url: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestActions.json") }
    private func detail() throws -> PullRequestDetail {
        struct Fixture: Decodable { let detail: PullRequestDetail }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).detail
    }
    func testOwnershipAndHostSupportNarrowEditing() throws {
        var subject = try detail()
        XCTAssertTrue(PullRequestEditingLogic.canEditChangeRequest(subject))
        subject.viewerPermissions = nil
        XCTAssertTrue(PullRequestEditingLogic.canEditChangeRequest(subject))
        subject.viewer = "another-person"
        XCTAssertFalse(PullRequestEditingLogic.canEditChangeRequest(subject))
        subject.viewer = " OCTOCAT "
        XCTAssertTrue(PullRequestEditingLogic.canEditChangeRequest(subject))
        subject.capabilities?.edit = nil
        XCTAssertFalse(PullRequestEditingLogic.canEditChangeRequest(subject))
    }
    func testOnlyOwnRemarksCanBeEditedAndReviewsAreExcluded() throws {
        let subject = try detail()
        XCTAssertTrue(PullRequestEditingLogic.canEditComment(detail: subject, author: subject.author, kind: "issue-comment"))
        XCTAssertTrue(PullRequestEditingLogic.canEditComment(detail: subject, author: subject.author, kind: "review-comment"))
        XCTAssertFalse(PullRequestEditingLogic.canEditComment(detail: subject, author: subject.author, kind: "review"))
        XCTAssertFalse(PullRequestEditingLogic.canEditComment(detail: subject, author: nil, kind: "issue-comment"))
        XCTAssertFalse(PullRequestEditingLogic.canEditComment(detail: subject, author: .init(login: "someone-else", name: nil, avatarUrl: nil), kind: "issue-comment"))
    }
    func testClearingDescriptionIsAllowedButEmptyTitleAndCommentAreNot() {
        XCTAssertTrue(PullRequestTextEdit.description("old").valid(""))
        XCTAssertFalse(PullRequestTextEdit.title("old").valid(" \n "))
        XCTAssertFalse(PullRequestTextEdit.newComment.valid(" \n "))
        XCTAssertFalse(PullRequestTextEdit.title("").valid(String(repeating: "😀", count: 513)))
        XCTAssertTrue(PullRequestTextEdit.description("").valid("  markdown  "))
    }
    func testSparseUpdatesMatchContractsWithoutClobberingOtherFields() throws {
        struct Fixture: Decodable { let titleUpdate: PullRequestTextUpdate; let clearDescription: PullRequestTextUpdate }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.titleUpdate.title, "New title"); XCTAssertNil(fixture.titleUpdate.body)
        XCTAssertEqual(fixture.clearDescription.body, ""); XCTAssertNil(fixture.clearDescription.title)
        let titleJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.titleUpdate)) as! [String: Any]
        let bodyJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.clearDescription)) as! [String: Any]
        XCTAssertNil(titleJSON["body"]); XCTAssertNil(bodyJSON["title"])
    }
}
