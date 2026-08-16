import XCTest

@testable import T3Code

/// The checkpoint-scoped review path: turning a checkpoint id into the turn
/// range `orchestration.getTurnDiff` is addressed by, and folding the reply into
/// the shape the working-tree path returns.
///
/// The range is the load-bearing part. An off-by-one shows a reader a diff
/// attributed to the wrong turn, which reads as a success, so the derivation is
/// pinned here against the one the web and React Native clients use
/// (apps/web/src/components/DiffPanel.tsx,
/// apps/mobile/src/features/review/useReviewSections.ts).
final class CheckpointReviewDiffTests: XCTestCase {
    // MARK: - Fixtures

    private func run(id: String, ordinal: Int) -> OrchestrationV2Run {
        OrchestrationV2Run(
            id: id,
            ordinal: ordinal,
            status: "completed",
            providerInstanceId: "codex",
            modelSelection: nil,
            providerThreadId: "provider-thread-1",
            userMessageId: "message-\(ordinal)",
            activeAttemptId: nil,
            queuePosition: nil,
            requestedAt: V2Fixture.timestamp,
            startedAt: V2Fixture.timestamp,
            completedAt: V2Fixture.timestamp
        )
    }

    private func checkpointItem(
        checkpointID: String,
        runID: String,
        threadID: String = "thread-v2"
    ) -> OrchestrationV2TurnItem {
        V2Fixture.turnItem(
            id: "item-\(checkpointID)",
            threadID: threadID,
            type: "checkpoint",
            extra: [
                "runId": .string(runID),
                "checkpointId": .string(checkpointID),
                "scopeId": .string("scope-1"),
                "files": .array([]),
            ]
        )
    }

    private func projection(
        runs: [OrchestrationV2Run],
        items: [OrchestrationV2TurnItem],
        checkpoints: [OrchestrationV2Checkpoint] = [],
        inherited: [OrchestrationV2ProjectedTurnItem] = []
    ) -> OrchestrationV2ThreadProjection {
        OrchestrationV2ThreadProjection(
            thread: V2Fixture.appThread(id: "thread-v2"),
            runs: runs,
            checkpoints: checkpoints,
            turnItems: items,
            visibleTurnItems: items.enumerated().map { index, item in
                OrchestrationV2ProjectedTurnItem(
                    position: index,
                    visibility: .local,
                    sourceThreadId: item.base.threadId,
                    sourceItemId: item.id,
                    item: item
                )
            } + inherited,
            truncatedVisibleItemCount: nil,
            updatedAt: V2Fixture.timestamp
        )
    }

    private func unresolvedReason(
        _ body: @autoclosure () throws -> CheckpointTurnRange
    ) -> CheckpointTurnRangeUnresolved.Reason? {
        do {
            _ = try body()
            return nil
        } catch let failure as CheckpointTurnRangeUnresolved {
            return failure.reason
        } catch {
            return nil
        }
    }

    // MARK: - The derivation

    func testACheckpointResolvesToTheTurnThatCapturedIt() throws {
        // `appRunOrdinal` is stamped from the run's ordinal when the checkpoint
        // is captured, so the third turn's checkpoint is the diff from turn 2 to
        // turn 3 — not from turn 3 to turn 4, and not the whole thread.
        let projection = projection(
            runs: [run(id: "run-1", ordinal: 1), run(id: "run-3", ordinal: 3)],
            items: [checkpointItem(checkpointID: "checkpoint-3", runID: "run-3")]
        )

        let range = try CheckpointTurnRangeResolver.range(
            forCheckpoint: "checkpoint-3",
            in: projection
        )

        XCTAssertEqual(range, CheckpointTurnRange(fromTurnCount: 2, toTurnCount: 3))
        XCTAssertFalse(range.needsFullThreadDiff)
    }

    func testTheFirstTurnGoesThroughTheFullThreadCall() throws {
        // Turn 1's diff starts at the thread's synthetic baseline, which
        // `getTurnDiff` cannot address by ordinal. The range is still 0...1; it
        // is the call that differs.
        let projection = projection(
            runs: [run(id: "run-1", ordinal: 1)],
            items: [checkpointItem(checkpointID: "checkpoint-1", runID: "run-1")]
        )

        let range = try CheckpointTurnRangeResolver.range(
            forCheckpoint: "checkpoint-1",
            in: projection
        )

        XCTAssertEqual(range, CheckpointTurnRange(fromTurnCount: 0, toTurnCount: 1))
        XCTAssertTrue(range.needsFullThreadDiff)
    }

    func testAnInheritedCheckpointRowIsFoundThroughTheProjectedList() throws {
        // The timeline renders `visibleTurnItems`, which can carry rows the
        // thread's own table does not. A row the reader can tap has to be
        // resolvable from the same list it was rendered from.
        let item = checkpointItem(checkpointID: "checkpoint-2", runID: "run-2")
        let projection = projection(
            runs: [run(id: "run-2", ordinal: 2)],
            items: [],
            inherited: [
                OrchestrationV2ProjectedTurnItem(
                    position: 0,
                    visibility: .local,
                    sourceThreadId: "thread-v2",
                    sourceItemId: item.id,
                    item: item
                ),
            ]
        )

        XCTAssertEqual(
            try CheckpointTurnRangeResolver.range(forCheckpoint: "checkpoint-2", in: projection),
            CheckpointTurnRange(fromTurnCount: 1, toTurnCount: 2)
        )
    }

    // MARK: - What cannot be resolved

