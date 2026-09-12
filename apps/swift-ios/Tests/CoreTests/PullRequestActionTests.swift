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
    func testWorkflowApprovalRequiresKnownRunsAndBothPermissions() throws {
        let allowed: [String: Any] = ["actions": ["approve-workflows", "revert"], "mergeMethods": [], "diff": false, "comment": false]
        var value = try detail(["capabilities": allowed, "viewerPermissions": allowed, "workflowApprovalsRequired": 2])
        XCTAssertEqual(PullRequestActionLogic.offered(value), [.approveWorkflows])
        value.workflowApprovalsRequired = nil
        XCTAssertTrue(PullRequestActionLogic.offered(value).isEmpty)
        XCTAssertTrue(PullRequestActionLogic.offered(try detail(["workflowApprovalsRequired": 2])).allSatisfy { $0 != .approveWorkflows })
        XCTAssertEqual(PullRequestActionLogic.offered(try detail(["state": "merged", "capabilities": allowed, "viewerPermissions": allowed])), [.revert])
        XCTAssertTrue(NativePullRequestAction.revert.needsReview)
        XCTAssertTrue(NativePullRequestAction.approveWorkflows.needsReview)
    }
    func testWorkflowCheckAndStoredMergeMethodDecode() throws {
        let value = try detail(["autoMergeMethod": "squash", "checks": [["name": "CI", "status": "action-required"]]])
        XCTAssertEqual(value.autoMergeMethod, "squash")
        XCTAssertEqual(value.checks.first?.status, .actionRequired)
        XCTAssertNil(try detail().workflowApprovalsRequired)
    }
    func testHostedReferencePreservesItsTargetAndOmitsAbsentHost() {
        let fields: [String: JSONValue] = ["projectId": .string("frontend"), "repository": .string("acme/backend"), "number": .number(7)]
        XCTAssertEqual(PullRequestWireReference.withHost(nil, fields), fields)
        let hosted = PullRequestWireReference.withHost("GitHub.Example", fields)
        XCTAssertEqual(hosted["host"], .string("github.example"))
        XCTAssertEqual(hosted["repository"], fields["repository"])
    }
    func testActionRequestMatchesGeneratedContract() throws {
        struct Fixture: Decodable { let input: PullRequestActionRequest }
        let input = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL)).input
        XCTAssertEqual(input.action, "update-branch"); XCTAssertEqual(input.updateMethod, "merge"); XCTAssertNil(input.mergeMethod)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as! [String: Any]
        XCTAssertNil(encoded["mergeMethod"])
    }
}
