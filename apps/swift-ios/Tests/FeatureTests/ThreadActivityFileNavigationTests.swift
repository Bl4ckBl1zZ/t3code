import XCTest

@testable import T3Code

/// Ports apps/mobile/src/features/threads/threadActivityFileNavigation.test.ts.
final class ThreadActivityFileNavigationTests: XCTestCase {
    func testInheritedActivityFileLinksStayOnTheCurrentlySelectedThread() {
        let route = ThreadActivityFileRoute.build(
            environmentID: "environment",
            currentThreadID: "current-thread",
            activitySourceThreadID: "source-thread",
            relativePath: "apps/mobile/src/index.ts",
            line: 12
        )

        XCTAssertEqual(
            route,
            ThreadActivityFileRoute(
                environmentID: "environment",
                threadID: "current-thread",
                path: ["apps", "mobile", "src", "index.ts"],
                line: "12"
            )
        )
    }

    func testNonPositiveOrMissingLinesAreOmitted() {
        func line(_ value: Int?) -> String? {
            ThreadActivityFileRoute.build(
                environmentID: "environment",
                currentThreadID: "thread",
                activitySourceThreadID: "thread",
                relativePath: "src/main.ts",
                line: value
            ).line
        }

        XCTAssertNil(line(nil))
        XCTAssertNil(line(0))
        XCTAssertNil(line(-3))
        XCTAssertEqual(line(1), "1")
    }

    func testEmptyPathSegmentsAreDropped() {
        let route = ThreadActivityFileRoute.build(
            environmentID: "environment",
            currentThreadID: "thread",
            activitySourceThreadID: "thread",
            relativePath: "/apps//mobile/",
            line: nil
        )
        XCTAssertEqual(route.path, ["apps", "mobile"])
    }
}
