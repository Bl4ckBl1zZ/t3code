import XCTest
@testable import T3Code

@MainActor
final class PullRequestReviewDraftTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "PullRequestReviewDraftTests.\(UUID())"
        addTeardownBlock { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        return UserDefaults(suiteName: name)!
    }
    private let file = FeatureReviewFile(path: "new.swift", previousPath: "old.swift", change: .renamed, additions: 1, deletions: 1)
    private let line = FeatureDiffLine(id: "line", kind: .addition, newLine: 4, text: "new")

    func testDraftRestoresByScopedKeyAndCarriesRenameCoordinates() {
        let preferences = defaults()
        let draft = PullRequestReviewDraftModel(key: "env/project/repo/42", defaults: preferences)
        draft.summary = "  summary  "
        draft.add(file: file, line: line, body: "  Keep markdown  ")
        let restored = PullRequestReviewDraftModel(key: "env/project/repo/42", defaults: preferences)
        XCTAssertEqual(restored.summary, "  summary  ")
        XCTAssertEqual(restored.comments.first?.comment.oldPath, "old.swift")
        XCTAssertEqual(restored.comments.first?.comment.position.newLine, 4)
        XCTAssertEqual(restored.comments.first?.comment.body, "  Keep markdown  ")
        XCTAssertTrue(PullRequestReviewDraftModel(key: "another-env/project/repo/42", defaults: preferences).comments.isEmpty)
    }

    func testFailureKeepsDraftAndSuccessfulSnapshotLeavesNewerEdits() async {
        let draft = PullRequestReviewDraftModel(key: "test", defaults: defaults())
        draft.summary = "original"
        draft.add(file: file, line: line, body: "first")
        let failed = await draft.submit(verdict: "comment", offered: ["comment"]) { _ in throw CocoaError(.fileWriteUnknown) }
        XCTAssertFalse(failed)
        XCTAssertEqual(draft.summary, "original")
        XCTAssertEqual(draft.comments.count, 1)
        XCTAssertNotNil(draft.error)
        let saved = await draft.submit(verdict: "comment", offered: ["comment"]) { submission in
            XCTAssertEqual(submission.body, "original")
            XCTAssertEqual(submission.comments.count, 1)
            draft.summary = "next review"
            draft.add(file: self.file, line: self.line, body: "second")
        }
        XCTAssertTrue(saved)
        XCTAssertEqual(draft.summary, "next review")
        XCTAssertEqual(draft.comments.map(\.comment.body), ["second"])
        XCTAssertNil(draft.error)
    }

    func testEditingAnInFlightCommentKeepsItsNewerDraft() async {
        let draft = PullRequestReviewDraftModel(key: "test", defaults: defaults())
        draft.add(file: file, line: line, body: "original")
        let id = draft.comments[0].id
        let saved = await draft.submit(verdict: "comment", offered: ["comment"]) { _ in draft.edit(id, body: "revised") }
        XCTAssertTrue(saved)
        XCTAssertEqual(draft.comments.first?.comment.body, "revised")
        XCTAssertEqual(draft.comments.first?.id, id)
    }

    func testUnsupportedEmptyAndOversizedReviewsCannotSubmit() {
        let draft = PullRequestReviewDraftModel(key: "test", defaults: defaults())
        XCTAssertFalse(draft.canSubmit("comment", offered: ["comment"]))
        XCTAssertTrue(draft.canSubmit("approve", offered: ["approve"]))
        XCTAssertFalse(draft.canSubmit("approve", offered: []))
        draft.summary = String(repeating: "😀", count: 32_769)
        XCTAssertFalse(draft.canSubmit("approve", offered: ["approve"]))
        XCTAssertFalse(PullRequestReviewDraftModel.validBody(" \n "))
        draft.add(file: file, line: line, body: " ")
        XCTAssertTrue(draft.comments.isEmpty)
    }

    func testCoordinatesRespectBothSidesAndRejectHunks() {
        XCTAssertNil(PullRequestReviewDraftModel.position(.init(id: "hunk", kind: .hunk, text: "@@")))
        let deleted = PullRequestReviewDraftModel.position(.init(id: "old", kind: .deletion, oldLine: 9, text: "old"))
        XCTAssertEqual(deleted?.kind, "deleted"); XCTAssertEqual(deleted?.oldLine, 9); XCTAssertNil(deleted?.newLine)
        let context = PullRequestReviewDraftModel.position(.init(id: "context", kind: .context, oldLine: 8, newLine: 10, text: "context"))
        XCTAssertEqual(context?.side, "right"); XCTAssertEqual(context?.oldLine, 8); XCTAssertEqual(context?.newLine, 10)
        XCTAssertNil(PullRequestReviewDraftModel.position(.init(id: "invalid", kind: .addition, newLine: 0, text: "x")))
    }

    func testHostAndViewerMustBothOfferVerdict() throws {
        let capabilities = try JSONDecoder().decode(NativePullRequestCapabilities.self, from: Data(#"{"actions":[],"mergeMethods":[],"review":{"inlineComment":true,"reply":true,"resolve":true,"verdicts":["comment","approve","request-changes"]}}"#.utf8))
        let viewer = try JSONDecoder().decode(NativePullRequestViewerPermissions.self, from: Data(#"{"actions":[],"verdicts":["comment","approve"]}"#.utf8))
        XCTAssertEqual(PullRequestReviewDraftModel.verdicts(capabilities: capabilities, viewer: viewer), ["comment", "approve"])
        XCTAssertEqual(PullRequestReviewDraftModel.verdicts(capabilities: capabilities, viewer: nil), [])
    }
}
