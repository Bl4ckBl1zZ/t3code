import Foundation
import XCTest

@testable import T3Code

private struct StubFailure: LocalizedError {
    let errorDescription: String?
}

/// Ports the row-menu assembly of
/// apps/mobile/src/features/threads/thread-list-v2-items.tsx and the two slow
/// server-side actions in apps/mobile/src/features/home/useThreadListActions.ts.
final class ThreadListActionsTests: XCTestCase {
    // MARK: - Menu

    func testHandoffAndRegenerationSitAboveDeleteInThatOrder() {
        let actions = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(titleRegenerationSupported: true)
        )

        XCTAssertEqual(
            actions.map(\.id),
            [
                "rename",
                "archive",
                "pin",
                "settle",
                "snooze",
                "copy-handoff-script",
                "regenerate-title",
                "delete",
            ]
        )
        // The destructive item stays last however the menu grows.
        XCTAssertEqual(actions.last?.id, "delete")
        XCTAssertTrue(actions.last?.destructive == true)
    }

    func testRegenerationIsOmittedEntirelyOnServersThatWouldRejectIt() {
        let actions = ThreadRowMenuActions.homeRowActions(ThreadRowMenuContext())

        XCTAssertFalse(actions.contains { $0.id == "regenerate-title" })
        XCTAssertTrue(actions.contains { $0.id == "copy-handoff-script" })
    }

    func testRegenerationIsDisabledAndRelabelledWhileOneIsAlreadyInFlight() {
        let actions = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(titleRegenerationSupported: true, isRegeneratingTitle: true)
        )
        let action = actions.first { $0.id == "regenerate-title" }

        XCTAssertEqual(action?.title, "Regenerating…")
        XCTAssertTrue(action?.disabled == true)
    }

    func testArchivedRowsOfferRestoreAndNoLifecycleActions() {
        let actions = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(isArchived: true, titleRegenerationSupported: true)
        )

        XCTAssertEqual(
            actions.map(\.id),
            ["rename", "restore", "copy-handoff-script", "regenerate-title", "delete"]
        )
    }

    func testLifecycleItemsFlipWithTheRowsState() {
        let actions = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(isPinned: true, isSettled: true, isSnoozed: true)
        )

        XCTAssertEqual(
            actions.map(\.id),
            ["rename", "archive", "unpin", "unsettle", "unsnooze", "copy-handoff-script", "delete"]
        )
    }

    func testPinIsAbsentOnServersWithoutPinningAndSnoozeIsDisabledWhileBlocked() {
        let actions = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(canTogglePin: false, canSnooze: false)
        )

        XCTAssertFalse(actions.contains { $0.id == "pin" || $0.id == "unpin" })
        // Present but inert: hiding it would make the menu jump between renders
        // of the same row.
        XCTAssertTrue(actions.first { $0.id == "snooze" }?.disabled == true)
    }

    func testHandoffActionAppendsWhenThereIsNoDeleteToAnchorOn() {
        let actions = ThreadRowMenuActions.withHandoffScriptAction(
            [ThreadRowMenuAction(id: "archive", title: "Archive")]
        )

        XCTAssertEqual(actions.map(\.id), ["archive", "copy-handoff-script"])
    }

    // MARK: - Handoff script

    @MainActor
    func testHandoffScriptHandsBackTheScriptAndItsConfirmation() async {
        let actions = ThreadListActions()

        let outcome = await actions.copyHandoffScript(threadID: "thread-1") { "# Handoff" }

        XCTAssertEqual(
            outcome,
            .handoffScript(
                script: "# Handoff",
                alert: ThreadListActionAlert(
                    title: "Handoff script copied",
                    message: "Paste it into a new agent session to continue this thread."
                )
            )
        )
        XCTAssertFalse(actions.isRunning(threadID: "thread-1"))
    }

    /// Re-entering from inside the first generation is exactly the second tap:
    /// the first request is provably still out, without a second task and the
    /// timing that would come with it.
    @MainActor
    func testASecondTapWhileGenerationIsOutIsIgnoredRatherThanQueued() async {
        let actions = ThreadListActions()
        var generationCount = 0
        var secondTap: ThreadListActionOutcome?

        _ = await actions.copyHandoffScript(threadID: "thread-1") {
            generationCount += 1
            XCTAssertTrue(actions.isRunning(threadID: "thread-1"))
            secondTap = await actions.copyHandoffScript(threadID: "thread-1") {
                generationCount += 1
                return "# Duplicate"
            }
            return "# Handoff"
        }

        XCTAssertEqual(secondTap, .alreadyRunning)
        XCTAssertEqual(generationCount, 1)
        // The key is released once the first finishes, so the row works again.
        XCTAssertFalse(actions.isRunning(threadID: "thread-1"))
    }

    @MainActor
    func testAnotherThreadIsNotBlockedByAThreadWithAGenerationOut() async {
        let actions = ThreadListActions()
        var other: ThreadListActionOutcome?

        _ = await actions.copyHandoffScript(threadID: "thread-1") {
            other = await actions.copyHandoffScript(threadID: "thread-2") { "# Other" }
            return "# Handoff"
        }

        XCTAssertEqual(
            other,
            .handoffScript(
                script: "# Other",
                alert: ThreadListActionAlert(
                    title: "Handoff script copied",
                    message: "Paste it into a new agent session to continue this thread."
                )
            )
        )
    }

    @MainActor
    func testTheInFlightKeyIsReleasedEvenWhenGenerationFails() async {
        let actions = ThreadListActions()

        _ = await actions.copyHandoffScript(threadID: "thread-1") {
            throw StubFailure(errorDescription: "Transcript too large")
        }

        XCTAssertFalse(actions.isRunning(threadID: "thread-1"))
    }

    @MainActor
    func testHandoffFailureQuotesTheServerAndFallsBackWhenItSaysNothing() async {
        let actions = ThreadListActions()

        let quoted = await actions.copyHandoffScript(threadID: "thread-1") {
            throw StubFailure(errorDescription: "Transcript too large")
        }
        let blank = await actions.copyHandoffScript(threadID: "thread-1") {
            throw StubFailure(errorDescription: "   ")
        }

        XCTAssertEqual(
            quoted,
            .failed(
                ThreadListActionAlert(
                    title: "Could not create handoff script",
                    message: "Transcript too large"
                )
            )
        )
        XCTAssertEqual(
            blank,
            .failed(
                ThreadListActionAlert(
                    title: "Could not create handoff script",
                    message: "The handoff script could not be generated."
                )
            )
        )
    }

    // MARK: - Title regeneration

    @MainActor
    func testTitleRegenerationOnlyNeedsTheServersAcknowledgement() async {
        let actions = ThreadListActions()
        var requested = false

        let outcome = await actions.regenerateTitle(threadID: "thread-1", supported: true) {
            requested = true
        }

        XCTAssertEqual(outcome, .titleRegenerationRequested)
        XCTAssertTrue(requested)
    }

    @MainActor
    func testAnUnsupportedServerIsRefusedWithoutTakingTheInFlightSlot() async {
        let actions = ThreadListActions()
        var requested = false

        let refused = await actions.regenerateTitle(threadID: "thread-1", supported: false) {
            requested = true
        }

        XCTAssertEqual(
            refused,
            .unsupported(
                ThreadListActionAlert(
                    title: "Could not regenerate title",
                    message: """
                        This environment's server does not support title regeneration yet. \
                        Update the server to use it.
                        """
                )
            )
        )
        XCTAssertFalse(requested)
        // Refusing must not leave the row wedged: the capability can flip.
        XCTAssertFalse(actions.isRunning(threadID: "thread-1"))
        let retried = await actions.regenerateTitle(threadID: "thread-1", supported: true) {}
        XCTAssertEqual(retried, .titleRegenerationRequested)
    }

    @MainActor
    func testTitleRegenerationFailureQuotesTheServer() async {
        let actions = ThreadListActions()

        let outcome = await actions.regenerateTitle(threadID: "thread-1", supported: true) {
            throw StubFailure(errorDescription: "Thread has no transcript")
        }

        XCTAssertEqual(
            outcome,
            .failed(
                ThreadListActionAlert(
                    title: "Could not regenerate title",
                    message: "Thread has no transcript"
                )
            )
        )
    }
}
