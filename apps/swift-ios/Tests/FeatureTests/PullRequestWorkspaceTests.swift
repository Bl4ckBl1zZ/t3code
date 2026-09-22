import XCTest
@testable import T3Code

@MainActor
final class PullRequestWorkspaceTests: XCTestCase {
    private let environments = [FeatureEnvironment(id: "one", name: "One", endpoint: "https://one.test", isActive: true, supportsPullRequests: true), FeatureEnvironment(id: "two", name: "Two", endpoint: "https://two.test", supportsPullRequests: true)]
    private func project(_ environment: String, _ wireID: String = "project", canonical: String? = nil) -> FeatureProject {
        FeatureProject(id: FeatureScopedID.project(environmentID: environment, wireID: wireID), wireID: wireID,
            environmentID: environment, name: "Project", path: "/work/project", repositoryCanonicalKey: canonical)
    }
    private func entry(_ number: Int, host: String = "github.com", projectID: String = "project", title: String = "Change", author: String = "other", reviewRequested: Bool = false, checks: String? = nil, review: String? = nil, conflict: Bool = false, additions: Int = 0, date: String = "2026-09-10T12:00:00.000Z", state: PullRequestState = .open, draft: Bool = false) -> PullRequestListEntry {
        PullRequestListEntry(provider: "github", host: host, projectId: projectID, projectTitle: "Project", repository: "owner/repo", number: number,
            title: title, url: "https://\(host)/owner/repo/pull/\(number)", author: PullRequestActor(login: author, name: nil, avatarUrl: nil),
            headBranch: "feature-\(number)", baseBranch: "main", state: state, isDraft: draft, mergeability: conflict ? .conflicting : .mergeable,
            additions: additions, deletions: 0, createdAt: date, updatedAt: date, viewerReviewRequested: reviewRequested, labels: [], reviewDecision: review, checksState: checks)
    }
    private func page(_ entries: [PullRequestListEntry], cursor: String? = nil) -> PullRequestListResult {
        PullRequestListResult(viewers: ["github.com": "me"], providers: [], entries: entries, errors: [], truncated: cursor != nil,
            nextCursors: cursor.map { ["github.com owner/repo": $0] } ?? [:])
    }

    func testCanonicalRepositoryAssignmentKeepsTheSelectedEnvironment() {
        let projects = [project("one", canonical: "github.com/owner/repo"), project("two", canonical: "github.com/owner/repo"), project("two", "enterprise", canonical: "enterprise.test/owner/repo")]
        let all = NativePullRequestWorkspaceLogic.assignedProjects(projects, environments: environments, preferences: .init())
        XCTAssertEqual(all["one"], ["project"])
        XCTAssertEqual(all["two"], ["enterprise"])
        var selected = NativePullRequestPreferences(); selected.projectID = projects[1].id
        XCTAssertEqual(NativePullRequestWorkspaceLogic.assignedProjects(projects, environments: environments, preferences: selected), ["two": ["project"]])
    }

    func testHostIsPartOfIdentityAndReadinessUsesMeasuredSizes() {
        let rows = [
            NativePullRequestRow(environmentID: "one", entry: entry(1, conflict: true), sizeKnown: true),
            NativePullRequestRow(environmentID: "one", entry: entry(2, checks: "passing", review: "approved", additions: 20), sizeKnown: true),
            NativePullRequestRow(environmentID: "one", entry: entry(3, checks: "passing", review: "approved")),
            NativePullRequestRow(environmentID: "one", entry: entry(4, checks: "passing", review: "approved"), sizeKnown: true),
        ]
        XCTAssertEqual(NativePullRequestWorkspaceLogic.sort(rows, preferences: .init()).map(\.entry.number), [4, 2, 3, 1])
        XCTAssertNotEqual(entry(1).id, entry(1, host: "enterprise.test").id)
    }

