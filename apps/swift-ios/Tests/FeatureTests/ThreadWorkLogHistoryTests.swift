import XCTest
@testable import T3Code

final class ThreadWorkLogHistoryTests: XCTestCase {
    @MainActor func testRecycledGroupsRetainIndependentReaderChoices() async {
        let store = ThreadWorkLogHistoryStore()
        let first = store.entry("thread:group")
        first.groupExpanded = false
        first.rowExpansion.toggle("tool", expandedByDefault: false)
        let restored = store.entry("thread:group")
        XCTAssertTrue(first === restored)
        XCTAssertEqual(restored.groupExpanded, false)
        XCTAssertTrue(restored.rowExpansion.isExpanded("tool", expandedByDefault: false))
        XCTAssertNil(store.entry("another:group").groupExpanded)
        XCTAssertNil(ThreadWorkLogHistoryStore().entry("thread:group").groupExpanded)
    }

    @MainActor func testLongHistoriesHaveBoundedRetainedState() async {
        let store = ThreadWorkLogHistoryStore(limit: 2)
        let first = store.entry("one")
        first.groupExpanded = true
        let second = store.entry("two")
        _ = store.entry("three")
        XCTAssertTrue(store.entry("two") === second)
        XCTAssertFalse(store.entry("one") === first)
        XCTAssertNil(store.entry("one").groupExpanded)
    }
}
