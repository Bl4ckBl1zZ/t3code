import XCTest
@testable import T3Code

final class PullRequestActionTests: XCTestCase {
    private var fixtureURL: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestActions.json") }
    private func detail(_ changes: [String: Any] = [:]) throws -> PullRequestDetail {
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as! [String: Any]
        var value = fixture["detail"] as! [String: Any]
        for (key, change) in changes { value[key] = change }
        return try JSONDecoder().decode(PullRequestDetail.self, from: JSONSerialization.data(withJSONObject: value))
    }

    func testRepositoryAndViewerNarrowMethods() throws {
        let value = try detail()
        XCTAssertEqual(PullRequestActionLogic.mergeMethods(value), ["squash"])
        XCTAssertEqual(PullRequestActionLogic.updateMethods(value), ["merge"])
        let actions = PullRequestActionLogic.offered(value)
        XCTAssertTrue(actions.contains(.merge)); XCTAssertTrue(actions.contains(.updateBranch))
        XCTAssertTrue(actions.contains(.enableAutoMerge)); XCTAssertFalse(actions.contains(.disableAutoMerge))
    }
    func testReadOnlyViewerGetsNoMutations() throws {
        let value = try detail(["viewerPermissions": ["actions": []]])
        XCTAssertTrue(PullRequestActionLogic.offered(value).isEmpty)
    }
    func testDraftAndConflictStatesDoNotOfferMerge() throws {
        let draft = PullRequestActionLogic.offered(try detail(["isDraft": true]))
        XCTAssertTrue(draft.contains(.ready)); XCTAssertFalse(draft.contains(.draft)); XCTAssertFalse(draft.contains(.merge))
        let conflict = PullRequestActionLogic.offered(try detail(["mergeability": "conflicting"]))
        XCTAssertFalse(conflict.contains(.merge)); XCTAssertFalse(conflict.contains(.updateBranch)); XCTAssertFalse(conflict.contains(.enableAutoMerge))
    }
    func testCloseHasReopenAndMergedHasNoActions() throws {
        XCTAssertEqual(PullRequestActionLogic.offered(try detail(["state": "closed"])), [.reopen])
        XCTAssertEqual(PullRequestActionLogic.offered(try detail(["state": "merged"])), [])
    }
    func testAutoMergeHasAnOffSwitchAndUnknownIsNotOff() throws {
        let enabled = PullRequestActionLogic.offered(try detail(["autoMergeEnabled": true]))
        XCTAssertTrue(enabled.contains(.disableAutoMerge)); XCTAssertFalse(enabled.contains(.enableAutoMerge))
        let unknown = PullRequestActionLogic.offered(try detail(["autoMergeEnabled": NSNull()]))
        XCTAssertFalse(unknown.contains(.disableAutoMerge)); XCTAssertFalse(unknown.contains(.enableAutoMerge))
    }
    func testCurrentBaseHasNoUpdateAction() throws {
        XCTAssertFalse(PullRequestActionLogic.offered(try detail(["baseComparison": "up-to-date"])).contains(.updateBranch))
    }
    func testActionRequestMatchesGeneratedContract() throws {
        struct Fixture: Decodable { let input: PullRequestActionRequest }
        let input = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL)).input
        XCTAssertEqual(input.action, "update-branch"); XCTAssertEqual(input.updateMethod, "merge"); XCTAssertNil(input.mergeMethod)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as! [String: Any]
        XCTAssertNil(encoded["mergeMethod"])
    }
}
