import Foundation
import XCTest

@testable import T3Code

private struct StubFailure: LocalizedError {
    let errorDescription: String?
}

private func copyableThread(
    id: String = "local-1",
    wireID: String? = "wire-1",
    branch: String? = "feat/parity",
    worktreePath: String? = "/Users/julius/code/t3code"
) -> FeatureThread {
    FeatureThread(
        id: id,
        wireID: wireID,
        projectID: "project-1",
        title: "Sync upstream",
        branch: branch,
        worktreePath: worktreePath
    )
}

/// Ports the row-menu assembly of
/// apps/mobile/src/features/threads/thread-list-v2-items.tsx and the two slow
/// server-side actions in apps/mobile/src/features/home/useThreadListActions.ts.
final class ThreadListActionsTests: XCTestCase {
    // MARK: - Menu

    func testTheMenuIsGroupedLifecycleNamingCopyThenDestructive() {
        let actions = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(titleRegenerationSupported: true)
        )

        XCTAssertEqual(
            actions.map(\.id),
            [
                "pin",
                "settle",
                "snooze",
                "rename",
                "regenerate-title",
                "copy",
                "archive",
                "delete",
            ]
        )
        XCTAssertEqual(
            ThreadRowMenu.sections(actions).map { $0.map(\.id) },
            [
                ["pin", "settle", "snooze"],
                ["rename", "regenerate-title"],
                ["copy"],
                ["archive", "delete"],
            ]
        )
        // The destructive item stays last however the menu grows.
        XCTAssertEqual(actions.last?.id, "delete")
        XCTAssertTrue(actions.last?.destructive == true)
    }

    func testTheCopySubmenuGathersEveryTargetTheRowCanOffer() {
        let copy = ThreadRowMenuActions.homeRowActions(ThreadRowMenuContext())
            .first { $0.id == ThreadRowMenuActions.copyActionID }

        XCTAssertEqual(
            copy?.children.map(\.id),
            ["copy-path", "copy-branch", "copy-handoff-script", "copy-thread-id"]
        )
        // Nesting must not rename the ids the row dispatches on.
        XCTAssertEqual(copy?.children.map(\.title), ["Path", "Branch", "Handoff script", "Thread ID"])
    }

    func testCopyTargetsWithNothingToCopyAreOmittedRatherThanOffered() {
        let copy = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(handoffScriptSupported: false, hasWorktreePath: false, hasBranch: false)
        )
        .first { $0.id == ThreadRowMenuActions.copyActionID }

        // The thread id is always there, so the submenu never empties out and
        // the section never collapses into a stray separator.
        XCTAssertEqual(copy?.children.map(\.id), ["copy-thread-id"])
    }

    func testRegenerationIsOmittedEntirelyOnServersThatWouldRejectIt() {
        let actions = ThreadRowMenuActions.homeRowActions(ThreadRowMenuContext())

        XCTAssertFalse(actions.contains { $0.id == "regenerate-title" })
        XCTAssertTrue(
            actions.first { $0.id == "copy" }?.children.contains { $0.id == "copy-handoff-script" }
                == true
        )
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
            ["rename", "regenerate-title", "copy", "restore", "delete"]
        )
        // Rename opens a section that has nothing above it on an archived row;
        // the grouping must not emit an empty leading group for that.
        XCTAssertEqual(
            ThreadRowMenu.sections(actions).map { $0.map(\.id) },
            [["rename", "regenerate-title"], ["copy"], ["restore", "delete"]]
        )
    }

    func testLifecycleItemsFlipWithTheRowsState() {
        let actions = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(isPinned: true, isSettled: true, isSnoozed: true)
        )

        XCTAssertEqual(
            actions.map(\.id),
            ["unpin", "unsettle", "unsnooze", "rename", "copy", "archive", "delete"]
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

    func testSettleAndSnoozeAreOmittedWhereTheServerWouldRefuseThem() {
        // An environment without the capability — or the Work Main thread —
        // gets no Settle/Snooze rows at all, like title regeneration: omitted
        // rather than offered and refused.
        let actions = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(settlementSupported: false, snoozeSupported: false)
        )

        XCTAssertEqual(actions.map(\.id), ["pin", "rename", "copy", "archive", "delete"])
    }

    func testSnoozeOpensTheSharedPresetSubmenu() {
        let now = Date(timeIntervalSince1970: 1_777_777_777)
        let actions = ThreadRowMenuActions.homeRowActions(ThreadRowMenuContext(), now: now)
        let snooze = actions.first { $0.id == ThreadRowMenuActions.snoozeActionID }

        XCTAssertEqual(
            snooze?.children.map(\.id),
            SnoozePresets.resolve(now: now).map(SnoozePresets.actionID(for:))
        )
        // The wake-time column rides subtitle, not the label.
        XCTAssertEqual(
            snooze?.children.map(\.subtitle),
            SnoozePresets.resolve(now: now).map(\.whenLabel)
        )
        // Unsnooze stays a plain action: there is only one way back.
        let unsnoozed = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(isSnoozed: true),
            now: now
        )
        XCTAssertEqual(
            unsnoozed.first { $0.id == ThreadRowMenuActions.unsnoozeActionID }?.children,
            []
        )
    }

    // MARK: - Copy targets

    func testCopyTargetsReadTheirValueOffTheRow() {
        let thread = copyableThread()

        XCTAssertEqual(ThreadCopy.value(for: .path, on: thread), "/Users/julius/code/t3code")
        XCTAssertEqual(ThreadCopy.value(for: .branch, on: thread), "feat/parity")
        // The wire id is what a server-side lookup expects.
        XCTAssertEqual(ThreadCopy.value(for: .threadID, on: thread), "wire-1")
    }

    func testCopyValuesAreTrimmedAndBlanksReadAsNothingToCopy() {
        let padded = copyableThread(branch: "  feat/parity  ", worktreePath: "   ")

        XCTAssertEqual(ThreadCopy.value(for: .branch, on: padded), "feat/parity")
        XCTAssertNil(ThreadCopy.value(for: .path, on: padded))
        XCTAssertNil(ThreadCopy.value(for: .branch, on: copyableThread(branch: nil)))
    }

    func testThreadIDFallsBackToTheLocalIdentityWhenThereIsNoWireID() {
        let thread = copyableThread(wireID: nil)

        XCTAssertEqual(ThreadCopy.value(for: .threadID, on: thread), "local-1")
    }

    func testEveryCopyActionIDMapsBackToItsTarget() {
        XCTAssertEqual(ThreadCopyTarget(actionID: ThreadRowMenuActions.copyPathActionID), .path)
        XCTAssertEqual(ThreadCopyTarget(actionID: ThreadRowMenuActions.copyBranchActionID), .branch)
        XCTAssertEqual(
            ThreadCopyTarget(actionID: ThreadRowMenuActions.copyThreadIDActionID),
            .threadID
        )
        // The handoff script is a server round trip, not a pasteboard read, and
        // keeps its own dispatch arm.
        XCTAssertNil(ThreadCopyTarget(actionID: ThreadRowMenuActions.copyHandoffScriptActionID))
        XCTAssertNil(ThreadCopyTarget(actionID: "delete"))
    }

    func testEveryCopyTargetHasItsOwnConfirmation() {
        let titles = ThreadCopyTarget.allCases.map { ThreadCopy.confirmation(for: $0).title }

        XCTAssertEqual(Set(titles).count, ThreadCopyTarget.allCases.count)
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
