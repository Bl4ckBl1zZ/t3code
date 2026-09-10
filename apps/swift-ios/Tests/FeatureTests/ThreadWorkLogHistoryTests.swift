import XCTest
@testable import T3Code

final class ThreadWorkLogHistoryTests: XCTestCase {
    @MainActor func testRecycledGroupsRetainIndependentReaderChoicesAndAnchors() async {
        let store = ThreadWorkLogHistoryStore()
        let first = store.entry("thread:group")
        first.groupExpanded = false
        first.rowExpansion.toggle("tool", expandedByDefault: false)
        first.anchorID = "tool"
        let restored = store.entry("thread:group")
        XCTAssertTrue(first === restored)
        XCTAssertEqual(restored.groupExpanded, false)
        XCTAssertTrue(restored.rowExpansion.isExpanded("tool", expandedByDefault: false))
        XCTAssertEqual(restored.anchorID, "tool")
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
