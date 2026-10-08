import XCTest

@testable import T3Code

final class SyncSnapshotCacheTests: XCTestCase {
    private var directory: URL!
    private var clock: CacheTestClock!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-sync-cache-\(UUID().uuidString)", isDirectory: true)
        clock = CacheTestClock()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A fresh instance reads from disk, as the next launch would.
    private func cache(
        build: String = "1",
        limits: SyncSnapshotCache.Limits = SyncSnapshotCache.Limits()
    ) -> SyncSnapshotCache {
        let clock = clock!
        return SyncSnapshotCache(directory: directory, build: build, limits: limits) {
            clock.tick()
        }
    }

    /// Resuming after the cached sequence is only sound if every field the
    /// server sent survives the disk: a dropped one would never be replayed.
    func testWireProjectionAndShellSurviveTheDisk() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/orchestrationV2Projection.json")
        let projection = try JSONDecoder.t3.decode(
            OrchestrationV2ThreadProjection.self,
            from: Data(contentsOf: url)
        )
        let shell = V2Fixture.shellSnapshot(
            sequence: 12,
            projects: [V2Fixture.project()],
            threads: [V2Fixture.threadShell(id: projection.thread.id)]
        )
        let writer = cache()
        await writer.saveShell(shell, environmentID: "env").value
        await writer.saveThread(projection, sequence: 9, environmentID: "env", threadID: projection.thread.id)?.value

