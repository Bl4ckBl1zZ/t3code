import XCTest
@testable import T3Code

final class PullRequestFullContextTests: XCTestCase {
    func testRequestsPreserveCommitAndRenameSides() {
        let file = FeatureReviewFile(path: "new.swift", previousPath: "old.swift", change: .renamed, additions: 2, deletions: 1)
        let input = PullRequestFullContext.input(file: file, commit: "abc123")
        XCTAssertEqual(input?.oldPath, "old.swift"); XCTAssertEqual(input?.newPath, "new.swift")
        XCTAssertEqual(input?.changeType, "rename-changed"); XCTAssertEqual(input?.commit, "abc123")
        var pure = file; pure.additions = 0; pure.deletions = 0
        XCTAssertEqual(PullRequestFullContext.input(file: pure, commit: nil)?.changeType, "rename-pure")
        var binary = file; binary.change = .binary
        XCTAssertNil(PullRequestFullContext.input(file: binary, commit: nil))
    }
    func testOmittedHunksNeverBecomeAnInventedUnchangedDiff() {
        let file = FeatureReviewFile(path: "file.swift", change: .modified, additions: 50, deletions: 30)
        XCTAssertNil(PullRequestFullContext.lines(file: file, contents: .init(oldContents: "old\n", newContents: "new\n")))
    }
    func testFullContextPreservesChangedCoordinates() {
        let file = FeatureReviewFile(path: "file.swift", change: .modified, additions: 1, deletions: 1, lines: [
            .init(id: "before", kind: .context, oldLine: 2, newLine: 2, text: "before"),
            .init(id: "old", kind: .deletion, oldLine: 3, text: "old"),
            .init(id: "new", kind: .addition, newLine: 3, text: "new"),
            .init(id: "after", kind: .context, oldLine: 4, newLine: 4, text: "after"),
        ])
        let lines = PullRequestFullContext.lines(file: file, contents: .init(oldContents: "top\nbefore\nold\nafter\nbottom\n", newContents: "top\nbefore\nnew\nafter\nbottom\n"))!
        XCTAssertEqual(lines.first?.text, "top")
        XCTAssertEqual(lines.last?.text, "bottom")
        XCTAssertEqual(lines.first { $0.kind == .deletion }?.oldLine, 3)
        XCTAssertEqual(lines.first { $0.kind == .addition }?.newLine, 3)
    }
    func testChangedHostContentsCannotBeSplicedIntoOlderHunks() {
        let file = FeatureReviewFile(path: "file.swift", change: .modified, additions: 1, deletions: 1, lines: [
            .init(id: "old", kind: .deletion, oldLine: 1, text: "old"),
            .init(id: "new", kind: .addition, newLine: 1, text: "new"),
        ])
        XCTAssertTrue(PullRequestFullContext.matchesPatch(file: file, contents: .init(oldContents: "old\n", newContents: "new\n")))
        XCTAssertFalse(PullRequestFullContext.matchesPatch(file: file, contents: .init(oldContents: "old\n", newContents: "newer revision\n")))
        XCTAssertFalse(PullRequestFullContext.matchesPatch(file: file, contents: .init(oldContents: "", newContents: "new\n")))
    }

    func testAddedAndDeletedFilesUseTheirOwnVersion() {
        let added = FeatureReviewFile(path: "new.swift", change: .added, additions: 1, deletions: 0)
        let lines = PullRequestFullContext.lines(file: added, contents: .init(oldContents: "", newContents: "new\n"))!
        XCTAssertEqual(lines.map(\.kind), [.addition]); XCTAssertEqual(lines.first?.newLine, 1)
        let deleted = FeatureReviewFile(path: "old.swift", change: .deleted, additions: 0, deletions: 1)
        let old = PullRequestFullContext.lines(file: deleted, contents: .init(oldContents: "old\n", newContents: ""))!
        XCTAssertEqual(old.map(\.kind), [.deletion]); XCTAssertEqual(old.first?.oldLine, 1)
    }
}
