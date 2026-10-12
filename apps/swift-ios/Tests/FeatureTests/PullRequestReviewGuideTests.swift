import XCTest
@testable import T3Code

/// Mirrors `packages/client-runtime/src/reviewGuideTour.test.ts` and upstream
/// mobile's `reviewGuideState.test.ts` / `guideDiffFocus.test.ts`.
@MainActor
final class PullRequestReviewGuideTests: XCTestCase {
    private static let patch = """
    diff --git a/src/tray.ts b/src/tray.ts
    --- a/src/tray.ts
    +++ b/src/tray.ts
    @@ -10,5 +10,6 @@ function tray()
     const a = 1;
    -const size = pick();
    +const size = "xs";
    +const variant = "tray";
     const b = 2;
     const c = 3;
     const d = 4;
    @@ -40,3 +41,2 @@ function footer()
     keep();
    -dropped();
     tail();

    """

    private var lines: [FeatureDiffLine] {
        let source = ReviewDiffSource(id: "guide", kind: "pull-request", title: "Pull request", baseRef: nil, headRef: nil,
            diff: Self.patch, diffHash: "", truncated: false)
        return NativeUnifiedDiffMapper.parseDiff(source)[0].lines
    }

    private func excerpt(_ side: String, _ start: Int, _ end: Int, path: String = "src/tray.ts") -> PullRequestReviewGuideExcerpt {
        PullRequestReviewGuideExcerpt(path: path, side: side, start: start, end: end, caption: "")
    }

    private let guide = PullRequestReviewGuide(headSha: "old-head", generatedAt: "2026-10-11T00:00:00.000Z", stops: [])

    // MARK: - Tour

    func testSteppingHoldsTheTourToItsFirstAndLastStops() {
        XCTAssertEqual(PullRequestReviewGuideTour.step(0, by: -1, stopCount: 3), 0)
        XCTAssertEqual(PullRequestReviewGuideTour.step(0, by: 1, stopCount: 3), 1)
        XCTAssertEqual(PullRequestReviewGuideTour.step(2, by: 1, stopCount: 3), 2)
    }

    func testStopFilesReadExcerptsFirstThenOwnedFilesOnce() {
        let stop = PullRequestReviewGuideStop(title: "Stop",
            excerpts: [excerpt("new", 1, 2, path: "b.ts"), excerpt("new", 5, 6, path: "a.ts"), excerpt("new", 9, 9, path: "b.ts")],
            files: [.init(path: "c/d.ts", note: nil), .init(path: "a.ts", note: "again")])
        XCTAssertEqual(PullRequestReviewGuideTour.filePaths(stop), ["b.ts", "a.ts", "c/d.ts"])
        XCTAssertEqual(PullRequestReviewGuideTour.subline(stop), "b.ts +2")
        XCTAssertEqual(PullRequestReviewGuideTour.subline(PullRequestReviewGuideStop(title: "Intro")), "Context, no code")
    }

    func testAnExcerptStartingOnAnAdditionBringsTheLinesItReplaced() {
        let shown = PullRequestReviewGuideTour.excerptLines(lines, excerpt: excerpt("new", 11, 12))
        XCTAssertEqual(shown.map(\.kind), [.deletion, .addition, .addition])
    }

    func testAnOldSideExcerptSelectsRemovedLinesAndStopsAtTheHunk() {
        let shown = PullRequestReviewGuideTour.excerptLines(lines, excerpt: excerpt("old", 41, 41))
        XCTAssertEqual(shown.map(\.kind), [.deletion])
        XCTAssertEqual(shown.first?.oldLine, 41)
    }

    func testAnExcerptSpanningHunksKeepsTheHunkHeaderAsTheGap() {
        let shown = PullRequestReviewGuideTour.excerptLines(lines, excerpt: excerpt("old", 14, 42))
        XCTAssertEqual(shown.map(\.kind), [.context, .hunk, .context, .deletion, .context])
    }

    func testAnExcerptOutsideTheDiffShowsNothing() {
        XCTAssertTrue(PullRequestReviewGuideTour.excerptLines(lines, excerpt: excerpt("new", 100, 120)).isEmpty)
    }

