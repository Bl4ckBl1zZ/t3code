import XCTest

@testable import T3Code

/// Ported from apps/web/src/lib/turnDiffTree.ts and the placement web gives a
/// turn's changed files: a tree under the run's reply.
final class ChangedFilesTreeTests: XCTestCase {
    private func file(_ path: String, _ additions: Int, _ deletions: Int, kind: String = "modified") -> OrchestrationV2CheckpointFileSummary {
        OrchestrationV2CheckpointFileSummary(path: path, kind: kind, additions: additions, deletions: deletions)
    }

    private func projected(_ item: OrchestrationV2TurnItem) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: 0, visibility: .local, sourceThreadId: "thread-v2", sourceItemId: item.id, item: item
        )
    }

    private func checkpoint(_ id: String, run: String = "run-1", files: [OrchestrationV2CheckpointFileSummary]) -> OrchestrationV2ProjectedTurnItem {
        projected(V2Fixture.turnItem(id: id, type: "checkpoint", extra: [
            "runId": .string(run),
            "checkpointId": .string("cp-\(id)"),
            "scopeId": .string("scope"),
            "files": .array(files.map { file in
                .object([
                    "path": .string(file.path), "kind": .string(file.kind),
                    "additions": .number(Double(file.additions)), "deletions": .number(Double(file.deletions)),
                ])
            }),
        ]))
    }

    private func reply(_ id: String, run: String = "run-1", text: String = "Done") -> (OrchestrationV2ProjectedTurnItem, FeatureMessage) {
        let item = V2Fixture.turnItem(id: id, type: "assistant_message", extra: [
            "runId": .string(run), "messageId": .string("m-\(id)"), "text": .string(text), "streaming": .bool(false),
        ])
        return (projected(item), FeatureMessage(id: id, role: .assistant, text: text, createdAt: ThreadTimelineDay.date(fromISO8601: V2Fixture.timestamp)!))
    }

    // MARK: - Tree

    func testDirectoriesComeFirstSortNaturallyAndCarryTheirFilesStats() {
        let tree = ChangedFilesTreeNode.build([
            file("README.md", 1, 0),
            file("src/b10.swift", 2, 1),
            file("src/b2.swift", 3, 0),
            file("app/main.swift", 5, 5),
        ])

        XCTAssertEqual(tree.map(\.name), ["app", "src", "README.md"])
        XCTAssertEqual(tree[1].children.map(\.name), ["b2.swift", "b10.swift"])
        XCTAssertEqual(tree[1].additions, 5)
        XCTAssertEqual(tree[1].deletions, 1)
    }

    func testSingleChildDirectoriesCompactIntoOneRow() {
        let tree = ChangedFilesTreeNode.build([
            file("apps/web/src/a.ts", 1, 0),
            file("apps/web/src/b.ts", 1, 0),
            file(#"docs\guide.md"#, 0, 2),
        ])

        XCTAssertEqual(tree.map(\.name), ["apps/web/src", "docs"])
        XCTAssertEqual(tree[0].path, "apps/web/src")
        XCTAssertEqual(tree[0].children.map(\.path), ["apps/web/src/a.ts", "apps/web/src/b.ts"])
        XCTAssertEqual(tree[1].children.first?.path, "docs/guide.md")
    }

    func testOnlyExpandedDirectoriesContributeLines() {
        let tree = ChangedFilesTreeNode.build([
            file("a/x/1.txt", 1, 0), file("a/y/2.txt", 1, 0), file("b/3.txt", 1, 0),
        ])

        let closed = ChangedFilesTreeNode.lines(tree) { _ in false }
        XCTAssertEqual(closed.map(\.node.name), ["a", "b"])

        let open = ChangedFilesTreeNode.lines(tree) { $0 == "a" || $0 == "a/x" }
        XCTAssertEqual(open.map(\.node.name), ["a", "x", "1.txt", "y", "b"])
        XCTAssertEqual(open.map(\.depth), [0, 1, 2, 1, 0])
        XCTAssertTrue(ChangedFilesTreeNode.containsDirectory(tree))
        XCTAssertFalse(ChangedFilesTreeNode.containsDirectory(ChangedFilesTreeNode.build([file("flat.txt", 1, 1)])))
    }

    // MARK: - Placement

    func testTheCheckpointMovesUnderTheRunsLastReply() {
        let (opening, openingMessage) = reply("r1")
        let (final, finalMessage) = reply("r2")
        let (empty, emptyMessage) = reply("r3", text: "")
        let cp = checkpoint("cp", files: [file("a.swift", 3, 1)])

        let entries = ThreadTimelineFeed.entries(
            timelineItems: [opening, final, cp, empty],
            messages: [openingMessage, finalMessage, emptyMessage],
            runs: [LifecycleTimelineRun(id: "run-1", ordinal: 1, providerInstanceID: "codex", model: "m", status: "completed")]
        )

        XCTAssertEqual(entries.map(\.id), ["message:r1", "message:r2", "changed-files:cp"])
        guard case let .structural(.changedFiles(files)) = entries.last else {
            return XCTFail("expected the changed files card, got \(entries.map(\.id))")
        }
        XCTAssertEqual(files.checkpointID, "cp-cp")
        XCTAssertTrue(files.isLatestRun)
        XCTAssertTrue(files.autoExpands)
    }

    /// With no reply to sit under, the change keeps its work-log row rather
    /// than disappearing.
    func testACheckpointWithoutAReplyStaysInTheWorkLog() {
        let (other, otherMessage) = reply("r1", run: "run-2")
        let cp = checkpoint("cp", files: [file("a.swift", 3, 1)])
        let empty = checkpoint("none", files: [])

        let placement = ThreadChangedFilesPlacement.resolve(
            timelineItems: [other, cp, empty], latestRunID: "run-2", rendersMessage: { _ in true }
        )
        XCTAssertTrue(placement.byAssistantItemID.isEmpty)
        XCTAssertTrue(placement.placedCheckpointItemIDs.isEmpty)

        let entries = ThreadTimelineFeed.entries(timelineItems: [other, cp], messages: [otherMessage])
        XCTAssertEqual(entries.map(\.id), ["message:r1", "work:local:thread-v2:cp"])
    }

    func testOnlyASmallChangeInTheLatestRunOpensOnItsOwn() {
        func changed(_ files: [OrchestrationV2CheckpointFileSummary], latest: Bool) -> ThreadChangedFiles {
            ThreadChangedFiles(checkpointID: "c", checkpointItemID: "i", runID: "r", files: files, isLatestRun: latest, date: nil)
        }
        let small = [file("a", 100, 100)]
        XCTAssertTrue(changed(small, latest: true).autoExpands)
        XCTAssertFalse(changed(small, latest: false).autoExpands)
        XCTAssertFalse(changed([file("a", 150, 51)], latest: true).autoExpands)
        XCTAssertFalse(changed((1...6).map { file("f\($0)", 1, 0) }, latest: true).autoExpands)
    }
}
