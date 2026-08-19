import XCTest

@testable import T3Code

/// Ports the quick-action half of packages/client-runtime/src/state/gitActions.ts
/// and apps/web/src/components/GitActionsControl.logic.test.ts, plus
/// `statusSummary` from apps/mobile/src/features/threads/git/gitSheetComponents.tsx.
///
/// The details sheet leads with a single git button, so which action it picks is
/// the whole feature: every client has to reach the same one from the same
/// branch state or the same tap does different things on different surfaces.
final class ThreadDetailsGitTests: XCTestCase {
    private func status(
        isRepo: Bool = true,
        refName: String? = "feature/test",
        hasWorkingTreeChanges: Bool = false,
        changedFileCount: Int = 0,
        insertions: Int = 0,
        deletions: Int = 0,
        hasUpstream: Bool = true,
        aheadCount: Int = 0,
        behindCount: Int = 0,
        isDefaultRef: Bool = false,
        hasPrimaryRemote: Bool = true,
        pullRequest: ThreadDetailsPullRequest? = nil
    ) -> ThreadDetailsGitStatus {
        ThreadDetailsGitStatus(
            isRepo: isRepo,
            refName: refName,
            hasWorkingTreeChanges: hasWorkingTreeChanges,
            changedFileCount: changedFileCount,
            insertions: insertions,
            deletions: deletions,
            hasUpstream: hasUpstream,
            aheadCount: aheadCount,
            behindCount: behindCount,
            isDefaultRef: isDefaultRef,
            hasPrimaryRemote: hasPrimaryRemote,
            pullRequest: pullRequest
        )
    }

    private func openPullRequest(number: Int = 10) -> ThreadDetailsPullRequest {
        ThreadDetailsPullRequest(
            number: number, state: "open", url: "https://example.com/pr/\(number)"
        )
    }

    // MARK: - Quick action

    func testABusyRepositoryOffersNothingUntilTheRunningActionSettles() {
        let quick = ThreadDetailsGit.resolveQuickAction(status(), isBusy: true)
        XCTAssertEqual(quick.kind, .showHint)
        XCTAssertEqual(quick.label, "Commit")
        XCTAssertTrue(quick.disabled)
        XCTAssertEqual(quick.hint, "Git action in progress.")
    }

    func testAnUnknownStatusSaysSoRatherThanOfferingADeadCommit() {
        let quick = ThreadDetailsGit.resolveQuickAction(nil, isBusy: false)
        XCTAssertEqual(quick.kind, .showHint)
        XCTAssertTrue(quick.disabled)
        XCTAssertEqual(quick.hint, "Git status is unavailable.")
    }

    func testAWorkspaceThatIsNotARepositorySaysThatInsteadOfDisablingCommit() {
        let quick = ThreadDetailsGit.quickAction(for: status(isRepo: false), isBusy: false)
        XCTAssertEqual(quick.label, "Git unavailable")
        XCTAssertTrue(quick.disabled)
        XCTAssertEqual(quick.hint, "This workspace is not a git repository.")
    }

    func testADetachedHeadIsAskedToPickABranchBeforeAnythingIsPublished() {
        let quick = ThreadDetailsGit.resolveQuickAction(status(refName: nil), isBusy: false)
        XCTAssertTrue(quick.disabled)
        XCTAssertEqual(
            quick.hint, "Create and checkout a branch before pushing or opening a PR."
        )
    }

    func testUncommittedWorkOnAFeatureBranchGoesAllTheWayToAPullRequest() {
        let quick = ThreadDetailsGit.resolveQuickAction(
            status(hasWorkingTreeChanges: true, changedFileCount: 3), isBusy: false
        )
        XCTAssertEqual(quick.label, "Commit, push & PR")
        XCTAssertEqual(quick.action, .commitPushAndPullRequest)
        XCTAssertFalse(quick.disabled)
    }

    func testUncommittedWorkStopsAtAPushWhenAPullRequestAlreadyExists() {
        let quick = ThreadDetailsGit.resolveQuickAction(
            status(hasWorkingTreeChanges: true, pullRequest: openPullRequest()), isBusy: false
        )
        XCTAssertEqual(quick.label, "Commit & push")
        XCTAssertEqual(quick.action, .commitAndPush)
    }