    func testAnUnknownCheckpointIsReportedRatherThanGuessedAt() {
        let projection = projection(
            runs: [run(id: "run-1", ordinal: 1)],
            items: [checkpointItem(checkpointID: "checkpoint-1", runID: "run-1")]
        )

        XCTAssertEqual(
            unresolvedReason(
                try CheckpointTurnRangeResolver.range(
                    forCheckpoint: "checkpoint-missing",
                    in: projection
                )
            ),
            .unknownCheckpoint
        )
    }

    func testACheckpointWithNoUsableSnapshotIsReportedWithItsStatus() {
        let projection = projection(
            runs: [run(id: "run-1", ordinal: 1)],
            items: [checkpointItem(checkpointID: "checkpoint-1", runID: "run-1")],
            checkpoints: [
                OrchestrationV2Checkpoint(
                    id: "checkpoint-1",
                    scopeId: "scope-1",
                    status: "missing",
                    files: []
                ),
            ]
        )

        XCTAssertEqual(
            unresolvedReason(
                try CheckpointTurnRangeResolver.range(
                    forCheckpoint: "checkpoint-1",
                    in: projection
                )
            ),
            .notReady(status: "missing")
        )
    }

    func testARowProjectedInFromAnotherThreadIsNotScoredAgainstThisThreadsRuns() {
        // The ordinal comes from this projection's run table. Reading it for a
        // row that belongs to another thread would name a real turn number for
        // the wrong thread — the exact mislabelling this path exists to stop.
        let item = checkpointItem(
            checkpointID: "checkpoint-9",
            runID: "run-1",
            threadID: "thread-other"
        )
        let projection = projection(
            runs: [run(id: "run-1", ordinal: 1)],
            items: [],
            inherited: [
                OrchestrationV2ProjectedTurnItem(
                    position: 0,
                    visibility: .inherited,
                    sourceThreadId: "thread-other",
                    sourceItemId: item.id,
                    item: item
                ),
            ]
        )

        XCTAssertEqual(
            unresolvedReason(
                try CheckpointTurnRangeResolver.range(
                    forCheckpoint: "checkpoint-9",
                    in: projection
                )
            ),
            .inheritedFromAnotherThread(sourceThreadID: "thread-other")
        )
    }

    func testACheckpointWhoseRunIsNotInTheProjectionIsReported() {
        let projection = projection(
            runs: [],
            items: [checkpointItem(checkpointID: "checkpoint-1", runID: "run-1")]
        )

        XCTAssertEqual(
            unresolvedReason(
                try CheckpointTurnRangeResolver.range(
                    forCheckpoint: "checkpoint-1",
                    in: projection
                )
            ),
            .runUnavailable
        )
    }

    // MARK: - Section ids

    func testSectionIdsRoundTripSoTheReviewKnowsWhichScopeWasArmed() {
        XCTAssertEqual(
            ReviewSectionID(rawValue: ReviewSectionID.checkpoint(id: "checkpoint-1").rawValue),
            .checkpoint(id: "checkpoint-1")
        )
        XCTAssertEqual(
            ReviewSectionID(rawValue: ReviewSectionID.workingTree.rawValue),
            .workingTree
        )
        // An id from a spelling this build does not know is not silently read as
        // a checkpoint; the review shows — and labels — the working tree.
        XCTAssertNil(ReviewSectionID(rawValue: "turn:4"))
        XCTAssertNil(ReviewSectionID(rawValue: "checkpoint:"))
    }

    // MARK: - The reply, in the review's shape

    @MainActor
    func testATurnDiffParsesIntoTheSameShapeTheWorkingTreePathReturns() {
        let diff = ThreadTurnDiff(
            threadId: "thread-v2",
            fromTurnCount: 2,
            toTurnCount: 3,
            diff: """
            diff --git a/src/app.swift b/src/app.swift
            --- a/src/app.swift
            +++ b/src/app.swift
            @@ -1,2 +1,2 @@
             let a = 1
            -let b = 2
            +let b = 3
            """
        )

        let review = NativeFeatureClient.checkpointReview(diff, cwd: "/workspace")

        XCTAssertEqual(review.title, "Turn 3")
        XCTAssertEqual(review.baseReference, "Turn 2 … turn 3")
        XCTAssertEqual(review.files.map(\.path), ["src/app.swift"])
        XCTAssertEqual(review.additions, 1)
        XCTAssertEqual(review.deletions, 1)
        XCTAssertFalse(review.files[0].lines.isEmpty)
    }

    @MainActor
    func testAFullThreadDiffSaysWhereItStarted() {
        let review = NativeFeatureClient.checkpointReview(
            ThreadTurnDiff(threadId: "thread-v2", fromTurnCount: 0, toTurnCount: 1, diff: ""),
            cwd: "/workspace"
        )

        XCTAssertEqual(review.title, "Turn 1")
        XCTAssertEqual(review.baseReference, "Thread start … turn 1")
        XCTAssertTrue(review.files.isEmpty)
    }

    @MainActor
    func testCheckpointFilesCarryNoWorkingTreeSourceToHydrateFrom() {
        // `review.getDiffFileContents` reads the workspace as it is now. Leaving
        // a source on these files would let the file view quietly re-introduce
        // the bug one screen deeper.
        let review = NativeFeatureClient.checkpointReview(
            ThreadTurnDiff(
                threadId: "thread-v2",
                fromTurnCount: 1,
                toTurnCount: 2,
                diff: """
                diff --git a/src/app.swift b/src/app.swift
                --- a/src/app.swift
                +++ b/src/app.swift
                @@ -1 +1 @@
                -let b = 2
                +let b = 3
                """
            ),
            cwd: "/workspace"
        )

        XCTAssertEqual(review.files.count, 1)
        XCTAssertNil(review.files[0].sourceKind)
        XCTAssertNil(review.files[0].sourceBaseReference)
        XCTAssertNil(review.files[0].sourceHeadReference)
    }
}
