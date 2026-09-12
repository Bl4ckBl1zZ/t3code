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
    func testSeparatorOnlyRoutesDoNotBecomeAbsoluteFileLinks() {
        for path in ["", "/", "//", #"\"#, #"C:\"#, "D:/"] {
            let route = ThreadActivityFileRoute.build(environmentID: "env", currentThreadID: "thread",
                activitySourceThreadID: "thread", relativePath: path)
            XCTAssertEqual(route.path, [], path)
            XCTAssertNil(route.absolutePath, path)
        }
    }

    func testHostFilePathsPreserveTheirOriginalIdentity() {
        for path in ["/tmp//image.png", #"C:\Users\me\image.png"#, #"\\host\share\image.png"#] {
            let route = ThreadActivityFileRoute.build(environmentID: "env", currentThreadID: "thread",
                activitySourceThreadID: "thread", relativePath: path, line: 4)
            XCTAssertEqual(route.absolutePath, path)
            XCTAssertEqual(route.path.last, "image.png")
            XCTAssertEqual(route.line, "4")
        }
        XCTAssertEqual(FeatureFilePreviewPath.fileLinkSegments("src//app.swift"), ["src", "app.swift"])
    }

}
