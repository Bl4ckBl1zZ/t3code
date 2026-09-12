import XCTest
@testable import T3Code

@MainActor
final class PullRequestWorkspaceTests: XCTestCase {
    private let environments = [FeatureEnvironment(id: "one", name: "One", endpoint: "https://one.test", isActive: true, supportsPullRequests: true), FeatureEnvironment(id: "two", name: "Two", endpoint: "https://two.test", supportsPullRequests: true)]
    private func project(_ environment: String, _ wireID: String = "project", canonical: String? = nil) -> FeatureProject {
        FeatureProject(id: FeatureScopedID.project(environmentID: environment, wireID: wireID), wireID: wireID,
            environmentID: environment, name: "Project", path: "/work/project", repositoryCanonicalKey: canonical)
    }
    private func entry(_ number: Int, host: String = "github.com", projectID: String = "project", title: String = "Change", author: String = "other", reviewRequested: Bool = false, checks: String? = nil, review: String? = nil, conflict: Bool = false, additions: Int = 0, date: String = "2026-09-10T12:00:00.000Z") -> PullRequestListEntry {
        PullRequestListEntry(provider: "github", host: host, projectId: projectID, projectTitle: "Project", repository: "owner/repo", number: number,
            title: title, url: "https://\(host)/owner/repo/pull/\(number)", author: PullRequestActor(login: author, name: nil, avatarUrl: nil),
            headBranch: "feature-\(number)", baseBranch: "main", state: .open, isDraft: false, mergeability: conflict ? .conflicting : .mergeable,
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