    func testSearchRanksExactNumbersAndAuthoredWorkStaysGrouped() {
        var preferences = NativePullRequestPreferences(); preferences.query = "#42"
        let rows = [NativePullRequestRow(environmentID: "one", entry: entry(1, title: "Mention #42")), NativePullRequestRow(environmentID: "one", entry: entry(42))]
        XCTAssertEqual(NativePullRequestWorkspaceLogic.sort(rows, preferences: preferences).map(\.entry.number), [42, 1])
        preferences.query = ""
        let authored = NativePullRequestRow(environmentID: "one", entry: entry(3, author: "ME", conflict: true), viewer: "me")
        XCTAssertEqual(NativePullRequestWorkspaceLogic.sort(rows + [authored], preferences: preferences).first?.entry.number, 3)
    }

    func testBlockedOnMeRanksAuthoredWorkByWhoseMoveItIs() {
        var preferences = NativePullRequestPreferences(); preferences.sort = "blocked"
        let mine: [PullRequestListEntry] = [
            entry(6, author: "me"),
            entry(7, author: "me", date: "2026-08-01T00:00:00.000Z", state: .merged),
            entry(2, author: "me", checks: "failing", date: "2026-08-01T00:00:00.000Z"),
            entry(5, author: "me", checks: "passing", draft: true),
            entry(4, author: "me", checks: "passing", review: "approved"),
            entry(3, author: "me", checks: "failing", review: "changes-requested", date: "2026-08-02T00:00:00.000Z"),
            entry(8, author: "me", date: "2026-08-03T00:00:00.000Z", state: .closed),
            entry(1, author: "me", checks: "failing", conflict: true, date: "2026-08-01T00:00:00.000Z"),
            entry(9, author: "me", checks: "failing", date: "2026-08-03T00:00:00.000Z"),
        ]
        let rows = mine.map { NativePullRequestRow(environmentID: "one", entry: $0, viewer: "me") }
        XCTAssertEqual(NativePullRequestWorkspaceLogic.sort(rows, preferences: preferences).map(\.entry.number), [1, 3, 9, 2, 5, 6, 4, 8, 7])
    }

    func testBlockedOnMeRanksReviewsOpenFirstAndOthersByInvolvement() {
        var preferences = NativePullRequestPreferences(); preferences.sort = "blocked"
        let reviews = [
            entry(4, reviewRequested: true, date: "2026-08-03T00:00:00.000Z", state: .closed),
            entry(2, reviewRequested: true, date: "2026-08-02T00:00:00.000Z"),
            entry(3, reviewRequested: true, date: "2026-08-01T00:00:00.000Z", state: .merged),
            entry(1, reviewRequested: true, date: "2026-08-01T00:00:00.000Z"),
        ].map { NativePullRequestRow(environmentID: "one", entry: $0, viewer: "me") }
        XCTAssertEqual(NativePullRequestWorkspaceLogic.sort(reviews, preferences: preferences).map(\.entry.number), [2, 1, 4, 3])

        // Rows the viewer neither wrote nor was asked to review keep recency order under
        // "all", and take the filtered role's ranking otherwise.
        let others = [entry(5, date: "2026-08-02T00:00:00.000Z"), entry(6, date: "2026-08-01T00:00:00.000Z", draft: true)]
            .map { NativePullRequestRow(environmentID: "one", entry: $0, viewer: "me") }
        XCTAssertEqual(NativePullRequestWorkspaceLogic.sort(others, preferences: preferences).map(\.entry.number), [5, 6])
        preferences.involvement = "authored"
        XCTAssertEqual(NativePullRequestWorkspaceLogic.sort(others, preferences: preferences).map(\.entry.number), [6, 5])
        XCTAssertEqual(NativePullRequestPreferences.read(preferences.serialized).sort, "blocked")
    }

