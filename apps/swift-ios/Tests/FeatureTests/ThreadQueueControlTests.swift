import XCTest

@testable import T3Code

/// Ports packages/client-runtime/src/state/threadWorkflows.test.ts plus the
/// reorder and inline-edit rules of
/// apps/mobile/src/features/threads/QueuedMessageStrip.tsx.
final class ThreadQueueControlTests: XCTestCase {
    private func capabilities(
        queued: Bool = false,
        activeSteer: Bool = false,
        restartSteer: Bool = false
    ) -> ThreadTurnCapabilities {
        ThreadTurnCapabilities(
            supportsActiveSteering: activeSteer,
            supportsSteeringByInterruptRestart: restartSteer,
            supportsQueuedMessages: queued
        )
    }

    private func queue(_ ids: [String]) -> [QueuedThreadRun] {
        ids.enumerated().map { index, id in
            QueuedThreadRun(
                run: ThreadWorkflowRun(id: id, ordinal: index + 1, status: "queued"),
                text: id
            )
        }
    }

    // MARK: Queue state

    func testSortsQueuedMessagesAndGatesReorderAndPromotionFromCapabilities() {
        let state = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [
                ThreadWorkflowRun(
                    id: "active", ordinal: 1, status: "running",
                    providerThreadID: "provider-thread", activeAttemptID: "attempt-active"
                ),
                ThreadWorkflowRun(
                    id: "later", ordinal: 3, status: "queued", userMessageID: "message-later"
                ),
                ThreadWorkflowRun(
                    id: "first", ordinal: 2, status: "queued", queuePosition: 1,
                    userMessageID: "message-first"
                ),
            ],
            providerTurns: [
                ThreadWorkflowProviderTurn(
                    id: "provider-turn-active", runAttemptID: "attempt-active", status: "running"
                )
            ],
            session: ThreadWorkflowSession(
                id: "provider-session",
                status: "running",
                turns: capabilities(queued: true, restartSteer: true)
            ),
            messageTexts: ["message-first": "First", "message-later": "Later"]
        )

