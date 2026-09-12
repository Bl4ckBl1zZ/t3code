import XCTest
@testable import T3Code

@MainActor
final class PullRequestThreadTests: XCTestCase {
    private func comment(_ id: String, body: String = "body") -> PullRequestThreadComment {
        .init(id: id, author: nil, body: body, createdAt: "2026-09-10T00:00:00Z", url: nil)
    }
    private func thread(comments: [PullRequestThreadComment], cursor: String? = "next", resolved: Bool = false) -> PullRequestReviewThread {
        .init(id: "thread", path: "file.swift", line: 4, side: "right", isResolved: resolved, isOutdated: false, comments: comments, commentCount: 12, nextCommentsCursor: cursor)
    }
    func testPageFailureRetainsCursorAndRetryMergesByCommentID() async {
        let model = PullRequestThreadModel(thread: thread(comments: [comment("one")]))
        await model.loadMore { _, _ in throw CocoaError(.fileReadUnknown) }
        XCTAssertEqual(model.cursor, "next"); XCTAssertEqual(model.comments.count, 1)
        await model.loadMore { id, cursor in
            XCTAssertEqual(id, "thread"); XCTAssertEqual(cursor, "next")
            return .init(comments: [self.comment("one", body: "edited"), self.comment("two")], nextCursor: nil)
        }
        XCTAssertEqual(model.comments.map(\.id), ["one", "two"])
        XCTAssertEqual(model.comments.first?.body, "edited")
        XCTAssertNil(model.cursor)
    }
    func testReplyFailurePreservesMarkdownAndSuccessKeepsNewerTyping() async {
        let model = PullRequestThreadModel(thread: thread(comments: []))
        model.reply = "  markdown  "
        let failed = await model.send { _, _ in throw CocoaError(.fileWriteUnknown) }
        XCTAssertFalse(failed); XCTAssertEqual(model.reply, "  markdown  ")
        let saved = await model.send { _, body in XCTAssertEqual(body, "  markdown  "); model.reply = "next reply" }
        XCTAssertTrue(saved); XCTAssertEqual(model.reply, "next reply")
    }
    func testResolutionChangesOnlyAfterAcknowledgementAndCanReopen() async {
        let model = PullRequestThreadModel(thread: thread(comments: []))
        await model.toggleResolution { _, _ in throw CocoaError(.fileWriteUnknown) }
        XCTAssertFalse(model.resolved)
        await model.toggleResolution { _, resolved in XCTAssertTrue(resolved) }
        XCTAssertTrue(model.resolved)
        await model.toggleResolution { _, resolved in XCTAssertFalse(resolved) }
        XCTAssertFalse(model.resolved)
    }
    func testRefreshKeepsLoadedPagesAndUnsentReply() async {
        let model = PullRequestThreadModel(thread: thread(comments: [comment("one")]))
        await model.loadMore { _, _ in .init(comments: [self.comment("two")], nextCursor: nil) }
        model.reply = "unsent"
        model.reconcile(thread(comments: [comment("one", body: "edited")], resolved: true))
        XCTAssertEqual(model.comments.map(\.id), ["one", "two"])
        XCTAssertEqual(model.comments.first?.body, "edited")
        XCTAssertEqual(model.reply, "unsent")
        XCTAssertTrue(model.resolved)
        XCTAssertEqual(model.cursor, "next")
    }
    func testConversationsNeverAttachToAnotherSideOrCommit() {
        let file = FeatureReviewFile(path: "file.swift", change: .modified, additions: 1, deletions: 1, lines: [
            .init(id: "old", kind: .deletion, oldLine: 4, text: "old"),
            .init(id: "new", kind: .addition, newLine: 4, text: "new"),
        ])
        let current = thread(comments: [])
        XCTAssertEqual(PullRequestThreadPlacement.anchor(thread: current, file: file, commit: nil), "new")
        XCTAssertNil(PullRequestThreadPlacement.anchor(thread: current, file: file, commit: "older-commit"))
        let outdated = PullRequestReviewThread(id: "old", path: "file.swift", line: 4, side: "left", isResolved: false, isOutdated: true, comments: [], commentCount: nil, nextCommentsCursor: nil)
        XCTAssertNil(PullRequestThreadPlacement.anchor(thread: outdated, file: file, commit: nil))
        var other = file; other.path = "other.swift"
        XCTAssertNil(PullRequestThreadPlacement.anchor(thread: current, file: other, commit: nil))
    }

    func testCursorLoopStops() async {
        let model = PullRequestThreadModel(thread: thread(comments: []))
        await model.loadMore { _, _ in .init(comments: [], nextCursor: "next") }
        XCTAssertNil(model.cursor)
        XCTAssertNotNil(model.error)
    }
}