    func testUncommittedWorkWithNowhereToPushCommitsLocallyAndStops() {
        let quick = ThreadDetailsGit.resolveQuickAction(
            status(hasWorkingTreeChanges: true, hasUpstream: false),
            isBusy: false,
            hasOriginRemote: false
        )
        XCTAssertEqual(quick.label, "Commit")
        XCTAssertEqual(quick.action, .commit)
        XCTAssertFalse(quick.disabled)
    }

    func testACleanBranchWithAnOpenPullRequestOffersToViewIt() {
        let quick = ThreadDetailsGit.resolveQuickAction(
            status(pullRequest: openPullRequest()), isBusy: false
        )
        XCTAssertEqual(quick.kind, .openPullRequest)
        XCTAssertEqual(quick.label, "View PR")
        XCTAssertFalse(quick.disabled)
    }

    func testABranchWithNoUpstreamAndNothingToPushExplainsWhyPushIsDisabled() {
        let quick = ThreadDetailsGit.resolveQuickAction(
            status(hasUpstream: false), isBusy: false
        )
        XCTAssertTrue(quick.disabled)
        XCTAssertEqual(quick.hint, "No local commits to push.")
    }

    func testARepositoryWithNoRemoteNamesTheMissingRemote() {
        let quick = ThreadDetailsGit.resolveQuickAction(
            status(hasUpstream: false), isBusy: false, hasOriginRemote: false
        )
        XCTAssertTrue(quick.disabled)
        XCTAssertEqual(quick.hint, "Add an \"origin\" remote before pushing or creating a PR.")
    }

    func testADivergedBranchRefusesToGuessBetweenRebaseAndMerge() {
        let quick = ThreadDetailsGit.resolveQuickAction(
            status(aheadCount: 2, behindCount: 3), isBusy: false
        )
        XCTAssertEqual(quick.label, "Sync branch")
        XCTAssertTrue(quick.disabled)
        XCTAssertEqual(quick.hint, "Branch has diverged from upstream. Rebase/merge first.")
    }

    func testABranchThatIsOnlyBehindPulls() {
        let quick = ThreadDetailsGit.resolveQuickAction(status(behindCount: 4), isBusy: false)
        XCTAssertEqual(quick.kind, .runPull)
        XCTAssertEqual(quick.label, "Pull")
        XCTAssertFalse(quick.disabled)
    }

    func testAheadOnTheDefaultBranchCommitsAndPushesRatherThanOpeningAPullRequest() {
        let quick = ThreadDetailsGit.resolveQuickAction(
            status(aheadCount: 1), isBusy: false, isDefaultBranch: true
        )
        XCTAssertEqual(quick.label, "Push")
        XCTAssertEqual(quick.action, .commitAndPush)
    }

    func testAheadOnAFeatureBranchOffersToOpenThePullRequest() {
        let quick = ThreadDetailsGit.resolveQuickAction(status(aheadCount: 1), isBusy: false)
        XCTAssertEqual(quick.label, "Push & create PR")
        XCTAssertEqual(quick.action, .createPullRequest)
    }

    func testAFullySyncedBranchHasNothingToDo() {
        let quick = ThreadDetailsGit.resolveQuickAction(status(), isBusy: false)
        XCTAssertTrue(quick.disabled)
        XCTAssertEqual(quick.hint, "Branch is up to date. No action needed.")
    }

    /// The sheet reads `isDefaultRef` and `hasPrimaryRemote` off the status
    /// rather than defaulting them, so a status that never reports a remote must
    /// not silently behave as if it had one.
    func testTheSheetPassesTheStatusOwnRemoteFlagRatherThanTheOptimisticDefault() {
        let quick = ThreadDetailsGit.quickAction(
            for: status(hasUpstream: false, hasPrimaryRemote: false), isBusy: false
        )
        XCTAssertEqual(quick.hint, "Add an \"origin\" remote before pushing or creating a PR.")
    }

    // MARK: - Confirmation

    func testPublishingOntoTheDefaultBranchIsConfirmedAndCommittingIsNot() {
        for action in [GitStackedAction.push, .createPullRequest, .commitAndPush,
                       .commitPushAndPullRequest] {
            XCTAssertTrue(
                ThreadDetailsGit.requiresDefaultBranchConfirmation(action, isDefaultBranch: true),
                "\(action) publishes and should be confirmed"
            )
        }
        XCTAssertFalse(
            ThreadDetailsGit.requiresDefaultBranchConfirmation(.commit, isDefaultBranch: true)
        )
    }

