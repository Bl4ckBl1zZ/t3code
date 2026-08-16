import XCTest

@testable import T3Code

/// The inline patch shown in the activity inspector. The RN client hands the
/// raw diff to a native review surface; here it is parsed, so the parse itself
/// is what has to be right.
final class InlineUnifiedDiffTests: XCTestCase {
    private let patch = """
        diff --git a/apps/web/app.tsx b/apps/web/app.tsx
        index 1234567..89abcde 100644
        --- a/apps/web/app.tsx
        +++ b/apps/web/app.tsx
        @@ -10,4 +10,5 @@ export function App() {
         const value = 1;
        -  return null;
        +  return <div />;
        +  // added
         }
        """

    func testFileHeadersAreDroppedAndHunkHeadersKept() {
        let rows = UnifiedDiffParser.rows(patch)
        XCTAssertEqual(rows.first?.kind, .hunk)
        XCTAssertEqual(rows.first?.text, "@@ -10,4 +10,5 @@ export function App() {")
        XCTAssertEqual(rows.map(\.kind), [
            .hunk, .context, .deletion, .addition, .addition, .context,
        ])
    }

    /// The `+`/`-`/space marker is presentation, not content: it is stripped so
    /// the row can render its own tinted gutter.
    func testMarkersAreStrippedFromRowText() {
        let rows = UnifiedDiffParser.rows(patch)
        XCTAssertEqual(rows[1].text, "const value = 1;")
        XCTAssertEqual(rows[2].text, "  return null;")
        XCTAssertEqual(rows[3].text, "  return <div />;")
    }

    /// Line numbers advance per side: a deletion advances the old side only, an
    /// addition the new side only, context both.
    func testLineNumbersAdvancePerSide() {
        let rows = UnifiedDiffParser.rows(patch)
        XCTAssertEqual(rows[1].oldLine, 10)
        XCTAssertEqual(rows[1].newLine, 10)
        XCTAssertEqual(rows[2].oldLine, 11)
        XCTAssertNil(rows[2].newLine)
        XCTAssertNil(rows[3].oldLine)
        XCTAssertEqual(rows[3].newLine, 11)
        XCTAssertEqual(rows[4].newLine, 12)
        XCTAssertEqual(rows[5].oldLine, 12)
        XCTAssertEqual(rows[5].newLine, 13)
    }

    func testASecondHunkRestartsTheLineCounters() {
        let rows = UnifiedDiffParser.rows(
            """
            @@ -1,1 +1,1 @@
             first
            @@ -100,1 +200,1 @@
             later
            """
        )
        XCTAssertEqual(rows[1].oldLine, 1)
        XCTAssertEqual(rows[3].oldLine, 100)
        XCTAssertEqual(rows[3].newLine, 200)
    }

    /// A blank context line inside a hunk is a real line of the file; only the
    /// empty element a trailing newline produces is dropped.
    func testBlankContextLinesSurviveButATrailingNewlineDoesNot() {
        let rows = UnifiedDiffParser.rows("@@ -1,2 +1,2 @@\n \n context\n")
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[1].kind, .context)
        XCTAssertEqual(rows[1].text, "")
    }

    func testNoNewlineMarkerIsNotAContentLine() {
        let rows = UnifiedDiffParser.rows(
            "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new"
        )
        XCTAssertEqual(rows.map(\.kind), [.hunk, .deletion, .addition])
    }

    func testBinaryAndRenameHeadersProduceNoRows() {
        XCTAssertTrue(
            UnifiedDiffParser.rows(
                """
                diff --git a/logo.png b/logo.png
                index 1111111..2222222 100644
                Binary files a/logo.png and b/logo.png differ
                """
            ).isEmpty
        )
    }

    /// A patch with no hunk header still parses, so a provider that ships bare
    /// +/- lines is readable instead of blank.
    func testAPatchWithoutHunkHeadersStillParses() {
        let rows = UnifiedDiffParser.rows("-old\n+new")
        XCTAssertEqual(rows.map(\.kind), [.deletion, .addition])
        XCTAssertNil(rows[0].oldLine)
        XCTAssertNil(rows[1].newLine)
    }

    func testHunkRangeStartIsReadFromEitherSide() {
        XCTAssertEqual(UnifiedDiffParser.rangeStart("-12,7"), 12)
        XCTAssertEqual(UnifiedDiffParser.rangeStart("+40"), 40)
        XCTAssertNil(UnifiedDiffParser.rangeStart("@@"))
    }
}