        let reader = cache()
        let thread = await reader.thread(environmentID: "env", threadID: projection.thread.id)
        XCTAssertEqual(thread, SyncSnapshotCache.ThreadSnapshot(sequence: 9, projection: projection))
        let cachedShell = await reader.shell(environmentID: "env")
        XCTAssertEqual(cachedShell, shell)
    }

    func testAnOlderSequenceNeverRewindsTheEntry() async {
        let newer = V2Fixture.projection(items: [V2Fixture.assistantMessage(id: "a", text: "newer")])
        let older = V2Fixture.projection()
        let writer = cache()
        await writer.saveThread(newer, sequence: 8, environmentID: "env", threadID: "thread-v2")?.value
        await writer.saveThread(older, sequence: 5, environmentID: "env", threadID: "thread-v2")?.value

        let held = await writer.thread(environmentID: "env", threadID: "thread-v2")
        XCTAssertEqual(held?.sequence, 8)
        let reread = await cache().thread(environmentID: "env", threadID: "thread-v2")
        XCTAssertEqual(reread?.sequence, 8)
        XCTAssertEqual(reread?.projection, newer)
    }

    /// Another build's models could decode an old file with fields silently
    /// defaulted, so its entries are not trusted.
    func testEntriesFromAnotherBuildAreDiscarded() async {
        let writer = cache(build: "1")
        await writer.saveThread(V2Fixture.projection(), sequence: 3, environmentID: "env", threadID: "thread-v2")?.value
        await writer.saveShell(V2Fixture.shellSnapshot(threads: [V2Fixture.threadShell()]), environmentID: "env").value

        let upgraded = cache(build: "2")
        let thread = await upgraded.thread(environmentID: "env", threadID: "thread-v2")
        let shell = await upgraded.shell(environmentID: "env")
        XCTAssertNil(thread)
        XCTAssertNil(shell)
        // Dropped, not just skipped: going back to the old build finds nothing.
        let downgraded = await cache(build: "1").thread(environmentID: "env", threadID: "thread-v2")
        XCTAssertNil(downgraded)
    }

    func testTheLeastRecentlyOpenedThreadIsEvictedFirst() async {
        var limits = SyncSnapshotCache.Limits()
        limits.maxThreads = 2
        let first = cache(limits: limits)
        await first.saveThread(V2Fixture.projection(thread: V2Fixture.appThread(id: "a")), sequence: 1, environmentID: "env", threadID: "a")?.value
        await first.saveThread(V2Fixture.projection(thread: V2Fixture.appThread(id: "b")), sequence: 1, environmentID: "env", threadID: "b")?.value
        // Opening "a" again (after a relaunch) makes "b" the oldest.
        let relaunched = cache(limits: limits)
        _ = await relaunched.thread(environmentID: "env", threadID: "a")
        await relaunched.saveThread(V2Fixture.projection(thread: V2Fixture.appThread(id: "c")), sequence: 1, environmentID: "other", threadID: "c")?.value

        let reader = cache(limits: limits)
        let a = await reader.thread(environmentID: "env", threadID: "a")
        let b = await reader.thread(environmentID: "env", threadID: "b")
        let c = await reader.thread(environmentID: "other", threadID: "c")
        XCTAssertNotNil(a)
        XCTAssertNil(b)
        XCTAssertNotNil(c)
    }

    /// Deleted and archived threads leave the active shell; their cached
    /// transcripts go with them.
    func testSavingAShellDropsThreadsItNoLongerLists() async {
        let writer = cache()
        for id in ["kept", "archived"] {
            await writer.saveThread(V2Fixture.projection(thread: V2Fixture.appThread(id: id)), sequence: 2, environmentID: "env", threadID: id)?.value
        }
        await writer.saveThread(V2Fixture.projection(thread: V2Fixture.appThread(id: "elsewhere")), sequence: 2, environmentID: "other", threadID: "elsewhere")?.value
        await writer.saveShell(V2Fixture.shellSnapshot(threads: [V2Fixture.threadShell(id: "kept")]), environmentID: "env").value

        let memoryKept = await writer.thread(environmentID: "env", threadID: "kept")
        let memoryArchived = await writer.thread(environmentID: "env", threadID: "archived")
        XCTAssertNotNil(memoryKept)
        XCTAssertNil(memoryArchived)
        let reader = cache()
        let kept = await reader.thread(environmentID: "env", threadID: "kept")
        let archived = await reader.thread(environmentID: "env", threadID: "archived")
        let elsewhere = await reader.thread(environmentID: "other", threadID: "elsewhere")
        XCTAssertNotNil(kept)
        XCTAssertNil(archived)
        XCTAssertNotNil(elsewhere)
    }

    /// A launch reply paints the first open but has no resume cursor, so it
    /// never reaches disk and a shell that predates the launch keeps it.
    func testALaunchSeedPaintsInMemoryOnly() async {
        let projection = V2Fixture.projection(thread: V2Fixture.appThread(id: "new"))
        let writer = cache()
        writer.seedThread(projection, environmentID: "env", threadID: "new")
        await writer.saveShell(V2Fixture.shellSnapshot(threads: []), environmentID: "env").value

        let seeded = await writer.thread(environmentID: "env", threadID: "new")
        XCTAssertEqual(seeded, SyncSnapshotCache.ThreadSnapshot(sequence: nil, projection: projection))
        let reread = await cache().thread(environmentID: "env", threadID: "new")
        XCTAssertNil(reread)
    }

    func testRemovingAnEnvironmentDropsItsShellAndThreads() async {
        let writer = cache()
        await writer.saveShell(V2Fixture.shellSnapshot(threads: [V2Fixture.threadShell()]), environmentID: "env").value
        await writer.saveThread(V2Fixture.projection(), sequence: 4, environmentID: "env", threadID: "thread-v2")?.value
        await writer.saveThread(V2Fixture.projection(), sequence: 4, environmentID: "other", threadID: "thread-v2")?.value
        await writer.removeEnvironment("env")

        let memory = await writer.thread(environmentID: "env", threadID: "thread-v2")
        XCTAssertNil(memory)
        let reader = cache()
        let shell = await reader.shell(environmentID: "env")
        let thread = await reader.thread(environmentID: "env", threadID: "thread-v2")
        let other = await reader.thread(environmentID: "other", threadID: "thread-v2")
        XCTAssertNil(shell)
        XCTAssertNil(thread)
        XCTAssertNotNil(other)
    }

    /// The full history after "load earlier" is not written; the windowed
    /// entry from before stays, still consistent with its own sequence.
    func testAnUnwindowedHistoryKeepsThePreviousEntryOnDisk() async {
        var limits = SyncSnapshotCache.Limits()
        limits.maxVisibleItems = 1
        let windowed = V2Fixture.projection(items: [V2Fixture.assistantMessage(id: "a", text: "a")])
        let full = V2Fixture.projection(items: [
            V2Fixture.assistantMessage(id: "a", text: "a"),
            V2Fixture.assistantMessage(id: "b", text: "b"),
        ])
        let writer = cache(limits: limits)
        await writer.saveThread(windowed, sequence: 3, environmentID: "env", threadID: "thread-v2")?.value
        await writer.saveThread(full, sequence: 4, environmentID: "env", threadID: "thread-v2")?.value

        let reread = await cache(limits: limits).thread(environmentID: "env", threadID: "thread-v2")
        XCTAssertEqual(reread, SyncSnapshotCache.ThreadSnapshot(sequence: 3, projection: windowed))
    }
}

/// Hands out a later instant on every read, so last-use order is the call
/// order without sleeping.
private final class CacheTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var seconds: TimeInterval = 1_000

    func tick() -> Date {
        lock.lock()
        defer { lock.unlock() }
        seconds += 1
        return Date(timeIntervalSince1970: seconds)
    }
}