    func testAFeatureBranchIsNeverConfirmed() {
        XCTAssertFalse(
            ThreadDetailsGit.requiresDefaultBranchConfirmation(
                .commitPushAndPullRequest, isDefaultBranch: false
            )
        )
    }

    // MARK: - Row presentation

    func testStatusSummaryReadsChangesDriftAndPullRequestInThatOrder() {
        XCTAssertEqual(
            ThreadDetailsGit.statusSummary(
                status(
                    hasWorkingTreeChanges: true,
                    changedFileCount: 1,
                    aheadCount: 2,
                    behindCount: 3,
                    pullRequest: openPullRequest(number: 42)
                )
            ),
            "1 file changed · 2 ahead · 3 behind · PR #42 open"
        )
    }

    func testStatusSummaryDistinguishesLoadingFromCleanFromNotARepository() {
        XCTAssertEqual(ThreadDetailsGit.statusSummary(nil), "Loading branch status…")
        XCTAssertEqual(ThreadDetailsGit.statusSummary(status()), "Clean")
        XCTAssertEqual(
            ThreadDetailsGit.statusSummary(status(isRepo: false)), "Not a git repository"
        )
    }

    func testStatusSummaryPluralisesTheFileCount() {
        XCTAssertEqual(
            ThreadDetailsGit.statusSummary(
                status(hasWorkingTreeChanges: true, changedFileCount: 2)
            ),
            "2 files changed"
        )
    }

    func testABranchNameFallsBackToTheThreadsOwnBranchAndThenToDetachedHead() {
        XCTAssertEqual(
            ThreadDetailsGit.branchLabel(status(refName: "main"), threadBranch: "other"), "main"
        )
        XCTAssertEqual(
            ThreadDetailsGit.branchLabel(status(refName: nil), threadBranch: "recorded"),
            "recorded"
        )
        XCTAssertEqual(ThreadDetailsGit.branchLabel(nil, threadBranch: nil), "Detached HEAD")
    }

    func testTheWorkingTreeDeltaIsOmittedWhenNothingChanged() {
        XCTAssertNil(ThreadDetailsGit.workingTreeDelta(status()))
        XCTAssertNil(ThreadDetailsGit.workingTreeDelta(nil))
        XCTAssertEqual(
            ThreadDetailsGit.workingTreeDelta(status(insertions: 12, deletions: 3)), "+12 −3"
        )
    }

    func testTheQuickActionIconNamesTheActionRatherThanTheState() {
        XCTAssertEqual(
            ThreadDetailsGit.quickActionIcon(
                ThreadDetailsGitQuickAction(label: "Pull", disabled: false, kind: .runPull)
            ),
            "arrow.down.circle"
        )
        XCTAssertEqual(
            ThreadDetailsGit.quickActionIcon(
                ThreadDetailsGitQuickAction(
                    label: "Commit", disabled: false, kind: .runAction, action: .commit
                )
            ),
            "checkmark.circle"
        )
        XCTAssertEqual(
            ThreadDetailsGit.quickActionIcon(
                ThreadDetailsGitQuickAction(
                    label: "Push", disabled: false, kind: .runAction, action: .push
                )
            ),
            "arrow.up.circle"
        )
        XCTAssertEqual(
            ThreadDetailsGit.quickActionIcon(
                ThreadDetailsGitQuickAction(label: "View PR", disabled: false, kind: .openPullRequest)
            ),
            "arrow.up.right.circle"
        )
    }

    func testADisabledQuickActionAlwaysCarriesASentence() {
        XCTAssertEqual(
            ThreadDetailsGit.quickActionSubtitle(
                ThreadDetailsGitQuickAction(
                    label: "Push", disabled: true, kind: .showHint, hint: "No local commits."
                )
            ),
            "No local commits."
        )
        XCTAssertEqual(
            ThreadDetailsGit.quickActionSubtitle(
                ThreadDetailsGitQuickAction(label: "Push", disabled: true, kind: .showHint)
            ),
            "This action is unavailable."
        )
        XCTAssertNil(
            ThreadDetailsGit.quickActionSubtitle(
                ThreadDetailsGitQuickAction(
                    label: "Pull", disabled: false, kind: .runPull
                )
            )
        )
    }

    // MARK: - Status adapters

