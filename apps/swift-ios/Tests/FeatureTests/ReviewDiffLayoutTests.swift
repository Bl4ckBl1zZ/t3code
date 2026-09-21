import XCTest

@testable import T3Code

/// The diff screen folds unchanged runs around each change and steps between
/// changes. These pin what gets folded, what stays, and how the change cursor
/// moves, so a one-line change in a long file opens on the change.
final class ReviewDiffLayoutTests: XCTestCase {
    func testLongUnchangedRunsFoldAroundAChange() {
        var lines = (1 ... 20).map { context($0) }
        lines.append(FeatureDiffLine(id: "add", kind: .addition, newLine: 21, text: "new"))
        lines += (22 ... 31).map { context($0) }

        let rows = ReviewDiffLayout.rows(for: lines)

        // fold(17) · 3 context · the change · 3 context · fold(7)
        XCTAssertEqual(rows.count, 9)
        guard case let .fold(leading) = rows.first else { return XCTFail("Expected a leading fold") }
        XCTAssertEqual(leading.hiddenCount, 17)
        XCTAssertEqual(rows[4].id, "add")
        guard case let .fold(trailing) = rows.last else { return XCTFail("Expected a trailing fold") }
        XCTAssertEqual(trailing.hiddenCount, 7)
        XCTAssertEqual(ReviewDiffLayout.changeRowIDs(in: rows), ["add"])
    }

    func testAnExpandedFoldShowsEveryLine() {
        var lines = (1 ... 20).map { context($0) }
        lines.append(FeatureDiffLine(id: "add", kind: .addition, newLine: 21, text: "new"))
        let folded = ReviewDiffLayout.rows(for: lines)
        guard case let .fold(fold) = folded.first else { return XCTFail("Expected a leading fold") }

        let expanded = ReviewDiffLayout.rows(for: lines, expanded: [fold.id])
        XCTAssertEqual(expanded.count, lines.count)
    }

    /// Folding a run that would hide a single line costs as much room as it
    /// saves, so short runs between changes stay visible.
    func testShortRunsBetweenChangesStayVisible() {
        var lines = [FeatureDiffLine(id: "del", kind: .deletion, oldLine: 1, text: "old")]
        lines += (2 ... 8).map { context($0) }
        lines.append(FeatureDiffLine(id: "add", kind: .addition, newLine: 9, text: "new"))

        let rows = ReviewDiffLayout.rows(for: lines)
        XCTAssertEqual(rows.count, lines.count)
        XCTAssertEqual(ReviewDiffLayout.changeRowIDs(in: rows), ["del", "add"])
    }

    /// A patch without the full file (a checkpoint) cannot show what lies
    /// between hunks, so it counts the lines and names the enclosing scope.
    func testGapsBetweenHunksCountTheLinesThePatchLeftOut() {
        let lines = [
            FeatureDiffLine(id: "h1", kind: .hunk, text: "@@ -40,3 +40,4 @@ func refresh()"),
            FeatureDiffLine(id: "c1", kind: .context, oldLine: 40, newLine: 40, text: "a"),
            FeatureDiffLine(id: "a1", kind: .addition, newLine: 41, text: "b"),
            FeatureDiffLine(id: "c2", kind: .context, oldLine: 41, newLine: 42, text: "c"),
            FeatureDiffLine(id: "c3", kind: .context, oldLine: 42, newLine: 43, text: "d"),
            FeatureDiffLine(id: "h2", kind: .hunk, text: "@@ -100,2 +101,2 @@"),
            FeatureDiffLine(id: "d1", kind: .deletion, oldLine: 100, text: "e"),
            FeatureDiffLine(id: "a2", kind: .addition, newLine: 101, text: "f"),
        ]

        let rows = ReviewDiffLayout.rows(for: lines)
        guard case let .gap(_, firstCount, heading) = rows.first else { return XCTFail("Expected a gap") }
        XCTAssertEqual(firstCount, 39)
        XCTAssertEqual(heading, "func refresh()")
        let gaps = rows.compactMap { row -> Int? in
            if case let .gap(_, count, _) = row { return count }
            return nil
        }
        XCTAssertEqual(gaps, [39, 57])
        XCTAssertEqual(ReviewDiffLayout.changeRowIDs(in: rows), ["a1", "d1"])
    }

    func testTheChangeCursorStepsAndClamps() {
        var cursor = ReviewChangeCursor(count: 3)
        XCTAssertEqual(cursor.index, 0)
        XCTAssertFalse(cursor.canGoPrevious)
        cursor.goNext()
        cursor.goNext()
        cursor.goNext()
        XCTAssertEqual(cursor.index, 2)
        XCTAssertEqual(cursor.label, "Change 3 of 3")
        XCTAssertFalse(cursor.canGoNext)

        cursor.update(count: 1)
        XCTAssertEqual(cursor.index, 0)
        cursor.update(count: 0)
        XCTAssertNil(cursor.index)
        XCTAssertEqual(cursor.label, "No Changes")
    }

    func testTheCommentChipNamesTheSideOnlyForOldLines() {
        XCTAssertEqual(FeatureReviewLineSelection.chipTitle(for: nil), "Whole file")
        XCTAssertEqual(FeatureReviewLineSelection.chipTitle(for: .init(side: .new, line: 41)), "Line 41")
        XCTAssertEqual(FeatureReviewLineSelection.chipTitle(for: .init(side: .old, line: 41)), "Old line 41")
    }

    func testRenamedRowsSayWhereTheFileCameFrom() {
        let renamedInPlace = FeatureReviewFile(
            path: "src/auth/session.ts", previousPath: "src/auth/token.ts",
            change: .renamed, additions: 0, deletions: 0
        )
        XCTAssertEqual(renamedInPlace.reviewDetail, "src/auth · from token.ts")

        let moved = FeatureReviewFile(
            path: "src/auth/session.ts", previousPath: "lib/session.ts",
            change: .renamed, additions: 0, deletions: 0
        )
        XCTAssertEqual(moved.reviewDetail, "src/auth · from lib/session.ts")
    }

    private func context(_ number: Int) -> FeatureDiffLine {
        FeatureDiffLine(id: "c\(number)", kind: .context, oldLine: number, newLine: number, text: "line \(number)")
    }
}
