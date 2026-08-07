import XCTest

@testable import T3Code

/// Ports apps/mobile/src/features/home/threadArchive.test.ts. Archiving detaches
/// the provider, so the queued-versus-active distinction below is the whole
/// point of the module.
final class ThreadArchiveTests: XCTestCase {
    private func runtime(_ status: String, _ activeRunID: String?) -> ThreadArchive.Runtime {
        ThreadArchive.Runtime(status: status, activeRunID: activeRunID)
    }

    func testProviderActiveWorkCannotBeArchived() {
        let activeRunID = "run-live"
        XCTAssertFalse(ThreadArchive.canArchive(runtime("preparing", activeRunID)))
        XCTAssertFalse(ThreadArchive.canArchive(runtime("starting", activeRunID)))
        XCTAssertFalse(ThreadArchive.canArchive(runtime("running", activeRunID)))
    }

    func testQueuedWorkArchivesOnlyWhenNoProviderRunRemainsActive() {
        XCTAssertTrue(ThreadArchive.canArchive(runtime("queued", nil)))
        XCTAssertFalse(ThreadArchive.canArchive(runtime("queued", "run-live")))
    }

    func testPostProviderWaitingWorkArchivesDespiteARetainedActiveRunID() {
        XCTAssertTrue(ThreadArchive.canArchive(runtime("waiting", nil)))
        XCTAssertTrue(ThreadArchive.canArchive(runtime("waiting", "run-finished")))
    }

    func testIdleAndAbsentRuntimesArchive() {
        XCTAssertTrue(ThreadArchive.canArchive(runtime("idle", nil)))
        XCTAssertTrue(ThreadArchive.canArchive(nil))
    }

    func testShellsAreGatedByTheirOwnRunStatus() {
        // A thread that never reached a provider has no runtime at all.
        let untouched = V2Fixture.threadShell(status: "idle", activeRunID: nil)
        XCTAssertNil(ThreadArchive.Runtime(shell: untouched))
        XCTAssertTrue(ThreadArchive.canArchive(shell: untouched))

        XCTAssertFalse(
            ThreadArchive.canArchive(
                shell: V2Fixture.threadShell(status: "running", activeRunID: "run-live")
            )
        )
        XCTAssertFalse(
            ThreadArchive.canArchive(
                shell: V2Fixture.threadShell(status: "queued", activeRunID: "run-live")
            )
        )
    }
}