    func testSavedPreferencesAreStableAndBoundWireValues() throws {
        var preferences = NativePullRequestPreferences(); preferences.author = "  me  "; preferences.query = String(repeating: "x", count: 300)
        preferences.labels = " bug , docs, "; preferences.excludedLabels = "wontfix"
        XCTAssertEqual(preferences.serialized, preferences.serialized)
        XCTAssertEqual(NativePullRequestPreferences.read(preferences.serialized), preferences)
        let input = preferences.input(projectIDs: ["project"])
        XCTAssertEqual(input.query?.count, 200)
        XCTAssertEqual(input.filters?.author, "me")
        XCTAssertEqual(input.filters?.labels, [["bug", "docs"]])
        XCTAssertEqual(input.filters?.excludedLabels, ["wontfix"])
        var sorted = preferences; sorted.sort = "oldest"
        XCTAssertEqual(sorted.requestKey, preferences.requestKey)
        XCTAssertEqual(NativePullRequestPreferences.read("broken"), .init())
    }

    /// Search and sort are not filters: only a scope or a narrowing filter
    /// fills the filter button.
    func testOnlyScopesAndNarrowingFiltersCountAsActiveFilters() {
        var preferences = NativePullRequestPreferences()
        XCTAssertFalse(preferences.hasActiveFilters)
        preferences.query = "tabs"; preferences.sort = "oldest"
        XCTAssertFalse(preferences.hasActiveFilters)
        preferences.draft = "hide"
        XCTAssertTrue(preferences.hasActiveFilters)
        preferences = NativePullRequestPreferences(); preferences.projectID = "p"
        XCTAssertTrue(preferences.hasActiveFilters)
    }

    func testSavedScopeExplainsWhyItIsUnavailable() {
        let offline = FeatureEnvironment(id: "studio", name: "Studio", endpoint: "http://studio", connectionState: .disconnected, supportsPullRequests: true)
        let unsupported = FeatureEnvironment(id: "pi", name: "Pi", endpoint: "http://pi", connectionState: .connected, supportsPullRequests: false)
        let online = FeatureEnvironment(id: "mac", name: "Mac", endpoint: "http://mac", connectionState: .connected, supportsPullRequests: true)
        var preferences = NativePullRequestPreferences()
        XCTAssertNil(preferences.unavailableScopeDescription(environments: [online], projects: []))
        preferences.environmentID = "pi"
        XCTAssertEqual(preferences.unavailableScopeDescription(environments: [online, unsupported], projects: []), "Pi can't list pull requests. Choose another scope or show every project.")
        preferences.environmentID = "gone"
        XCTAssertEqual(preferences.unavailableScopeDescription(environments: [online], projects: []), "The saved environment isn't available. Reconnect it or show every project.")
        preferences.environmentID = "mac"; preferences.projectID = "missing"
        XCTAssertEqual(preferences.unavailableScopeDescription(environments: [online, offline], projects: []), "The saved project isn't available. Reconnect its environment or show every project.")
        preferences.projectID = nil
        XCTAssertEqual(preferences.summary(environments: [online], projects: []), "Mac · Open · Everyone · Merge readiness")
    }

    func testPartialEnvironmentFailuresKeepHealthyRows() async {
        let manager = PullRequestWorkspaceTestManager()
        let success = page([entry(1)])
        manager.list = { environment, _ in if environment == "two" { throw PullRequestWorkspaceTestError.offline }; return success }
        let feed = NativePullRequestWorkspaceModel()
        var preferences = NativePullRequestPreferences(); preferences.involvement = "authored"
        await feed.reload(manager: manager, environments: environments, projects: [project("one"), project("two")], preferences: preferences)
        XCTAssertEqual(feed.rows(preferences: preferences).map(\.entry.number), [1])
        XCTAssertEqual(feed.messages.count, 1)
        XCTAssertFalse(feed.loading)
    }

    func testContinuationUsesOpaqueHostCursorAndAppendsRows() async {
        let manager = PullRequestWorkspaceTestManager()
        let first = page([entry(1)], cursor: "opaque-token"), second = page([entry(2)])
        manager.list = { _, input in input.cursors == nil ? first : second }
        let feed = NativePullRequestWorkspaceModel()
        var preferences = NativePullRequestPreferences(); preferences.involvement = "authored"
        await feed.reload(manager: manager, environments: [environments[0]], projects: [project("one")], preferences: preferences)
        XCTAssertTrue(feed.hasMore)
        await feed.loadMore(manager: manager, preferences: preferences)
        XCTAssertEqual(Set(feed.rows(preferences: preferences).map(\.entry.number)), [1, 2])
        XCTAssertEqual(manager.calls.last?.1.cursors, ["github.com owner/repo": "opaque-token"])
        XCTAssertFalse(feed.hasMore)
    }

