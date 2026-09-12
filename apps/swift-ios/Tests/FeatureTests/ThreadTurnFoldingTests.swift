import Foundation
import XCTest
@testable import T3Code

final class ThreadTurnFoldingTests: XCTestCase {
    private let run = ThreadTurnFoldRun(id: "run", status: "completed",
        startedAt: Date(timeIntervalSince1970: 100), completedAt: Date(timeIntervalSince1970: 168))
    private var items: [ThreadTurnFoldItem] {
        [ThreadTurnFoldItem(id: "user", runID: "run", kind: .user),
         ThreadTurnFoldItem(id: "opening", runID: "run", kind: .assistant),
         ThreadTurnFoldItem(id: "work", runID: "run", kind: .work),
         ThreadTurnFoldItem(id: "final", runID: "run", kind: .assistant)]
    }

    func testCompletedRunFoldsOpeningResponseAndWorkButKeepsFinal() throws {
        let fold = try XCTUnwrap(ThreadTurnFolding.folds(items: items, runs: [run]).first)
        XCTAssertEqual(fold.hiddenIDs, ["opening", "work"])
        XCTAssertEqual(fold.anchorID, "opening")
        XCTAssertEqual(fold.label, "Worked for 1m 8s")
        XCTAssertFalse(fold.isExpanded)
    }

    func testUnsettledFailedInterruptedAndUnknownRunsKeepTheirEvidence() {
        for status in ["running", "waiting", "preparing", "queued", "starting", "failed", "interrupted", "cancelled", "rolled_back", "future-status"] {
            XCTAssertTrue(ThreadTurnFolding.folds(items: items,
                runs: [ThreadTurnFoldRun(id: "run", status: status)]).isEmpty, status)
        }
        XCTAssertTrue(ThreadTurnFolding.folds(items: items, runs: [run], interruptedRunIDs: ["run"]).isEmpty)
    }

    func testStreamingAssistantPreventsPrematureFoldAfterCompletionSnapshot() {
        var source = items
        source[1].isLive = true
        XCTAssertTrue(ThreadTurnFolding.folds(items: source, runs: [run]).isEmpty)
    }

    func testBackgroundWorkAndResourceCardsRemainVisible() throws {
        var source = items
        source[2].isLive = true
        source.insert(ThreadTurnFoldItem(id: "child", runID: "run", kind: .persistent), at: 2)
        let fold = try XCTUnwrap(ThreadTurnFolding.folds(items: source, runs: [run]).first)
        XCTAssertEqual(fold.hiddenIDs, ["opening"])
    }

    func testAssistantAttachmentsRemainVisibleAndFinalStillAnchorsTheRun() throws {
        var source = items
        source[1].isPersistent = true
        source[3].isPersistent = true
        let fold = try XCTUnwrap(ThreadTurnFolding.folds(items: source, runs: [run]).first)
        XCTAssertEqual(fold.hiddenIDs, ["work"])
    }

    func testExpansionRetainsStableFoldIdentityAndContent() throws {
        let folded = try XCTUnwrap(ThreadTurnFolding.folds(items: items, runs: [run]).first)
        let expanded = try XCTUnwrap(ThreadTurnFolding.folds(items: items, runs: [run], expandedRunIDs: ["run"]).first)
        XCTAssertEqual(expanded.id, folded.id)
        XCTAssertEqual(expanded.hiddenIDs, folded.hiddenIDs)
        XCTAssertTrue(expanded.isExpanded)
        XCTAssertEqual(expanded.label, folded.label)
    }

    func testMissingRunOrMissingFinalResponseDoesNotHideWork() {
        XCTAssertTrue(ThreadTurnFolding.folds(items: items, runs: []).isEmpty)
        XCTAssertTrue(ThreadTurnFolding.folds(items: items.filter { $0.kind != .assistant }, runs: [run]).isEmpty)
    }

    func testRunsKeepIndependentOrderAndExpansion() {
        let source = items + [ThreadTurnFoldItem(id: "second-opening", runID: "second", kind: .assistant),
            ThreadTurnFoldItem(id: "second-final", runID: "second", kind: .assistant)]
        let folds = ThreadTurnFolding.folds(items: source,
            runs: [ThreadTurnFoldRun(id: "second", status: "completed"), run], expandedRunIDs: ["second"])
        XCTAssertEqual(folds.map(\.runID), ["run", "second"])
        XCTAssertEqual(folds.map(\.isExpanded), [false, true])
    }
}