    func testTheWireStatusIsReadWithoutLosingAnyFieldTheQuickActionNeeds() {
        let wire = VCSStatus(
            isRepo: true,
            sourceControlProvider: nil,
            hasPrimaryRemote: true,
            isDefaultRef: true,
            refName: "main",
            hasWorkingTreeChanges: true,
            workingTree: VCSWorkingTree(
                files: [VCSWorkingTreeFile(path: "a.swift", insertions: 4, deletions: 1)],
                insertions: 4,
                deletions: 1
            ),
            hasUpstream: true,
            aheadCount: 2,
            behindCount: 0,
            aheadOfDefaultCount: nil,
            pr: VCSChangeRequest(
                number: 7,
                title: "Open",
                url: "https://example.com/pr/7",
                baseRef: "main",
                headRef: "main",
                state: "open",
                updatedAt: nil
            )
        )
        let status = ThreadDetailsGitStatus(wire)
        XCTAssertTrue(status.isDefaultRef)
        XCTAssertTrue(status.hasPrimaryRemote)
        XCTAssertTrue(status.hasUpstream)
        XCTAssertEqual(status.changedFileCount, 1)
        XCTAssertEqual(status.insertions, 4)
        XCTAssertEqual(status.deletions, 1)
        XCTAssertEqual(status.pullRequest?.number, 7)
        XCTAssertTrue(status.pullRequest?.isOpen == true)
    }

    /// The feature-layer status carries every flag the wire status does, so it
    /// is read rather than reconstructed: a branch level with its upstream is
    /// still tracked, which drift alone could never have shown.
    func testTheFeatureStatusReadsTrackingAndRemoteFactsRatherThanInferringThem() {
        let tracked = ThreadDetailsGitStatus(
            sourceControl: FeatureSourceControlStatus(
                branch: "feature",
                hasUpstream: true,
                hasPrimaryRemote: true
            )
        )
        XCTAssertTrue(tracked.hasUpstream)
        XCTAssertTrue(tracked.hasPrimaryRemote)

        let untracked = ThreadDetailsGitStatus(
            sourceControl: FeatureSourceControlStatus(
                branch: "feature",
                hasUpstream: false,
                hasPrimaryRemote: false,
                aheadCount: 3
            )
        )
        XCTAssertFalse(untracked.hasUpstream)
        XCTAssertFalse(untracked.hasPrimaryRemote)
    }

    /// The confirmation before publishing onto the default branch is the one
    /// git prompt with no undo behind it, and `isDefaultRef` is the only thing
    /// that fires it. Assuming `false` silently removed it.
    func testTheFeatureStatusCarriesTheDefaultBranchFlagThroughToTheConfirmation() {
        let onDefault = ThreadDetailsGitStatus(
            sourceControl: FeatureSourceControlStatus(branch: "main", isDefaultRef: true)
        )
        XCTAssertTrue(onDefault.isDefaultRef)
        XCTAssertTrue(
            ThreadDetailsGit.requiresDefaultBranchConfirmation(
                .commitAndPush,
                isDefaultBranch: onDefault.isDefaultRef
            )
        )

        let onBranch = ThreadDetailsGitStatus(
            sourceControl: FeatureSourceControlStatus(branch: "feature")
        )
        XCTAssertFalse(onBranch.isDefaultRef)
    }

    func testTheFeatureStatusReportsTheWorkingTreeVerdictAndItsLineCounts() {
        let dirty = ThreadDetailsGitStatus(
            sourceControl: FeatureSourceControlStatus(
                branch: "feature",
                insertions: 12,
                deletions: 3,
                files: [FeatureSourceControlFile(path: "a.swift", state: .modified, isStaged: false)]
            )
        )
        XCTAssertTrue(dirty.hasWorkingTreeChanges)
        XCTAssertEqual(dirty.changedFileCount, 1)
        XCTAssertEqual(ThreadDetailsGit.workingTreeDelta(dirty), "+12 −3")

        // Git can report a dirty tree whose per-file numstat is empty, which
        // `!files.isEmpty` used to read as clean.
        let modeOnly = ThreadDetailsGitStatus(
            sourceControl: FeatureSourceControlStatus(
                branch: "feature",
                hasWorkingTreeChanges: true
            )
        )
        XCTAssertTrue(modeOnly.hasWorkingTreeChanges)
        XCTAssertEqual(modeOnly.changedFileCount, 0)
    }
}
