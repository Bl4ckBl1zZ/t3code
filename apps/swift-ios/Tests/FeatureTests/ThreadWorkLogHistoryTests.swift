import XCTest
@testable import T3Code

final class ThreadWorkLogHistoryTests: XCTestCase {
    @MainActor func testRecycledGroupsRetainIndependentReaderChoicesAndAnchors() async {
        let store = ThreadWorkLogHistoryStore()
        let first = store.entry("thread:group")
        first.groupExpanded = false
        first.rowExpansion.toggle("tool", expandedByDefault: false)
        first.anchorID = "tool"
        first.offsetWithinAnchor = 172
        let restored = store.entry("thread:group")
        XCTAssertTrue(first === restored)
        XCTAssertEqual(restored.groupExpanded, false)
        XCTAssertTrue(restored.rowExpansion.isExpanded("tool", expandedByDefault: false))
        XCTAssertEqual(restored.anchorID, "tool")
        XCTAssertEqual(restored.offsetWithinAnchor, 172)
        XCTAssertNil(store.entry("another:group").anchorID)
        XCTAssertNil(ThreadWorkLogHistoryStore().entry("thread:group").groupExpanded)
    }

    @MainActor func testLongHistoriesHaveBoundedRetainedState() async {
        let store = ThreadWorkLogHistoryStore(limit: 2)
        let first = store.entry("one")
        first.anchorID = "old"
        let second = store.entry("two")
        _ = store.entry("three")
        XCTAssertTrue(store.entry("two") === second)
        XCTAssertFalse(store.entry("one") === first)
        XCTAssertNil(store.entry("one").anchorID)
    }
}

final class ThreadWorkLogViewportAnchorTests: XCTestCase {
    func testRestoresInsideTheSameToolWhenEarlierRowsChangeHeight() {
        let anchor = ThreadWorkLogViewportAnchor.capture(rows: [
            .init(id: "first", minY: 0, height: 40), .init(id: "tool", minY: 41, height: 600)
        ], contentOffset: 213)
        XCTAssertEqual(anchor, .init(id: "tool", offset: 172))
        XCTAssertEqual(anchor?.restoredOffset(in: .init(id: "tool", minY: 101, height: 600)), 273)
        XCTAssertNil(anchor?.restoredOffset(in: .init(id: "another", minY: 101, height: 600)))
    }

    func testClampsShrinkingRowsAndRejectsInvalidMeasurements() {
        let anchor = ThreadWorkLogViewportAnchor(id: "tool", offset: 172)
        XCTAssertEqual(anchor.restoredOffset(in: .init(id: "tool", minY: 40, height: 50)), 89)
        XCTAssertNil(anchor.restoredOffset(in: .init(id: "tool", minY: 40, height: 0)))
        XCTAssertNil(ThreadWorkLogViewportAnchor.capture(rows: [], contentOffset: 20))
        XCTAssertNil(ThreadWorkLogViewportAnchor.capture(rows: [.init(id: "tool", minY: 0, height: 100)], contentOffset: .nan))
        XCTAssertEqual(ThreadWorkLogViewportAnchor.capture(rows: [.init(id: "tool", minY: 10, height: 100)], contentOffset: -10), .init(id: "tool", offset: 0))
    }
}
