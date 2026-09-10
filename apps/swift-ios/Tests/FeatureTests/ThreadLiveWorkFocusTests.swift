import XCTest
@testable import T3Code

final class ThreadLiveWorkFocusTests: XCTestCase {
    private func item(_ id: String, run: String = "run", running: Bool = false, success: Bool = true, background: Bool = false, boundary: Bool = false) -> ThreadLiveWorkItem {
        .init(id: id, runID: run, running: running, successful: success, background: background, boundary: boundary)
    }
    func testRunningToolWinsOverLaterConcurrentCompletion() {
        XCTAssertEqual(ThreadLiveWorkFocus.selection(items: [item("running", running: true), item("done")], activeRunID: "run"), "running")
    }
    func testLastSuccessPersistsBetweenMessagesButFailureDoesNot() {
        XCTAssertEqual(ThreadLiveWorkFocus.selection(items: [item("done")], activeRunID: "run"), "done")
        XCTAssertNil(ThreadLiveWorkFocus.selection(items: [item("failed", success: false)], activeRunID: "run"))
    }
    func testBackgroundProcessCannotBecomeTheForegroundFocus() {
        XCTAssertNil(ThreadLiveWorkFocus.selection(items: [item("bg", running: true, background: true)], activeRunID: "run"))
        XCTAssertEqual(ThreadLiveWorkFocus.selection(items: [item("done"), item("bg", running: true, background: true)], activeRunID: "run"), "done")
    }
    func testOtherRunsAndSettledThreadsCannotReviveActivity() {
        XCTAssertNil(ThreadLiveWorkFocus.selection(items: [item("old", run: "old")], activeRunID: "run"))
        XCTAssertNil(ThreadLiveWorkFocus.selection(items: [item("done")], activeRunID: nil))
    }
    func testBoundaryAndEmptyGroupsHaveNoFocus() {
        XCTAssertNil(ThreadLiveWorkFocus.selection(items: [item("compaction", boundary: true), item("done")], activeRunID: "run"))
        XCTAssertNil(ThreadLiveWorkFocus.selection(items: [], activeRunID: "run"))
    }
}
