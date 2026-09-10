import XCTest
@testable import T3Code

@MainActor
final class PullRequestReviewerTests: XCTestCase {
    private struct Fixture: Decodable { let list: PullRequestReviewerCandidateList; let input: PullRequestReviewerRequest }
    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestReviewers.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }
    func testContractDistinguishesUserAndTeamIDsAndKeepsOpaqueRequestID() throws {
        let fixture = try fixture()
        XCTAssertEqual(Set(fixture.list.candidates.map(\.key)).count, 2)
        XCTAssertEqual(fixture.input.reviewers.first?.id, "17")
        XCTAssertEqual(fixture.input.reviewers.first?.kind, "team")
        XCTAssertFalse(fixture.input.requested)
        XCTAssertTrue(fixture.list.truncated)
    }
    func testSearchMatchesReturnedNamesWithoutReplacingHostIDs() async throws {
        let fixture = try fixture(), model = PullRequestReviewerModel()
        await model.load { fixture.list }
        XCTAssertEqual(model.matching(" MOBILE ").map(\.key), ["team:17"])
        XCTAssertEqual(model.matching("octo").map(\.key), ["user:17"])
        XCTAssertTrue(model.truncated)
        let success = await model.toggle(fixture.list.candidates[1]) { request in
            XCTAssertEqual(request.reviewers.first?.id, "17")
            XCTAssertEqual(request.reviewers.first?.kind, "team")
            XCTAssertFalse(request.requested)
        }
        XCTAssertTrue(success)
        XCTAssertFalse(model.candidates[1].isRequested)
    }
    func testFailureKeepsRequestedStateAndRetryCanReverseIt() async throws {
        let fixture = try fixture(), model = PullRequestReviewerModel()
        await model.load { fixture.list }
        let failed = await model.toggle(fixture.list.candidates[1]) { _ in throw CocoaError(.fileWriteUnknown) }
        XCTAssertFalse(failed); XCTAssertTrue(model.candidates[1].isRequested); XCTAssertNil(model.pending)
        let saved = await model.toggle(fixture.list.candidates[1]) { _ in }
        XCTAssertTrue(saved); XCTAssertFalse(model.candidates[1].isRequested)
        let askedAgain = await model.toggle(model.candidates[1]) { XCTAssertTrue($0.requested) }
        XCTAssertTrue(askedAgain); XCTAssertTrue(model.candidates[1].isRequested)
    }
    func testCandidateRefreshFailureKeepsAcknowledgedState() async throws {
        let fixture = try fixture(), model = PullRequestReviewerModel()
        await model.load { fixture.list }
        _ = await model.toggle(fixture.list.candidates[0]) { _ in }
        await model.load { throw CocoaError(.fileReadUnknown) }
        XCTAssertTrue(model.candidates[0].isRequested)
        XCTAssertNotNil(model.error)
    }
}