        XCTAssertEqual(state.queuedRuns.map(\.run.id), ["first", "later"])
        XCTAssertEqual(state.queuedRuns.map(\.text), ["First", "Later"])
        XCTAssertEqual(state.activeRun?.id, "active")
        XCTAssertTrue(state.canReorder)
        XCTAssertTrue(state.canPromoteToSteer)
    }

    func testShowsOnlyQueuedRunsSoAPromotedHeadLeavesTheStrip() {
        let state = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [
                ThreadWorkflowRun(
                    id: "promoted", ordinal: 2, status: "starting",
                    userMessageID: "message-promoted"
                ),
                ThreadWorkflowRun(
                    id: "still-queued", ordinal: 3, status: "queued", queuePosition: 2,
                    userMessageID: "message-still-queued"
                ),
            ],
            messageTexts: [
                "message-promoted": "Run now", "message-still-queued": "Wait longer",
            ]
        )

        XCTAssertEqual(state.activeRun?.id, "promoted")
        XCTAssertEqual(state.queuedRuns.map(\.run.id), ["still-queued"])
        XCTAssertEqual(state.queuedRuns.map(\.text), ["Wait longer"])
    }

    func testDoesNotPromoteQueuedWorkUntilTheRunningProviderTurnIsProjected() {
        let runs = [
            ThreadWorkflowRun(
                id: "active", ordinal: 1, status: "running", activeAttemptID: "attempt-active"
            ),
            ThreadWorkflowRun(id: "queued", ordinal: 2, status: "queued"),
        ]
        let session = ThreadWorkflowSession(
            id: "session", status: "running", turns: capabilities(queued: true, activeSteer: true)
        )

        let withoutTurn = ThreadWorkflows.deriveQueueWorkflowState(
            runs: runs, providerTurns: [], session: session
        )
        XCTAssertFalse(withoutTurn.canPromoteToSteer)
        XCTAssertTrue(withoutTurn.canReorder)

        let withPendingTurn = ThreadWorkflows.deriveQueueWorkflowState(
            runs: runs,
            providerTurns: [
                ThreadWorkflowProviderTurn(
                    id: "turn", runAttemptID: "attempt-active", status: "pending"
                )
            ],
            session: session
        )
        XCTAssertFalse(withPendingTurn.canPromoteToSteer)
    }

    func testDoesNotExposeUnsupportedQueueActions() {
        let state = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [ThreadWorkflowRun(id: "queued", ordinal: 1, status: "queued")],
            session: ThreadWorkflowSession(id: "session", status: "running", turns: capabilities())
        )
        XCTAssertFalse(state.canReorder)
        XCTAssertFalse(state.canPromoteToSteer)
    }

    func testMissingCapabilityEvidenceIsTreatedAsUnsupportedRatherThanGuessed() {
        let state = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [ThreadWorkflowRun(id: "queued", ordinal: 1, status: "queued")],
            session: nil
        )
        XCTAssertEqual(state.queuedRuns.map(\.run.id), ["queued"])
        XCTAssertFalse(state.canReorder)
        XCTAssertFalse(state.canPromoteToSteer)
    }

    func testAQueuedRunWithoutAProjectedMessageStillRendersALine() {
        let state = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [
                ThreadWorkflowRun(
                    id: "queued", ordinal: 1, status: "queued", userMessageID: "message-windowed"
                )
            ]
        )
        XCTAssertEqual(state.queuedRuns.map(\.text), ["Queued message"])
    }

    func testActiveRunIsTheNewestWorkingRun() {
        XCTAssertEqual(
            ThreadWorkflows.resolveActiveRun(runs: [
                ThreadWorkflowRun(id: "old", ordinal: 1, status: "running"),
                ThreadWorkflowRun(id: "new", ordinal: 2, status: "waiting"),
                ThreadWorkflowRun(id: "queued", ordinal: 3, status: "queued"),
            ])?.id,
            "new"
        )
        XCTAssertNil(
            ThreadWorkflows.resolveActiveRun(runs: [
                ThreadWorkflowRun(id: "done", ordinal: 1, status: "completed")
            ])
        )
    }

    // MARK: Reorder rules

    func testMovingUpAnchorsOnTheRowAbove() {
        let target = ThreadWorkflows.reorderTarget(
            queuedRuns: queue(["a", "b", "c"]), index: 1, direction: .up
        )
        XCTAssertEqual(target?.runID, "b")
        XCTAssertEqual(target?.beforeRunID, "a")
    }

    func testMovingDownAnchorsOnTheRowTwoPlacesAlong() {
        // "Before c" is what puts b below its old neighbour.
        let target = ThreadWorkflows.reorderTarget(
            queuedRuns: queue(["a", "b", "c"]), index: 0, direction: .down
        )
        XCTAssertEqual(target?.runID, "a")
        XCTAssertEqual(target?.beforeRunID, "c")
    }

    func testMovingIntoTheLastSlotHasNoAnchor() {
        let target = ThreadWorkflows.reorderTarget(
            queuedRuns: queue(["a", "b", "c"]), index: 1, direction: .down
        )
        XCTAssertEqual(target?.runID, "b")
        XCTAssertNil(target?.beforeRunID)
    }

    func testTheEndsOfTheQueueRejectTheMoveRatherThanSendingANoOp() {
        let runs = queue(["a", "b", "c"])
        XCTAssertNil(ThreadWorkflows.reorderTarget(queuedRuns: runs, index: 0, direction: .up))
        XCTAssertNil(ThreadWorkflows.reorderTarget(queuedRuns: runs, index: 2, direction: .down))
        XCTAssertNil(ThreadWorkflows.reorderTarget(queuedRuns: runs, index: 9, direction: .up))
        XCTAssertFalse(ThreadWorkflows.canMove(queuedRuns: runs, index: 0, direction: .up))
        XCTAssertTrue(ThreadWorkflows.canMove(queuedRuns: runs, index: 0, direction: .down))
    }

    func testASingleQueuedMessageCannotMoveAtAll() {
        let runs = queue(["only"])
        XCTAssertFalse(ThreadWorkflows.canMove(queuedRuns: runs, index: 0, direction: .up))
        XCTAssertFalse(ThreadWorkflows.canMove(queuedRuns: runs, index: 0, direction: .down))
    }

    // MARK: Merge-back run

    func testMergesTheNewestProviderFinishedRunWhileCheckpointCaptureIsPending() {
        XCTAssertEqual(
            ThreadWorkflows.resolveLatestMergeBackRun(runs: [
                ThreadWorkflowRun(id: "newest-queued", ordinal: 3, status: "queued"),
                ThreadWorkflowRun(id: "older-completed", ordinal: 1, status: "completed"),
                ThreadWorkflowRun(id: "newest-finished", ordinal: 2, status: "waiting"),
            ])?.id,
            "newest-finished"
        )
    }

    func testAStaleCompletedRunLaterInStorageOrderDoesNotHideTheWaitingCheckpoint() {
        XCTAssertEqual(
            ThreadWorkflows.resolveLatestMergeBackRun(runs: [
                ThreadWorkflowRun(id: "newest-finished", ordinal: 2, status: "waiting"),
                ThreadWorkflowRun(id: "older-completed", ordinal: 1, status: "completed"),
            ])?.id,
            "newest-finished"
        )
    }

    func testDoesNotMergeOlderHistoryWhileANewerRunIsStillWorking() {
        for status in ["preparing", "starting", "running"] {
            XCTAssertNil(
                ThreadWorkflows.resolveLatestMergeBackRun(runs: [
                    ThreadWorkflowRun(id: "older-completed", ordinal: 1, status: "completed"),
                    ThreadWorkflowRun(id: "newer-active", ordinal: 2, status: status),
                ]),
                "a \(status) run should block merge-back"
            )
        }
    }

    // MARK: Provider session

    func testResolvesTheSessionBehindTheActiveRunsProviderThread() {
        let session = ThreadWorkflows.resolveProviderSession(
            appThreadID: "thread",
            threadActiveProviderThreadID: "provider-thread-stale",
            runs: [
                ThreadWorkflowRun(
                    id: "active", ordinal: 1, status: "running",
                    providerThreadID: "provider-thread-live"
                )
            ],
            providerThreads: [
                ThreadWorkflowProviderThread(
                    id: "provider-thread-live", appThreadID: "thread",
                    providerSessionID: "session-live"
                ),
                ThreadWorkflowProviderThread(
                    id: "provider-thread-stale", appThreadID: "thread",
                    providerSessionID: "session-stale"
                ),
            ],
            providerSessions: [
                ThreadWorkflowSession(id: "session-stale", status: "stopped"),
                ThreadWorkflowSession(id: "session-live", status: "running"),
            ]
        )
        XCTAssertEqual(session?.id, "session-live")
        XCTAssertTrue(ThreadWorkflows.canDetachProviderSession(session))
    }

    func testFallsBackToTheNewestLiveSessionWhenNoProviderThreadIsAttached() {
        let session = ThreadWorkflows.resolveProviderSession(
            appThreadID: "thread",
            threadActiveProviderThreadID: nil,
            runs: [],
            providerThreads: [],
            providerSessions: [
                ThreadWorkflowSession(id: "session-old", status: "ready"),
                ThreadWorkflowSession(id: "session-error", status: "error"),
            ]
        )
        XCTAssertEqual(session?.id, "session-old")
    }

    func testAStoppedOrErroredSessionOffersNothingToDisconnect() {
        XCTAssertFalse(ThreadWorkflows.canDetachProviderSession(nil))
        XCTAssertFalse(
            ThreadWorkflows.canDetachProviderSession(
                ThreadWorkflowSession(id: "s", status: "stopped")
            )
        )
        XCTAssertFalse(
            ThreadWorkflows.canDetachProviderSession(
                ThreadWorkflowSession(id: "s", status: "error")
            )
        )
        XCTAssertTrue(
            ThreadWorkflows.canDetachProviderSession(
                ThreadWorkflowSession(id: "s", status: "starting")
            )
        )
    }

    // MARK: Queued message strip

    func testPreviewCollapsesToTheFirstNonEmptyLine() {
        XCTAssertEqual(
            QueuedMessagePresentation.preview(
                text: "\n   \n  Fix the flake  \nand then ship", attachmentCount: 0
            ),
            "Fix the flake"
        )
    }

    func testPreviewNamesTheImagesWhenThereIsNoText() {
        XCTAssertEqual(
            QueuedMessagePresentation.preview(text: "   ", attachmentCount: 1), "1 image"
        )
        XCTAssertEqual(
            QueuedMessagePresentation.preview(text: "", attachmentCount: 3), "3 images"
        )
        XCTAssertEqual(
            QueuedMessagePresentation.preview(text: "", attachmentCount: 0), "Queued message"
        )
    }

    func testEmptyingATextOnlyMessageDeletesIt() {
        XCTAssertEqual(
            QueuedMessagePresentation.editOutcome(text: "  \n ", attachmentCount: 0), .delete
        )
    }

    func testEmptyingAMessageWithImagesKeepsItAsASendablePayload() {
        XCTAssertEqual(
            QueuedMessagePresentation.editOutcome(text: "", attachmentCount: 2), .save("")
        )
    }

    func testEditingSavesTheUntrimmedTextTheUserTyped() {
        // Trailing structure can be deliberate in a prompt; only the emptiness
        // test trims.
        XCTAssertEqual(
            QueuedMessagePresentation.editOutcome(text: "ship it\n\n", attachmentCount: 0),
            .save("ship it\n\n")
        )
    }

    func testEstimatedStripHeightIsZeroWithoutRows() {
        XCTAssertEqual(QueuedMessagePresentation.estimatedHeight(messageCount: 0), 0)
        XCTAssertEqual(QueuedMessagePresentation.estimatedHeight(messageCount: 2), 108)
    }

    // MARK: - Wire adapters

    /// The queue reads columns the narrowed types used to leave nil. A run
    /// adapted from the projection has to arrive with them, or the queue can
    /// neither order itself nor name what is waiting.
    func testRunAdapterCarriesTheQueueColumns() {
        let run = Self.decodeRun(
            """
            {
              "id": "run-2",
              "ordinal": 2,
              "status": "queued",
              "providerInstanceId": "claude",
              "modelSelection": { "instanceId": "claude", "model": "opus" },
              "providerThreadId": "pt-1",
              "userMessageId": "msg-9",
              "activeAttemptId": "attempt-3",
              "queuePosition": 1,
              "requestedAt": "2026-07-31T12:00:00.000Z",
              "startedAt": null,
              "completedAt": null
            }
            """
        )

        let adapted = ThreadWorkflowRun(run)
        XCTAssertEqual(adapted.id, "run-2")
        XCTAssertEqual(adapted.ordinal, 2)
        XCTAssertEqual(adapted.status, "queued")
        XCTAssertEqual(adapted.queuePosition, 1)
        XCTAssertEqual(adapted.userMessageID, "msg-9")
        XCTAssertEqual(adapted.providerThreadID, "pt-1")
        XCTAssertEqual(adapted.activeAttemptID, "attempt-3")
    }

    /// Steering needs the join from a provider turn back to the attempt that
    /// asked for it; without it the control can never prove a live turn.
    func testProviderTurnAdapterCarriesTheAttemptJoin() {
        let turn = Self.decode(
            OrchestrationV2ProviderTurn.self,
            """
            { "id": "turn-1", "runAttemptId": "attempt-3", "status": "running" }
            """
        )
        XCTAssertEqual(ThreadWorkflowProviderTurn(turn).runAttemptID, "attempt-3")
    }

    func testProviderThreadAdapterCarriesTheOwningAppThread() {
        let providerThread = Self.decode(
            OrchestrationV2ProviderThread.self,
            """
            {
              "id": "pt-1",
              "providerInstanceId": "claude",
              "providerSessionId": "session-1",
              "appThreadId": "thread-v2",
              "status": "active"
            }
            """
        )
        let adapted = ThreadWorkflowProviderThread(providerThread)
        XCTAssertEqual(adapted.appThreadID, "thread-v2")
        XCTAssertEqual(adapted.providerSessionID, "session-1")
    }

    func testSessionAdapterCarriesTurnCapabilities() {
        let session = Self.decode(
            OrchestrationV2ProviderSession.self,
            """
            {
              "id": "session-1",
              "status": "running",
              "model": null,
              "cwd": null,
              "capabilities": { "turns": { "supportsQueuedMessages": true } }
            }
            """
        )
        let adapted = ThreadWorkflowSession(session)
        XCTAssertEqual(adapted.turns?.supportsQueuedMessages, true)
        XCTAssertEqual(adapted.turns?.supportsActiveSteering, false)
    }

    /// A descriptor written before the capability block reads as "no evidence",
    /// which is not the same as a denial and must stay distinguishable.
    func testSessionAdapterLeavesCapabilitiesAbsentWhenTheServerReportedNone() {
        let session = Self.decode(
            OrchestrationV2ProviderSession.self,
            """
            { "id": "session-1", "status": "running", "model": null, "cwd": null }
            """
        )
        XCTAssertNil(ThreadWorkflowSession(session).turns)
    }

    /// End to end: the adapters feed the derivation the projection's own rows.
    func testAdaptedRunsAndSessionDriveTheQueueState() {
        let queued = Self.decodeRun(
            """
            {
              "id": "run-2", "ordinal": 2, "status": "queued",
              "providerInstanceId": null, "modelSelection": null,
              "providerThreadId": null, "userMessageId": "msg-9",
              "activeAttemptId": null, "queuePosition": 1,
              "requestedAt": "2026-07-31T12:00:00.000Z",
              "startedAt": null, "completedAt": null
            }
            """
        )
        let session = Self.decode(
            OrchestrationV2ProviderSession.self,
            """
            {
              "id": "session-1", "status": "running", "model": null, "cwd": null,
              "capabilities": { "turns": { "supportsQueuedMessages": true } }
            }
            """
        )

        let state = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [ThreadWorkflowRun(queued)],
            session: ThreadWorkflowSession(session),
            messageTexts: ["msg-9": "ship it"]
        )

        XCTAssertEqual(state.queuedRuns.map(\.text), ["ship it"])
        XCTAssertTrue(state.canReorder)
        XCTAssertFalse(state.canPromoteToSteer)
    }

    private static func decodeRun(_ json: String) -> OrchestrationV2Run {
        decode(OrchestrationV2Run.self, json)
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
        try! JSONDecoder.t3.decode(type, from: Data(json.utf8))
    }
}
