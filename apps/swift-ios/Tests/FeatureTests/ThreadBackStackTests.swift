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

    func testTheTrailRendersAsARootWithTheRestPushed() {
        XCTAssertEqual(ThreadBackStack().route(current: "solo").root, "solo")
        XCTAssertEqual(ThreadBackStack().route(current: "solo").path, [])

        var stack = ThreadBackStack()
        stack.open("agent", from: "parent")
        stack.open("agent-of-agent", from: "agent")
        let route = stack.route(current: "agent-of-agent")
        XCTAssertEqual(route.root, "parent")
        XCTAssertEqual(route.path, ["agent", "agent-of-agent"])
    }

    /// The system's back button and edge swipe write a shorter path; its
    /// length is the trail level now showing.
    func testASystemPopReturnsToTheThreadAtThatLevel() {
        var stack = ThreadBackStack()
        stack.open("b", from: "a")
        stack.open("c", from: "b")
        stack.open("d", from: "c")

        // One level back: path [b, c, d] became [b, c].
        XCTAssertEqual(stack.popTo(level: 2), "c")
        XCTAssertEqual(stack.route(current: "c").path, ["b", "c"])
        // Long-press Back to the root: path became [].
        XCTAssertEqual(stack.popTo(level: 0), "a")
        XCTAssertEqual(stack.route(current: "a").path, [])
        // Nothing left to pop: a write that does not shorten the trail is ignored.
        XCTAssertNil(stack.popTo(level: 0))
        XCTAssertNil(stack.popTo(level: 3))
    }
}
