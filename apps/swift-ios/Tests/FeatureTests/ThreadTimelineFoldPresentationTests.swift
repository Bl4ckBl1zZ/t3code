import XCTest
@testable import T3Code

final class ThreadTimelineFoldPresentationTests: XCTestCase {
    private func fixture() -> (FeatureThreadDetail, [ThreadTimelineEntry]) {
        let messages = ["opening", "interim", "final"].enumerated().map { index, id in
            FeatureMessage(id: id, role: .assistant, text: id,
                createdAt: Date(timeIntervalSince1970: Double(index) * 86_400), wireMessageID: "wire-" + id)
        }
        let projected = messages.enumerated().map { index, message in
            OrchestrationV2ProjectedTurnItem(position: index, visibility: .local,
                sourceThreadId: "thread", sourceItemId: message.id,
                item: V2Fixture.assistantMessage(id: message.id, text: message.text, streaming: false))
        }
        let detail = FeatureThreadDetail(thread: FeatureThread(id: "thread", projectID: "project", title: "Thread"),
            messages: messages, timelineItems: projected,
            workflow: FeatureThreadWorkflow(runs: [ThreadWorkflowRun(id: "run-1", ordinal: 0, status: "completed")]))
        let entries: [ThreadTimelineEntry] = messages.flatMap { message in
            [.dayDivider(id: "day-" + message.id, date: message.createdAt), .message(message)]
        }
        return (detail, entries)
    }

    func testCollapsedMessagesHaveCitationTargetsWithoutOrphanDayDividers() {
        let (detail, entries) = fixture()
        let result = ThreadTimelineFoldPresentation.apply(entries: entries, detail: detail,
            expandedRunIDs: [], alwaysExpand: false)
        XCTAssertEqual(result.entries.map(\.id), ["day-opening", "turn-fold:run-1", "day-final", "message:final"])
        XCTAssertEqual(result.hiddenCitationRunIDs["wire-opening"], "run-1")
        XCTAssertEqual(result.hiddenCitationRunIDs["opening"], "run-1")
        XCTAssertNil(result.hiddenCitationRunIDs["wire-final"])
    }

    func testExpandedRunsRestoreSeparateRecycledMessageRows() {
        let (detail, entries) = fixture()
        let result = ThreadTimelineFoldPresentation.apply(entries: entries, detail: detail,
            expandedRunIDs: ["run-1"], alwaysExpand: false)
        XCTAssertEqual(result.entries.map(\.id), ["day-opening", "turn-fold:run-1", "message:opening", "day-interim", "message:interim", "day-final", "message:final"])
        XCTAssertTrue(result.hiddenCitationRunIDs.isEmpty)
        guard case let .turnFold(fold) = result.entries[1] else { return XCTFail("Missing expansion control") }
        XCTAssertTrue(fold.isExpanded)
    }

    func testAlwaysExpandedPreferenceLeavesOriginalFeedUntouched() {
        let (detail, entries) = fixture()
        let result = ThreadTimelineFoldPresentation.apply(entries: entries, detail: detail,
            expandedRunIDs: [], alwaysExpand: true)
        XCTAssertEqual(result.entries, entries)
        XCTAssertTrue(result.hiddenCitationRunIDs.isEmpty)
    }
}
