import XCTest
@testable import T3Code

@MainActor
final class PullRequestReactionTests: XCTestCase {
    func testCountsToggleOnlyTheViewerAndRemoveEmptyPills() {
        let base = [PullRequestReaction(content: "heart", count: 2, actors: ["other"], viewerHasReacted: true)]
        let removed = PullRequestReactionLogic.applying(base, changes: ["heart": false])
        XCTAssertEqual(removed.first?.count, 1); XCTAssertFalse(removed.first!.viewerHasReacted)
        XCTAssertEqual(removed.first?.actors, ["other"])
        XCTAssertTrue(PullRequestReactionLogic.applying([.init(content: "heart", count: 1, actors: [], viewerHasReacted: true)], changes: ["heart": false]).isEmpty)
        XCTAssertEqual(PullRequestReactionLogic.applying([], changes: ["eyes": true]).first?.count, 1)
    }
    func testActorNamesNeverExceedTheHostTotalOrDoubleCountViewer() {
        let reaction = PullRequestReaction(content: "heart", count: 2, actors: ["a", "b"], viewerHasReacted: true)
        XCTAssertEqual(PullRequestReactionLogic.actors(reaction), "a, b reacted with heart")
        XCTAssertEqual(PullRequestReactionLogic.actors(.init(content: "eyes", count: 5, actors: ["a"], viewerHasReacted: true)), "You, a, 3 others reacted with eyes")
    }
    func testFailureRollsBackAndSuccessKeepsAcknowledgedStateUntilRefresh() async {
        let model = PullRequestReactionModel(reactions: [])
        await model.toggle("heart", send: { _, _ in throw CocoaError(.fileWriteUnknown) }, refresh: {})
        XCTAssertTrue(model.shown.isEmpty); XCTAssertNotNil(model.error)
        await model.toggle("heart", send: { _, desired in XCTAssertTrue(desired) }, refresh: {})
        XCTAssertEqual(model.shown.first?.count, 1)
        // A failed removal must return to the successful addition, even before the host read lands.
        await model.toggle("heart", send: { _, desired in XCTAssertFalse(desired); throw CocoaError(.fileWriteUnknown) }, refresh: {})
        XCTAssertTrue(model.shown.first?.viewerHasReacted == true)
        model.reconcile([.init(content: "heart", count: 3, actors: ["a", "b"], viewerHasReacted: true)])
        XCTAssertEqual(model.shown.first?.count, 3)
    }
    func testSameReactionCannotRaceItselfWhileInFlight() async {
        let model = PullRequestReactionModel(reactions: [])
        var sent = 0
        await model.toggle("rocket", send: { _, _ in
            sent += 1
            XCTAssertTrue(model.shown.first?.viewerHasReacted == true)
            await model.toggle("rocket", send: { _, _ in sent += 1 }, refresh: {})
        }, refresh: {})
        XCTAssertEqual(sent, 1)
        XCTAssertTrue(model.pending.isEmpty)
    }
}
