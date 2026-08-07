import XCTest

@testable import T3Code

/// Ports the review deep-link state of
/// apps/mobile/src/features/review/reviewState.ts, the preselected-file effect
/// in ReviewSheet.tsx and the section fallback in useReviewSections.ts.
final class ReviewSelectionTests: XCTestCase {
    private func file(path: String, previousPath: String? = nil) -> FeatureReviewFile {
        FeatureReviewFile(
            path: path,
            previousPath: previousPath,
            change: previousPath == nil ? .modified : .renamed,
            additions: 1,
            deletions: 0
        )
    }

    // MARK: - Preselected file

    func testScrollsToThePreselectedFileOnceTheDiffHasParsed() {
        var state = ReviewSelectionState()
        state.selectFile("src/app.swift", for: "thread-1")

        // The review has the request before it has the diff, and must not spend
        // it against a section that has not parsed yet.
        XCTAssertNil(state.consumePreselectedFile(for: "thread-1", files: []))
        XCTAssertEqual(state.selection(for: "thread-1").filePath, "src/app.swift")

        let target = state.consumePreselectedFile(
            for: "thread-1",
            files: [file(path: "src/other.swift"), file(path: "src/app.swift")]
        )

        XCTAssertEqual(target?.path, "src/app.swift")
    }

    func testThePreselectionIsSpentExactlyOnce() {
        var state = ReviewSelectionState()
        state.selectFile("src/app.swift", for: "thread-1")
        let files = [file(path: "src/app.swift")]

        XCTAssertNotNil(state.consumePreselectedFile(for: "thread-1", files: files))
        // Every later parse re-runs this; a request that survived would fight
        // the user's own scrolling.
        XCTAssertNil(state.consumePreselectedFile(for: "thread-1", files: files))
        XCTAssertNil(state.selection(for: "thread-1").filePath)
    }

    func testAPathThatIsNotInThisDiffIsClearedRatherThanLeftToRetrigger() {
        var state = ReviewSelectionState()
        state.selectFile("src/missing.swift", for: "thread-1")

        XCTAssertNil(
            state.consumePreselectedFile(for: "thread-1", files: [file(path: "src/app.swift")])
        )
        XCTAssertNil(state.selection(for: "thread-1").filePath)
    }

    func testARenameResolvesFromEitherSideOfTheRename() {
        var state = ReviewSelectionState()
        state.selectFile("src/old.swift", for: "thread-1")

        let target = state.consumePreselectedFile(
            for: "thread-1",
            files: [file(path: "src/new.swift", previousPath: "src/old.swift")]
        )

        XCTAssertEqual(target?.path, "src/new.swift")
    }

    func testSelectionsAreKeyedByThreadSoOneReviewCannotSpendAnothers() {
        var state = ReviewSelectionState()
        state.selectFile("src/app.swift", for: "thread-1")

        XCTAssertNil(
            state.consumePreselectedFile(for: "thread-2", files: [file(path: "src/app.swift")])
        )
        XCTAssertEqual(state.selection(for: "thread-1").filePath, "src/app.swift")
    }

    // MARK: - Section fallback

    func testKeepsAStillPresentSectionAndFallsBackWhenItDisappears() {
        var state = ReviewSelectionState()
        state.selectSection("turn:4", for: "thread-1")

        XCTAssertEqual(
            state.resolveSelectedSection(
                for: "thread-1",
                availableSectionIDs: ["git", "turn:4"]
            ),
            "turn:4"
        )
        // The checkpoint scrolled out of the window: showing nothing would be
        // worse than showing the first section.
        XCTAssertEqual(
            state.resolveSelectedSection(for: "thread-1", availableSectionIDs: ["git", "turn:9"]),
            "git"
        )
        XCTAssertEqual(state.selection(for: "thread-1").sectionID, "git")
    }

    func testAnUnsetSectionResolvesToTheFirstOne() {
        var state = ReviewSelectionState()

        XCTAssertEqual(
            state.resolveSelectedSection(for: "thread-1", availableSectionIDs: ["git", "turn:1"]),
            "git"
        )
    }

    func testNoSectionsYetLeavesTheStoredChoiceAloneForThemToArrive() {
        var state = ReviewSelectionState()
        state.selectSection("turn:4", for: "thread-1")

        XCTAssertEqual(
            state.resolveSelectedSection(for: "thread-1", availableSectionIDs: []),
            "turn:4"
        )
        XCTAssertEqual(state.selection(for: "thread-1").sectionID, "turn:4")
    }

    // MARK: - Lifetime

    func testASpentSelectionLeavesNothingBehind() {
        var state = ReviewSelectionState()
        state.selectFile("src/app.swift", for: "thread-1")
        _ = state.consumePreselectedFile(for: "thread-1", files: [file(path: "src/app.swift")])

        // Nothing is pointed at, so nothing is retained: the store is
        // app-lifetime and would otherwise grow one entry per thread visited.
        XCTAssertTrue(state.selectionsByThreadID.isEmpty)
    }

    func testForgettingAThreadDropsItsSelection() {
        var state = ReviewSelectionState()
        state.selectSection("turn:4", for: "thread-1")
        state.selectSection("turn:2", for: "thread-2")

        state.forget(threadID: "thread-1")

        XCTAssertNil(state.selection(for: "thread-1").sectionID)
        XCTAssertEqual(state.selection(for: "thread-2").sectionID, "turn:2")
    }

    // MARK: - Store

    @MainActor
    func testOpeningTheReviewFromAChangedFilesRowArmsBothHalves() {
        let store = ReviewSelectionStore()

        store.openReview(threadID: "thread-1", sectionID: "turn:4", filePath: "src/app.swift")

        XCTAssertEqual(
            store.selection(for: "thread-1"),
            ReviewSelection(sectionID: "turn:4", filePath: "src/app.swift")
        )
    }

    @MainActor
    func testOpeningTheRowItselfDisarmsAnyFileLeftOverFromAChipTap() {
        let store = ReviewSelectionStore()
        store.openReview(threadID: "thread-1", sectionID: "turn:4", filePath: "src/stale.swift")

        // A checkpoint that has not reached "ready" has no section yet, so the
        // review keeps whatever it had and falls back from there.
        store.openReview(threadID: "thread-1", sectionID: nil, filePath: nil)

        XCTAssertEqual(store.selection(for: "thread-1"), ReviewSelection(sectionID: "turn:4"))
    }
}
