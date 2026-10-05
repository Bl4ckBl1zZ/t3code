import XCTest

@testable import T3Code

/// Upstream f68e24fb41 / a5b34b2537 / 82f884d925 on Home: only background work
/// that wakes the agent (subagents, monitors) holds a thread in Background. A
/// dev server left running reads as ready, and its finished turn as done.
final class BackgroundWorkStatusTests: XCTestCase {
    private typealias Entry = OrchestrationV2PendingBackgroundTask

    private func thread(
        state: FeatureThreadState = .idle,
        count: Int? = nil,
        tasks: [Entry]? = nil
    ) -> FeatureThread {
        FeatureThread(
            id: "thread",
            projectID: "project",
            title: "Thread",
            state: state,
            backgroundWorkCount: count,
            pendingBackgroundTasks: tasks
        )
    }

    func testADevServerLeftRunningReadsAsReady() {
        let devServer = thread(count: 1, tasks: [Entry(taskId: "dev", description: "vp run dev", kind: .command)])
        XCTAssertEqual(devServer.homeStatus, .ready)
        XCTAssertFalse(devServer.isHomeWorking)
        XCTAssertNil(devServer.workInboxBadge)

        // Its finished turn still reads as done, like any other.
        let finished = thread(state: .completed, count: 1, tasks: devServer.pendingBackgroundTasks)
        XCTAssertEqual(finished.homeStatus, .done)
        XCTAssertEqual(finished.workInboxBadge, .done)
    }

    func testWorkThatWakesTheAgentHoldsTheThread() {
        for kind in [Entry.Kind.subagent, .monitor, .backgroundTask] {
            let held = thread(count: 2, tasks: [
                Entry(taskId: "dev", kind: .command),
                Entry(taskId: "wake", kind: kind),
            ])
            XCTAssertEqual(held.homeStatus, .background, "\(kind)")
            XCTAssertTrue(held.isHomeWorking)
            XCTAssertEqual(held.workInboxBadge, .working)
        }
    }

    /// A server that predates the list only sends counts, which cannot tell a
    /// command from a monitor, so any live work holds as before.
    func testOlderServersKeepTheCountRule() {
        XCTAssertEqual(thread(count: 1).homeStatus, .background)
        XCTAssertEqual(thread(count: 0).homeStatus, .ready)
        XCTAssertEqual(thread().homeStatus, .ready)
        // An empty list from a current server is authoritative over a stale count.
        XCTAssertEqual(thread(count: 1, tasks: []).homeStatus, .ready)
    }
}
