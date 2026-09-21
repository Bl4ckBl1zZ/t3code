import XCTest

@testable import T3Code

/// The Source Control screen's decisions: which step a running action is on,
/// when publishing asks first, what a failure suggests next, and which actions
/// are offered for a given branch state.
final class SourceControlActionTests: XCTestCase {
    // MARK: - Progress

    /// The sequence `git.runStackedAction` streams for Commit & Push, folded the
    /// way the web client's reducer folds it.
    func testProgressFollowsPhasesAndCountsSteps() {
        var progress = FeatureSourceControlProgress()
        XCTAssertNil(progress.stepText)

        XCTAssertTrue(progress.apply(kind: "action_started", phases: ["commit", "push"]))
        XCTAssertNil(progress.stepText)

        XCTAssertTrue(progress.apply(kind: "phase_started", phase: "commit", label: "Committing..."))
        XCTAssertEqual(progress.stepText, "Committing… (1 of 2)")

        XCTAssertTrue(progress.apply(kind: "phase_started", phase: "push", label: "Pushing..."))
        XCTAssertEqual(progress.stepText, "Pushing… (2 of 2)")
    }

    func testAHookStandsInForItsPhaseUntilItFinishes() {
        var progress = FeatureSourceControlProgress()
        progress.apply(kind: "phase_started", phase: "commit", label: "Committing...")

        XCTAssertTrue(progress.apply(kind: "hook_started", hookName: "pre-commit"))
        XCTAssertEqual(progress.stepText, "Running pre-commit…")

        XCTAssertTrue(progress.apply(kind: "hook_finished", hookName: "pre-commit"))
        XCTAssertEqual(progress.stepText, "Committing…")
    }

    /// Hook output and the terminal events change nothing the row shows, so
    /// they must not trigger a redraw.
    func testOutputAndTerminalEventsAreNotVisibleChanges() {
        var progress = FeatureSourceControlProgress()
        progress.apply(kind: "phase_started", phase: "push", label: "Pushing...")

        XCTAssertFalse(progress.apply(kind: "hook_output", hookName: "pre-push"))
        XCTAssertFalse(progress.apply(kind: "action_finished"))
        XCTAssertFalse(progress.apply(kind: "action_failed", phase: "push"))
        XCTAssertEqual(progress.stepText, "Pushing…")
    }

    func testASinglePhaseActionHasNoStepCount() {
        var progress = FeatureSourceControlProgress()
        progress.apply(kind: "action_started", phases: ["push"])
        progress.apply(kind: "phase_started", phase: "push", label: "Pushing to origin...")

        XCTAssertEqual(progress.stepText, "Pushing to origin…")
    }

    // MARK: - Default branch

    func testPublishingOnTheDefaultBranchAsksFirst() {
        for action in [FeatureSourceControlAction.push, .commitAndPush, .commitPushAndCreatePullRequest, .createPullRequest] {
            XCTAssertTrue(action.requiresDefaultBranchConfirmation(isDefaultBranch: true), "\(action)")
            XCTAssertFalse(action.requiresDefaultBranchConfirmation(isDefaultBranch: false), "\(action)")
        }
    }

    /// A local commit and a pull publish nothing, so they never ask.
    func testLocalActionsNeverAsk() {
        XCTAssertFalse(FeatureSourceControlAction.commit.requiresDefaultBranchConfirmation(isDefaultBranch: true))
        XCTAssertFalse(FeatureSourceControlAction.pull.requiresDefaultBranchConfirmation(isDefaultBranch: true))
    }

    // MARK: - Failures

    func testARejectedPushSuggestsPullingFirst() {
        let failure = SourceControlFailure(
            action: .push,
            message: "Updates were rejected because the remote contains work that you do not have locally."
        )
        XCTAssertEqual(failure.title, "Couldn't Push")
        XCTAssertEqual(failure.nextStep, .pull)

        let nonFastForward = SourceControlFailure(action: .commitAndPush, message: "! [rejected] main -> main (non-fast-forward)")
        XCTAssertEqual(nonFastForward.nextStep, .pull)
    }

    func testOtherFailuresOfferNoNextStep() {
        XCTAssertNil(SourceControlFailure(action: .push, message: "Authentication failed").nextStep)
        // A commit never reaches the remote, whatever its hook printed.
        XCTAssertNil(SourceControlFailure(action: .commit, message: "hook rejected the commit").nextStep)
    }

    // MARK: - Available actions

    func testTheDefaultBranchIsNotOfferedAPullRequest() {
        let status = FeatureSourceControlStatus(
            branch: "main",
            isDefaultRef: true,
            aheadCount: 1,
            files: [.init(path: "App.swift", state: .modified, isStaged: false)]
        )
        XCTAssertEqual(status.availableActions, [.commitAndPush, .commit, .push])
    }

    func testWithoutARemoteOnlyLocalActionsRemain() {
        let status = FeatureSourceControlStatus(
            branch: "feature/native",
            hasPrimaryRemote: false,
            aheadCount: 2,
            files: [.init(path: "App.swift", state: .modified, isStaged: false)]
        )
        XCTAssertEqual(status.availableActions, [.commit])
    }

    func testADetachedHeadCannotPublish() {
        let status = FeatureSourceControlStatus(
            branch: nil,
            aheadCount: 1,
            files: [.init(path: "App.swift", state: .modified, isStaged: false)]
        )
        XCTAssertEqual(status.availableActions, [.commit])
    }

    func testConflictsHoldBackCommits() {
        let status = FeatureSourceControlStatus(
            branch: "feature/native",
            files: [
                .init(path: "App.swift", state: .conflicted, isStaged: false),
                .init(path: "README.md", state: .modified, isStaged: false),
            ]
        )
        XCTAssertTrue(status.hasConflicts)
        XCTAssertFalse(status.availableActions.contains(.commit))
        XCTAssertFalse(status.availableActions.contains(.commitAndPush))
    }

    // MARK: - Branch summary

    func testTheBranchDetailSaysWhatAheadMeans() {
        XCTAssertEqual(
            SourceControlBranchSummary.detail(FeatureSourceControlStatus(branch: "feat", hasUpstream: true, aheadCount: 2)),
            "Published · 2 commits to push"
        )
        XCTAssertEqual(
            SourceControlBranchSummary.detail(FeatureSourceControlStatus(branch: "feat", hasUpstream: false, aheadCount: 1)),
            "Not published · 1 commit not on the remote"
        )
        XCTAssertEqual(
            SourceControlBranchSummary.detail(FeatureSourceControlStatus(branch: "feat", hasUpstream: true)),
            "Published · up to date"
        )
        XCTAssertEqual(
            SourceControlBranchSummary.detail(FeatureSourceControlStatus(branch: "feat", hasPrimaryRemote: false)),
            "No remote"
        )
    }

    func testTheSubtitlePrefersTheRunningStep() {
        let status = FeatureSourceControlStatus(branch: "main", hasUpstream: true, isDefaultRef: true, aheadCount: 2)
        XCTAssertEqual(SourceControlBranchSummary.subtitle(status, step: "Pushing…"), "main · Pushing…")
        XCTAssertEqual(SourceControlBranchSummary.subtitle(status, step: nil), "main · default branch")
    }
}
