import XCTest
@testable import T3Code

@MainActor
final class PullRequestCodeTests: XCTestCase {
    private func page(_ path: String = "src/file.swift", cursor: String? = nil) -> PullRequestDiffResult {
        .init(patch: "diff --git a/\(path) b/\(path)\n--- a/\(path)\n+++ b/\(path)\n@@ -1 +1 @@\n-old\n+new\n", truncated: false, nextCursor: cursor, omittedFileStats: nil)
    }

    func testPagesKeepOpaqueCursorAndReplaceRepeatedFilesWithoutDoubleCounts() async {
        let model = PullRequestCodeModel()
        var requests: [String?] = []
        await model.refresh(commit: "abc") { cursor, commit in
            requests.append(cursor); XCTAssertEqual(commit, "abc"); return self.page(cursor: "opaque/2")
        }
        await model.loadMore(commit: "abc") { cursor, commit in
            requests.append(cursor); XCTAssertEqual(commit, "abc"); return self.page()
        }
        XCTAssertEqual(requests, [nil, "opaque/2"])
        XCTAssertEqual(model.files.count, 1)
        XCTAssertEqual(model.files[0].additions, 1)
        XCTAssertNil(model.nextCursor)
    }

    func testWithheldFilesKeepReportedCountsAndDoNotPretendToHaveHunks() async {
        let model = PullRequestCodeModel()
        await model.refresh(commit: nil) { _, _ in
            .init(patch: "", truncated: true, nextCursor: nil, omittedFileStats: [.init(path: "large.txt", additions: 1200, deletions: 87)])
        }
        XCTAssertTrue(model.truncated)
        XCTAssertEqual(model.files.first?.additions, 1200)
        XCTAssertEqual(model.files.first?.deletions, 87)
        XCTAssertTrue(model.files.first?.lines.isEmpty == true)
    }

    func testNextPageFailurePreservesReadFilesAndCanRetry() async {
        let model = PullRequestCodeModel()
        await model.refresh(commit: nil) { _, _ in self.page(cursor: "next") }
        await model.loadMore(commit: nil) { _, _ in throw CocoaError(.fileReadUnknown) }
        XCTAssertEqual(model.files.count, 1)
        XCTAssertEqual(model.nextCursor, "next")
        XCTAssertNotNil(model.error)
        await model.loadMore(commit: nil) { _, _ in self.page("second.swift") }
        XCTAssertEqual(model.files.count, 2)
        XCTAssertNil(model.error)
    }

    func testRepeatedCursorStopsAnInfinitePageLoop() async {
        let model = PullRequestCodeModel()
        await model.refresh(commit: nil) { _, _ in self.page(cursor: "repeat") }
        await model.loadMore(commit: nil) { _, _ in self.page(cursor: "repeat") }
        XCTAssertNil(model.nextCursor)
        XCTAssertNotNil(model.error)
    }

    func testOldCommitCannotReplaceNewerDiff() async {
        let model = PullRequestCodeModel()
        let started = AsyncStream<Void>.makeStream()
        var suspended: CheckedContinuation<PullRequestDiffResult, Never>?
        let pending = Task { await model.refresh(commit: "old") { _, _ in
            await withCheckedContinuation { suspended = $0; started.continuation.yield(()) }
        } }
        var events = started.stream.makeAsyncIterator(); _ = await events.next()
        await model.refresh(commit: "new") { _, _ in self.page("new.swift") }
        suspended?.resume(returning: page("old.swift"))
        await pending.value
        XCTAssertEqual(model.files.map(\.path), ["new.swift"])
        XCTAssertFalse(model.loading)
        started.continuation.finish()
    }

    func testCodeLinesBeginningWithFileMarkersStayCode() async {
        let model = PullRequestCodeModel()
        await model.refresh(commit: nil) { _, _ in
            .init(patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n--- old\n+++ new\n", truncated: false, nextCursor: nil, omittedFileStats: nil)
        }
        XCTAssertEqual(model.files.first?.path, "a.txt")
        XCTAssertEqual(model.files.first?.lines.filter { $0.kind != .hunk }.map(\.text), ["-- old", "++ new"])
        XCTAssertEqual(model.files.first?.deletions, 1)
    }

    func testTreeFoldsDirectoriesButSearchRevealsMatchingFiles() {
        let files = ["src/deep/a.swift", "src/b.swift", "README.md"].map {
            FeatureReviewFile(path: $0, change: .modified, additions: 1, deletions: 0)
        }
        let folded = PullRequestCodeTreeRow.rows(files: files, collapsed: ["src"], search: "")
        XCTAssertEqual(folded.compactMap(\.file).map(\.path), ["README.md"])
        XCTAssertEqual(folded.filter { $0.file == nil }.map(\.name), ["src"])
        let found = PullRequestCodeTreeRow.rows(files: files, collapsed: ["src"], search: "a.swift")
        XCTAssertEqual(found.compactMap(\.file).map(\.path), ["src/deep/a.swift"])
        XCTAssertTrue(found.filter { $0.file == nil }.allSatisfy(\.expanded))
    }

    func testGitQuotedAndSpaceContainingPathsAreDecoded() async {
        XCTAssertEqual(NativeUnifiedDiffMapper.decodePath(#""a/caf\303\251\tfile.swift""#), "a/café\tfile.swift")
        let model = PullRequestCodeModel()
        await model.refresh(commit: nil) { _, _ in
            .init(patch: "diff --git a/image one.png b/image one.png\nBinary files a/image one.png and b/image one.png differ\n", truncated: true, nextCursor: nil, omittedFileStats: nil)
        }
        XCTAssertEqual(model.files.first?.path, "image one.png")
        XCTAssertEqual(model.files.first?.change, .binary)
    }
}