    func testPriorityGroupsAreReadBeyondTheGeneralFeedAndZeroSizeIsKnown() async {
        let manager = PullRequestWorkspaceTestManager()
        let authored = page([entry(3, author: "me")]), others = page([entry(1)])
        manager.list = { _, input in input.involvement == "authored" ? authored : others }
        manager.stats = { entries in PullRequestListStatsResult(stats: entries.map { PullRequestDiffStat(projectId: $0.projectId, repository: $0.repository, number: $0.number, additions: 0, deletions: 0) }) }
        let feed = NativePullRequestWorkspaceModel()
        await feed.reload(manager: manager, environments: [environments[0]], projects: [project("one")], preferences: .init())
        XCTAssertEqual(Set(manager.calls.map { $0.1.involvement }), ["all", "authored", "reviewing"])
        XCTAssertEqual(feed.rows(preferences: .init()).map(\.entry.number), [3, 1])
        let visible = Set(feed.rows(preferences: .init()).filter { $0.entry.number == 3 }.map(\.id))
        await feed.loadStats(visibleRowIDs: visible, manager: manager, preferences: .init())
        XCTAssertTrue(feed.rows(preferences: .init()).first { $0.entry.number == 3 }?.sizeKnown == true)
        XCTAssertFalse(feed.rows(preferences: .init()).first { $0.entry.number == 1 }?.sizeKnown == true)
        XCTAssertEqual(manager.statCalls.flatMap { $0.map(\.number) }, [3])
    }

