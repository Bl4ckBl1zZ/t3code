import XCTest

@testable import T3Code

final class ThreadBackStackTests: XCTestCase {
    func testBackReturnsThroughEachThreadThatOpenedTheNext() {
        var stack = ThreadBackStack()
        stack.open("agent", from: "parent")
        stack.open("agent-of-agent", from: "agent")
        XCTAssertEqual(stack.parentID, "agent")

        XCTAssertEqual(stack.pop(where: { _ in true }), "agent")
        XCTAssertEqual(stack.pop(where: { _ in true }), "parent")
        // Empty: Back leaves for the list.
        XCTAssertNil(stack.pop(where: { _ in true }))
    }

    func testOpeningTheParentReturnsToItInsteadOfLooping() {
        var stack = ThreadBackStack()
        stack.open("agent", from: "parent")
        // The agent's "Open parent".
        stack.open("parent", from: "agent")
        XCTAssertNil(stack.parentID)

        stack.open("a", from: "root")
        stack.open("b", from: "a")
        stack.open("c", from: "b")
        // A lineage row jumping to an ancestor drops everything above it.
        stack.open("a", from: "c")
        XCTAssertEqual(stack.threadIDs, ["root"])
    }

    func testIgnoresOpeningWithoutACurrentThreadOrTheSameThread() {
        var stack = ThreadBackStack()
        stack.open("agent", from: nil)
        stack.open("parent", from: "parent")
        XCTAssertEqual(stack, ThreadBackStack())
    }

    func testSkipsThreadsDeletedSinceTheyWereLeft() {
        var stack = ThreadBackStack()
        stack.open("b", from: "a")
        stack.open("c", from: "b")
        XCTAssertEqual(stack.pop(where: { $0 != "b" }), "a")
        XCTAssertNil(stack.parentID)
    }

    func testKeepsOnlyTheMostRecentLevels() {
        var stack = ThreadBackStack()
        for index in 0...(ThreadBackStack.limit + 5) {
            stack.open("t\(index + 1)", from: "t\(index)")
        }
        XCTAssertEqual(stack.threadIDs.count, ThreadBackStack.limit)
        XCTAssertEqual(stack.parentID, "t\(ThreadBackStack.limit + 5)")
    }
}