    func testDiffFocusMatchesItsOwnSideOnly() {
        let lines = lines
        let old = PullRequestReviewGuideTour.focusedLineIDs(lines, focus: .init(side: "old", start: 11, end: 12))
        XCTAssertEqual(lines.filter { old.contains($0.id) }.map(\.kind), [.deletion, .context])
        let new = PullRequestReviewGuideTour.focusedLineIDs(lines, focus: .init(side: "new", start: 41, end: 42))
        XCTAssertEqual(lines.filter { new.contains($0.id) }.map(\.text), ["keep();", "tail();"])
        XCTAssertTrue(PullRequestReviewGuideTour.focusedLineIDs(lines, focus: nil).isEmpty)
    }

    func testNotesAreLetteredInGuideOrderAndPinnedToTheirExcerpt() {
        let a = excerpt("new", 1, 5, path: "a.ts"), b = excerpt("new", 10, 12, path: "b.ts")
        let stop = PullRequestReviewGuideStop(title: "Stop", excerpts: [a, b], notes: [
            .init(path: "b.ts", line: 11, title: "First", body: ""),
            .init(path: "a.ts", line: 2, title: "Second", body: ""),
            .init(path: "a.ts", line: 2, title: "Third", body: ""),
            .init(path: "c.ts", line: 1, title: "Unanchored", body: ""),
        ])
        XCTAssertEqual(PullRequestReviewGuideTour.letteredNotes(stop).map(\.marker), ["A", "B", "C", "D"])
        XCTAssertEqual(PullRequestReviewGuideTour.markers(stop, excerpt: a), [2: ["B", "C"]])
        XCTAssertEqual(PullRequestReviewGuideTour.markers(stop, excerpt: b), [11: ["A"]])
        XCTAssertEqual(PullRequestReviewGuideTour.noteMarker(26), "27")
    }

    // MARK: - State

    func testAPreviousGuideStaysReadableDuringARewrite() {
        let state = PullRequestReviewGuideState(.init(guide: guide, run: .running(headSha: "new-head", startedAt: guide.generatedAt), currentHeadSha: "new-head"))
        XCTAssertEqual(state.guide, guide)
        XCTAssertTrue(state.stale)
        XCTAssertTrue(state.running)
        XCTAssertNil(state.failure)
    }

    func testAnUnknownHeadIsNotStale() {
        XCTAssertFalse(PullRequestReviewGuideState(.init(guide: guide, run: nil, currentHeadSha: nil)).stale)
    }

    func testOnlyFailuresForTheCurrentHeadShow() {
        let run = PullRequestReviewGuideRun.failed(headSha: "old-head", failedAt: guide.generatedAt, detail: "The writer disconnected.")
        XCTAssertEqual(PullRequestReviewGuideState(.init(guide: nil, run: run, currentHeadSha: "old-head")).failure, "The writer disconnected.")
        XCTAssertNil(PullRequestReviewGuideState(.init(guide: nil, run: run, currentHeadSha: "new-head")).failure)
    }

    func testNothingLoadedClaimsNoRun() {
        let state = PullRequestReviewGuideState(nil)
        XCTAssertNil(state.guide)
        XCTAssertFalse(state.running || state.stale)
        XCTAssertNil(state.failure)
    }

    // MARK: - Notice

    private func notice(_ data: PullRequestReviewGuideResult?, running: Bool = false, startError: String? = nil, error: String? = nil) -> PullRequestReviewGuideNotice.Kind {
        PullRequestReviewGuideNotice(data: data, running: running, startError: startError, error: error).kind
    }

    func testNoticeDoesNotFlashEmptyBeforeTheFirstAnswer() {
        XCTAssertEqual(notice(nil), .loading)
        XCTAssertEqual(notice(.init(guide: nil, run: nil, currentHeadSha: "head")), .empty)
        XCTAssertEqual(notice(.init(guide: guide, run: nil, currentHeadSha: guide.headSha)), .ready)
    }

    func testARetryHidesThePreviousFailureAtOnce() {
        let data = PullRequestReviewGuideResult(guide: nil, run: .failed(headSha: "head", failedAt: guide.generatedAt, detail: "Writer disconnected"), currentHeadSha: "head")
        XCTAssertEqual(notice(data), .failed)
        XCTAssertEqual(notice(data, running: true), .writing)
    }

