import XCTest
@testable import T3Code

final class PullRequestQuickActionTests: XCTestCase {
    private func detail(_ changes: [String: Any] = [:]) throws -> PullRequestDetail {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestActions.json")
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        var value = fixture["detail"] as! [String: Any]
        for (key, change) in changes { value[key] = change }
        return try JSONDecoder().decode(PullRequestDetail.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private func entry(provider: String = "github", state: PullRequestState = .open, draft: Bool = false) -> PullRequestListEntry {
        PullRequestListEntry(provider: provider, host: "github.com", projectId: "project", projectTitle: "Project", repository: "owner/repo", number: 7,
            title: "Change", url: "https://github.com/owner/repo/pull/7", author: PullRequestActor(login: "me", name: nil, avatarUrl: nil),
            headBranch: "feature", baseBranch: "main", state: state, isDraft: draft, mergeability: .mergeable,
            additions: 0, deletions: 0, createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
            viewerReviewRequested: false, labels: [], reviewDecision: nil, checksState: nil)
    }

    // MARK: Merge method precedence

    func testThePullRequestsOwnChoiceWinsThenProjectThenDevice() {
        let allowed = ["merge", "squash", "rebase"]
        XCTAssertEqual(PullRequestActionLogic.resolveMergeMethod(allowed: allowed, current: "rebase", projectDefault: "squash", lastUsed: "merge"), "rebase")
        XCTAssertEqual(PullRequestActionLogic.resolveMergeMethod(allowed: allowed, current: nil, projectDefault: "squash", lastUsed: "merge"), "squash")
        XCTAssertEqual(PullRequestActionLogic.resolveMergeMethod(allowed: allowed, current: nil, projectDefault: nil, lastUsed: "rebase"), "rebase")
        XCTAssertEqual(PullRequestActionLogic.resolveMergeMethod(allowed: allowed, current: nil, projectDefault: nil, lastUsed: nil), "merge")
    }

    func testAMethodTheRepositoryDisallowsFallsThrough() {
        let allowed = ["squash"]
        XCTAssertEqual(PullRequestActionLogic.resolveMergeMethod(allowed: allowed, current: nil, projectDefault: "rebase", lastUsed: "merge"), "squash")
        XCTAssertEqual(PullRequestActionLogic.resolveMergeMethod(allowed: ["merge", "rebase"], current: nil, projectDefault: "squash", lastUsed: "rebase"), "rebase")
        XCTAssertNil(PullRequestActionLogic.resolveMergeMethod(allowed: [], current: nil, projectDefault: "squash", lastUsed: nil))
    }

    func testTheDeviceRemembersOnlyRealMergeMethods() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "PullRequestQuickActionTests"))
        defaults.removePersistentDomain(forName: "PullRequestQuickActionTests")
        XCTAssertNil(PullRequestMergeMethodMemory.lastUsed(defaults))
        PullRequestMergeMethodMemory.remember("rebase", defaults)
        PullRequestMergeMethodMemory.remember("", defaults)
        XCTAssertEqual(PullRequestMergeMethodMemory.lastUsed(defaults), "rebase")
        defaults.removePersistentDomain(forName: "PullRequestQuickActionTests")
    }

    // MARK: Row quick actions

    func testRowsOfferTheNextStepAndClose() {
        XCTAssertEqual(PullRequestActionLogic.quickActions(entry()), [.merge, .close])
        XCTAssertEqual(PullRequestActionLogic.quickActions(entry(draft: true)), [.ready, .close])
        XCTAssertEqual(PullRequestActionLogic.quickActions(entry(state: .closed)), [.reopen])
        XCTAssertEqual(PullRequestActionLogic.quickActions(entry(state: .merged)), [])
    }

    func testOnlyGitHubRowsActFromTheList() {
        XCTAssertEqual(PullRequestActionLogic.quickActions(entry(provider: "gitlab")), [])
    }

    // MARK: Linked pull request quick actions

    private func link(state: String? = "open", draft: Bool = false, host: String? = "github.com", url: String = "https://github.com/owner/repo/pull/7",
                      source: String? = "manual", stack: FeaturePullRequestStack? = nil) -> FeatureLinkedPullRequest {
        FeatureLinkedPullRequest(projectID: "project", repository: "owner/repo", number: 7, url: url, host: host, source: source,
            snapshot: state.map { FeaturePullRequestSnapshot(state: $0, title: "Change", headBranch: "feature", baseBranch: "main", isDraft: draft) },
            stack: stack)
    }

    func testLinkedPullRequestsOfferTheListsActionsFromTheirSnapshot() {
        XCTAssertEqual(PullRequestActionLogic.quickActions(link()), [.merge, .close])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(draft: true)), [.ready, .close])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(state: "closed")), [.reopen])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(state: "merged")), [])
        // No snapshot yet: the state is unknown, so nothing is offered.
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(state: nil)), [])
    }

    func testOnlyGitHubLinksActIncludingEnterpriseHosts() {
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(host: "gitlab.com", url: "https://gitlab.com/owner/repo/-/merge_requests/7")), [])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(host: "github.example.com")), [.merge, .close])
        // An older server sends no host; the link's URL names it.
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(host: nil)), [.merge, .close])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(host: nil, url: "https://bitbucket.org/owner/repo/pull-requests/7")), [])
    }

    func testAStackLayerKeepsItsActionsButMerge() {
        let stack = FeaturePullRequestStack(id: "stack", number: 6, url: "https://github.com/owner/repo/pull/6", base: "main", numbers: [6, 7])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(stack: stack)), [.close])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(source: "stack")), [.close])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(draft: true, source: "stack")), [.ready, .close])
        XCTAssertEqual(PullRequestActionLogic.quickActions(link(state: "closed", stack: stack)), [.reopen])
    }

    // MARK: Expected state after a linked quick action

    func testAnAcceptedActionMovesTheStateTheListAndLinksShare() {
        XCTAssertEqual(PullRequestActionLogic.outcome(of: .close, state: .open)?.state, .closed)
        XCTAssertEqual(PullRequestActionLogic.outcome(of: .reopen, state: .closed)?.state, .open)
        XCTAssertEqual(PullRequestActionLogic.outcome(of: .merge, state: .open)?.state, .merged)
        XCTAssertNil(PullRequestActionLogic.outcome(of: .close, state: .open)?.isDraft)
        XCTAssertEqual(PullRequestActionLogic.outcome(of: .ready, state: .open)?.isDraft, false)
        XCTAssertEqual(PullRequestActionLogic.outcome(of: .draft, state: .open)?.isDraft, true)
        XCTAssertNil(PullRequestActionLogic.outcome(of: .updateBranch, state: .open))
    }

    func testTheRowShowsAndActsFromTheExpectedStateUntilTheThreadReadsItAgain() throws {
        let open = link()
        let closing = try XCTUnwrap(LinkedPullRequestOverlays.overlay(after: .close, shown: open.snapshot, basis: open.snapshot))
        let shown = LinkedPullRequestOverlays.shown(open, overlay: closing)
        XCTAssertEqual(shown.snapshot?.state, "closed")
        XCTAssertEqual(PullRequestActionLogic.quickActions(shown), [.reopen])

        // Reopening from the shown state: expected open again, still over the thread's snapshot.
        let reopening = try XCTUnwrap(LinkedPullRequestOverlays.overlay(after: .reopen, shown: shown.snapshot, basis: open.snapshot))
        XCTAssertEqual(reopening.basis, open.snapshot)
        XCTAssertFalse(LinkedPullRequestOverlays.holds(reopening, over: open.snapshot), "the thread already says open")

        let key = LinkedPullRequestOverlays.key(threadID: "a", link: open)
        XCTAssertEqual(LinkedPullRequestOverlays.reconcile([key: closing], threadID: "a", links: [open]).count, 1)
        // The server's next read wins, whether or not it agrees.
        for read in [link(state: "closed"), link(draft: true)] {
            XCTAssertEqual(LinkedPullRequestOverlays.shown(read, overlay: closing).snapshot, read.snapshot)
            XCTAssertTrue(LinkedPullRequestOverlays.reconcile([key: closing], threadID: "a", links: [read]).isEmpty)
        }
    }

    func testReadyKeepsTheStateAndMergeOffersNothingMore() throws {
        let draft = link(draft: true)
        let ready = try XCTUnwrap(LinkedPullRequestOverlays.overlay(after: .ready, shown: draft.snapshot, basis: draft.snapshot))
        XCTAssertEqual(PullRequestActionLogic.quickActions(LinkedPullRequestOverlays.shown(draft, overlay: ready)), [.merge, .close])
        let merged = try XCTUnwrap(LinkedPullRequestOverlays.overlay(after: .merge, shown: link().snapshot, basis: link().snapshot))
        XCTAssertEqual(PullRequestActionLogic.quickActions(LinkedPullRequestOverlays.shown(link(), overlay: merged)), [])
        XCTAssertNil(LinkedPullRequestOverlays.overlay(after: .close, shown: nil, basis: nil))
    }

    func testAnOverlayStaysWithItsThreadAndLink() throws {
        var linked = link()
        linked.linkedAt = "2026-10-07T10:00:00.000Z"
        let overlay = try XCTUnwrap(LinkedPullRequestOverlays.overlay(after: .close, shown: linked.snapshot, basis: linked.snapshot))
        let overlays = [LinkedPullRequestOverlays.key(threadID: "a", link: linked): overlay]
        // Unlinked: gone. Another thread with the same request: never applies there.
        XCTAssertTrue(LinkedPullRequestOverlays.reconcile(overlays, threadID: "a", links: []).isEmpty)
        XCTAssertTrue(LinkedPullRequestOverlays.reconcile(overlays, threadID: "b", links: [linked]).isEmpty)
        XCTAssertNil(overlays[LinkedPullRequestOverlays.key(threadID: "b", link: linked)])
        // Linked again: a new link, with no overlay of its own.
        var relinked = linked
        relinked.linkedAt = "2026-10-07T11:00:00.000Z"
        XCTAssertNil(overlays[LinkedPullRequestOverlays.key(threadID: "a", link: relinked)])
        XCTAssertTrue(LinkedPullRequestOverlays.reconcile(overlays, threadID: "a", links: [relinked]).isEmpty)
    }

    func testQuickMergeRunsOnlyWhenTheDetailOffersMerge() throws {
        XCTAssertNil(PullRequestActionLogic.quickMergeRefusal(try detail()))
        XCTAssertEqual(PullRequestActionLogic.quickMergeRefusal(try detail(["isDraft": true])), "This pull request cannot be merged.")
        XCTAssertEqual(PullRequestActionLogic.quickMergeRefusal(try detail(["state": "closed"])), "This pull request cannot be merged.")
        XCTAssertEqual(PullRequestActionLogic.quickMergeRefusal(try detail(["mergeability": "conflicting"])), "This pull request cannot be merged.")
        let readOnly = try detail(["viewerPermissions": ["actions": []]])
        XCTAssertEqual(PullRequestActionLogic.quickMergeRefusal(readOnly), "This pull request cannot be merged.")
        let noMethod = try detail(["mergeCapabilities": ["merge": false, "squash": false, "rebase": false]])
        XCTAssertEqual(PullRequestActionLogic.quickMergeRefusal(noMethod), "No merge method is available for this repository.")
    }

    func testAStackedPullRequestIsSentToItsDetail() {
        XCTAssertEqual(PullRequestActionLogic.stackedQuickMergeRefusal, "Open this pull request to merge its stack.")
    }
}