    func testOverridesClearOnlyWhenAReadAgreesOrOutranksThem() throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let ready = try XCTUnwrap(NativePullRequestWorkspaceLogic.override(after: .ready, entry: entry(1, draft: true), now: now, token: 1))
        XCTAssertEqual(ready.state, .open)
        XCTAssertEqual(ready.isDraft, false)
        XCTAssertNil(NativePullRequestWorkspaceLogic.override(after: .updateBranch, entry: entry(1), now: now, token: 2))
        let overrides = [entry(1).id: ready]
        // A stale read that still says draft is kept for a minute, then the host's word wins.
        XCTAssertEqual(NativePullRequestWorkspaceLogic.settle(overrides, answered: [entry(1, draft: true)], now: now + 30), overrides)
        XCTAssertTrue(NativePullRequestWorkspaceLogic.settle(overrides, answered: [entry(1, draft: true)], now: now + 61).isEmpty)
        // A missing row confirms nothing; an agreeing one settles it.
        XCTAssertEqual(NativePullRequestWorkspaceLogic.settle(overrides, answered: [entry(2)], now: now + 61), overrides)
        XCTAssertTrue(NativePullRequestWorkspaceLogic.settle(overrides, answered: [entry(1)], now: now).isEmpty)
        // A drafts-only list no longer holds a pull request marked ready.
        var drafts = NativePullRequestPreferences(); drafts.draft = "only"
        XCTAssertNil(NativePullRequestWorkspaceLogic.applying(ready, to: entry(1, draft: true), preferences: drafts))
    }

    func testActionsAnswerOnTheRowAtOnceAndARefusalTakesItBack() async {
        let manager = PullRequestWorkspaceTestManager()
        let open = page([entry(1), entry(2)])
        manager.list = { _, _ in open }
        let feed = NativePullRequestWorkspaceModel()
        var preferences = NativePullRequestPreferences(); preferences.involvement = "authored"
        await feed.reload(manager: manager, environments: [environments[0]], projects: [project("one")], preferences: preferences)
        let acted = entry(1).id

        feed.noteAction("close", phase: .sent, rowID: acted)
        XCTAssertEqual(feed.rows(preferences: preferences).map(\.entry.number), [2])
        var all = preferences; all.state = "all"
        XCTAssertEqual(feed.rows(preferences: all).first { $0.id == acted }?.entry.state, .closed)
        feed.noteAction("close", phase: .failed, rowID: acted)
        XCTAssertEqual(Set(feed.rows(preferences: preferences).map(\.entry.number)), [1, 2])

        // A host may only queue a merge, so the row moves once it confirms.
        feed.noteAction("merge", phase: .sent, rowID: acted)
        XCTAssertEqual(Set(feed.rows(preferences: preferences).map(\.entry.number)), [1, 2])
        feed.noteAction("merge", phase: .done, rowID: acted)
        XCTAssertEqual(feed.rows(preferences: preferences).map(\.entry.number), [2])
    }

    func testOldSearchCannotReplaceNewerResults() async {
        let manager = PullRequestWorkspaceTestManager()
        let started = AsyncStream<Void>.makeStream()
        var blocked: CheckedContinuation<PullRequestListResult, Never>?
        let oldPage = page([entry(1)]), newPage = page([entry(2)])
        manager.list = { _, input in
            if input.query == "old" { return await withCheckedContinuation { blocked = $0; started.continuation.yield(()) } }
            return newPage
        }
        let feed = NativePullRequestWorkspaceModel()
        var old = NativePullRequestPreferences(); old.involvement = "authored"; old.query = "old"
        var new = old; new.query = "new"
        let pending = Task { await feed.reload(manager: manager, environments: [environments[0]], projects: [project("one")], preferences: old) }
        var events = started.stream.makeAsyncIterator(); _ = await events.next()
        await feed.reload(manager: manager, environments: [environments[0]], projects: [project("one")], preferences: new)
        blocked?.resume(returning: oldPage)
        await pending.value
        XCTAssertEqual(feed.rows(preferences: new).map(\.entry.number), [2])
        XCTAssertFalse(feed.loading)
        started.continuation.finish()
    }
}

private enum PullRequestWorkspaceTestError: Error { case offline, unused }

@MainActor
private final class PullRequestWorkspaceTestManager: FeatureProjectPullRequestManaging {
    var calls: [(String, PullRequestListInput)] = []
    var statCalls: [[PullRequestListEntry]] = []
    var list: (String, PullRequestListInput) async throws -> PullRequestListResult = { _, _ in throw PullRequestWorkspaceTestError.unused }
    var stats: ([PullRequestListEntry]) async throws -> PullRequestListStatsResult = { _ in .init(stats: []) }
    func listPullRequests(environmentID: String, input: PullRequestListInput) async throws -> PullRequestListResult { calls.append((environmentID, input)); return try await list(environmentID, input) }
    func pullRequestStats(environmentID: String, entries: [PullRequestListEntry]) async throws -> PullRequestListStatsResult { statCalls.append(entries); return try await stats(entries) }
    func projectPullRequestOverview(scope: FeaturePullRequestProjectScope, number: Int) async throws -> FeaturePullRequestOverview { throw PullRequestWorkspaceTestError.unused }
    func projectPullRequestLabels(scope: FeaturePullRequestProjectScope, number: Int) async throws -> PullRequestLabelCandidateList { throw PullRequestWorkspaceTestError.unused }
    func setProjectPullRequestLabels(scope: FeaturePullRequestProjectScope, number: Int, labels: [String], applied: Bool) async throws { throw PullRequestWorkspaceTestError.unused }
    func projectPullRequestStack(scope: FeaturePullRequestProjectScope, number: Int) async throws -> PullRequestStack? { throw PullRequestWorkspaceTestError.unused }
    func runProjectPullRequestStackAction(scope: FeaturePullRequestProjectScope, number: Int, stack: PullRequestStack, action: String, mergeMethod: String?) async throws { throw PullRequestWorkspaceTestError.unused }
}
