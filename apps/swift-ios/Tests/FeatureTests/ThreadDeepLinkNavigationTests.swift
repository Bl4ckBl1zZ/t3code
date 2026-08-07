import XCTest

@testable import T3Code

/// The two handoffs out of the transcript: a file link that opens the file
/// browser on one file, and a changed-files chip that opens the review on one
/// file of a diff. Both cross a screen boundary with a load in between, so what
/// is tested here is what survives that crossing.
final class ThreadDeepLinkNavigationTests: XCTestCase {
    // MARK: - File links

    func testAFileLinkOpensTheFileItNamedRatherThanTheTreeRoot() {
        let entry = FeatureFilesView.deepLinkedEntry(path: "apps/swift-ios/Core/HTTP.swift")

        XCTAssertEqual(entry?.path, "apps/swift-ios/Core/HTTP.swift")
        // The pushed preview is titled with the file name, not the whole path.
        XCTAssertEqual(entry?.name, "HTTP.swift")
        XCTAssertEqual(entry?.kind, .file)
    }

    func testAPathWithNoSegmentsOpensTheTreeRoot() {
        XCTAssertNil(FeatureFilesView.deepLinkedEntry(path: nil))
        XCTAssertNil(FeatureFilesView.deepLinkedEntry(path: ""))
        XCTAssertNil(FeatureFilesView.deepLinkedEntry(path: "//"))
    }

    func testASeparatorOnlySegmentDoesNotSurviveIntoTheEntry() {
        let entry = FeatureFilesView.deepLinkedEntry(path: "/src//app.swift")

        XCTAssertEqual(entry?.path, "src/app.swift")
        XCTAssertEqual(entry?.name, "app.swift")
    }

    func testTheActivityRouteResolvesToAPathAndALineToScrollTo() {
        let route = ThreadActivityFileRoute.build(
            environmentID: "env-1",
            currentThreadID: "thread-1",
            activitySourceThreadID: "thread-parent",
            relativePath: "src/app.swift",
            line: 42
        )

        let destination = FeatureFilesView.destination(for: route)

        XCTAssertEqual(destination.path, "src/app.swift")
        XCTAssertEqual(destination.line, 42)
    }

    func testALinkWithoutAUsableLineOpensTheFileUnscrolled() {
        for line in [nil, 0, -1] as [Int?] {
            let route = ThreadActivityFileRoute.build(
                environmentID: "env-1",
                currentThreadID: "thread-1",
                activitySourceThreadID: "thread-1",
                relativePath: "src/app.swift",
                line: line
            )

            XCTAssertNil(FeatureFilesView.destination(for: route).line)
            XCTAssertEqual(FeatureFilesView.destination(for: route).path, "src/app.swift")
        }
    }

    func testARouteThatNamesNoFileFallsBackToTheTreeRoot() {
        let route = ThreadActivityFileRoute.build(
            environmentID: "env-1",
            currentThreadID: "thread-1",
            activitySourceThreadID: "thread-1",
            relativePath: "/",
            line: 3
        )

        XCTAssertNil(FeatureFilesView.destination(for: route).path)
    }

    func testTheOpenRequestCarriesTheActivitysOwnThread() {
        // Provenance travels with the request so the caller can build the route
        // with it; the route is what decides to scope the file to the thread on
        // screen instead.
        let request = ThreadActivityFileOpenRequest(
            relativePath: "src/app.swift",
            line: 7,
            sourceThreadID: "thread-parent"
        )

        XCTAssertEqual(request.sourceThreadID, "thread-parent")
        XCTAssertEqual(
            ThreadActivityFileRoute.build(
                environmentID: "env-1",
                currentThreadID: "thread-1",
                activitySourceThreadID: request.sourceThreadID ?? "thread-1",
                relativePath: request.relativePath,
                line: request.line
            ).threadID,
            "thread-1"
        )
    }

    // MARK: - Diff links

    @MainActor
    func testAChipOpensTheReviewOnItsFileOnceTheDiffHasParsed() {
        let store = ReviewSelectionStore()

        // The feed arms the checkpoint and the file; the review, presented from
        // a sheet that does not exist yet, spends the file when its diff lands.
        store.openReview(threadID: "thread-1", sectionID: "cp-1", filePath: "src/app.swift")
        store.selectFile("src/app.swift", for: "thread-1")

        XCTAssertNil(store.consumePreselectedFile(for: "thread-1", files: []))
        let target = store.consumePreselectedFile(
            for: "thread-1",
            files: [
                FeatureReviewFile(path: "src/other.swift", change: .modified, additions: 1, deletions: 0),
                FeatureReviewFile(path: "src/app.swift", change: .modified, additions: 2, deletions: 1),
            ]
        )

        XCTAssertEqual(target?.path, "src/app.swift")
        XCTAssertEqual(store.selection(for: "thread-1").sectionID, "cp-1")
    }

    @MainActor
    func testOpeningTheReviewWithoutAFileDisarmsARequestThatWasNeverSpent() {
        let store = ReviewSelectionStore()
        store.openReview(threadID: "thread-1", sectionID: "cp-1", filePath: "src/app.swift")

        // The sheet was dismissed before its diff parsed, so the request is
        // still armed. Opening the review from the menu arms it with nothing,
        // which is what stops the next reader being scrolled to a file they did
        // not ask for.
        store.selectFile(nil, for: "thread-1")

        XCTAssertNil(
            store.consumePreselectedFile(
                for: "thread-1",
                files: [
                    FeatureReviewFile(
                        path: "src/app.swift", change: .modified, additions: 1, deletions: 0
                    ),
                ]
            )
        )
    }
}
