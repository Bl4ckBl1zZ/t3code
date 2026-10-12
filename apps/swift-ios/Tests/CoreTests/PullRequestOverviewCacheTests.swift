import XCTest
@testable import T3Code

final class PullRequestOverviewCacheTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("pr-cache-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func overview() throws -> FeaturePullRequestOverview {
        struct Fixture: Decodable { let detail: PullRequestDetail }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/pullRequestActions.json")
        return FeaturePullRequestOverview(detail: try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).detail, activity: nil)
    }

    private func key(_ number: Int, environment: String = "env-1", repository: String = "Owner/Repo") -> PullRequestOverviewCache.Key {
        .init(environmentID: environment, projectID: "project-1", repository: repository, number: number)
    }

    func testASavedOverviewComesBackMarkedWithWhenItWasSaved() async throws {
        let cache = PullRequestOverviewCache(directory: directory, build: "1")
        let saved = try overview()
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        await cache.save(saved, for: key(1), at: date)
        let read = await cache.overview(for: key(1, repository: "owner/repo"))
        XCTAssertEqual(read?.detail, saved.detail)
        XCTAssertEqual(read?.savedAt, date)
        let missing = await cache.overview(for: key(2))
        XCTAssertNil(missing)
    }

    func testTheLeastRecentlySavedEntryIsEvictedFirst() async throws {
        let cache = PullRequestOverviewCache(directory: directory, build: "1", maxEntries: 2)
        let saved = try overview()
        await cache.save(saved, for: key(1), at: Date(timeIntervalSince1970: 1))
        await cache.save(saved, for: key(2, environment: "env-2"), at: Date(timeIntervalSince1970: 2))
        await cache.save(saved, for: key(1), at: Date(timeIntervalSince1970: 3))
        await cache.save(saved, for: key(3), at: Date(timeIntervalSince1970: 4))
        let first = await cache.overview(for: key(1)), second = await cache.overview(for: key(2, environment: "env-2")), third = await cache.overview(for: key(3))
        XCTAssertNotNil(first)
        XCTAssertNil(second)
        XCTAssertNotNil(third)
    }

    func testAnOversizedOverviewIsNotKeptAndDropsTheOlderCopy() async throws {
        let saved = try overview()
        await PullRequestOverviewCache(directory: directory, build: "1").save(saved, for: key(1))
        let small = PullRequestOverviewCache(directory: directory, build: "1", maxEntryBytes: 16)
        await small.save(saved, for: key(1))
        let read = await small.overview(for: key(1))
        XCTAssertNil(read)
    }

    func testRemovingAnEnvironmentDropsOnlyItsEntries() async throws {
        let cache = PullRequestOverviewCache(directory: directory, build: "1")
        let saved = try overview()
        await cache.save(saved, for: key(1))
        await cache.save(saved, for: key(1, environment: "env-2"))
        await cache.removeEnvironment("env-1")
        let removed = await cache.overview(for: key(1)), kept = await cache.overview(for: key(1, environment: "env-2"))
        XCTAssertNil(removed)
        XCTAssertNotNil(kept)
    }

    func testAnotherBuildsEntriesAreIgnoredAndSwept() async throws {
        let saved = try overview()
        await PullRequestOverviewCache(directory: directory, build: "1").save(saved, for: key(1))
        let next = PullRequestOverviewCache(directory: directory, build: "2")
        let stale = await next.overview(for: key(1))
        XCTAssertNil(stale)
        await next.save(saved, for: key(2))
        let swept = await PullRequestOverviewCache(directory: directory, build: "1").overview(for: key(1))
        XCTAssertNil(swept)
    }

    func testOnlyConnectionFailuresFallBackToTheSavedCopy() {
        XCTAssertTrue(PullRequestOverviewCache.isOffline(RPCError.disconnected))
        XCTAssertTrue(PullRequestOverviewCache.isOffline(RPCError.connectionUnavailable))
        XCTAssertTrue(PullRequestOverviewCache.isOffline(URLError(.notConnectedToInternet)))
        XCTAssertFalse(PullRequestOverviewCache.isOffline(RPCError.remote("Not found")))
        XCTAssertFalse(PullRequestOverviewCache.isOffline(CancellationError()))
    }
}