    func testAStaleGuideStaysReadableThroughRewritingAndCompletion() {
        let data = PullRequestReviewGuideResult(guide: guide, run: nil, currentHeadSha: "head")
        XCTAssertEqual(notice(data), .stale)
        XCTAssertEqual(notice(data, running: true), .writing)
        let rewritten = PullRequestReviewGuide(headSha: "head", generatedAt: guide.generatedAt, stops: [])
        XCTAssertEqual(notice(.init(guide: rewritten, run: nil, currentHeadSha: "head")), .ready)
    }

    func testAFailedReadIsNotAFailedWriter() {
        XCTAssertEqual(notice(nil, error: "Connection lost"), .unavailable)
        XCTAssertEqual(notice(nil, startError: "Not allowed", error: "Connection lost"), .failed)
    }

    // MARK: - Model

    func testAServerThatPredatesGuidesHidesTheTab() async {
        let model = PullRequestReviewGuideModel(number: 7, access: .init(isEnabled: { true },
            load: { _ in throw RPCError.unsupportedMethod("pullRequests.reviewGuide") },
            generate: { _ in throw RPCError.unsupportedMethod("pullRequests.generateReviewGuide") }))
        await model.refresh()
        XCTAssertTrue(model.unsupported)
    }

    func testARefreshFailureKeepsTheGuideOnScreen() async {
        var fails = false
        let result = PullRequestReviewGuideResult(guide: guide, run: nil, currentHeadSha: guide.headSha)
        let model = PullRequestReviewGuideModel(number: 7, access: .init(isEnabled: { true },
            load: { _ in if fails { throw RPCError.disconnected }; return result },
            generate: { _ in result }))
        await model.refresh()
        fails = true
        await model.refresh()
        XCTAssertEqual(model.data, result)
        XCTAssertFalse(model.unsupported)
        XCTAssertEqual(model.notice.kind, .unavailable)
    }

    func testStopFilesReadDiffPagesUntilTheyArrive() async {
        let model = PullRequestReviewGuideModel(number: 7, access: .init(isEnabled: { true },
            load: { _ in .init(guide: nil, run: nil, currentHeadSha: "head") }, generate: { _ in throw CancellationError() }))
        await model.refresh()
        var cursors: [String?] = []
        let pages: [String?: (String, String?)] = [nil: ("a.ts", "p2"), "p2": ("b.ts", "p3"), "p3": ("c.ts", nil)]
        await model.loadFiles(["b.ts"]) { cursor, _ in
            cursors.append(cursor)
            let (path, next) = pages[cursor]!
            return .init(patch: "diff --git a/\(path) b/\(path)\n--- a/\(path)\n+++ b/\(path)\n@@ -1 +1 @@\n-old\n+new\n",
                truncated: false, nextCursor: next, omittedFileStats: nil)
        }
        XCTAssertEqual(cursors, [nil, "p2"])
        XCTAssertNotNil(model.file("b.ts"))
        XCTAssertNil(model.file("c.ts"))
    }

    // MARK: - Contract

    func testGuideResultDecodesTheGeneratedContract() throws {
        struct Fixture: Decodable { let ready: PullRequestReviewGuideResult; let failed: PullRequestReviewGuideResult }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CoreTests/Fixtures/pullRequestReviewGuide.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let stop = try XCTUnwrap(fixture.ready.guide?.stops.first)
        XCTAssertEqual(stop.attention?.kind, "contract")
        XCTAssertEqual(stop.excerpts.first?.side, "new")
        XCTAssertEqual(stop.files.first?.note, "Generated")
        XCTAssertNil(stop.files.last?.note)
        XCTAssertEqual(stop.notes.first?.line, 12)
        XCTAssertEqual(stop.questions, ["Should this be configurable?"])
        XCTAssertEqual(fixture.ready.run, .running(headSha: "def456", startedAt: "2026-10-11T00:05:00.000Z"))
        XCTAssertEqual(fixture.ready.currentHeadSha, "def456")
        XCTAssertNil(fixture.failed.guide)
        XCTAssertEqual(fixture.failed.run, .failed(headSha: "abc123", failedAt: "2026-10-11T00:06:00.000Z", detail: "The writer disconnected."))
        XCTAssertEqual(try JSONDecoder().decode(PullRequestReviewGuideResult.self, from: JSONEncoder().encode(fixture.ready)), fixture.ready)
    }
}
