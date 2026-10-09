import XCTest

@testable import T3Code

/// Ports client-runtime's `presentPendingBackgroundWork` cases (upstream
/// b9ffe49c61, 151c241cd2, a5b34b2537) and the status rule from f68e24fb41:
/// only work that wakes the agent holds a thread in Background.
final class PendingBackgroundWorkTests: XCTestCase {
    private typealias Entry = OrchestrationV2PendingBackgroundTask

    private func title(_ tasks: [Entry]) -> String? {
        PendingBackgroundWorkPresentation(tasks)?.title
    }

    func testFormatsSubagentPathsAsDisplayNames() {
        for description in [
            "/root/luna_window_properties",
            "Subagent: /root/luna_window_properties",
            "/root/parent/luna_window_properties",
        ] {
            let presentation = PendingBackgroundWorkPresentation([
                Entry(taskId: "luna", description: description, kind: .subagent, childThreadId: "thread:luna"),
            ])
            XCTAssertEqual(presentation?.title, "Waiting on subagent Luna Window Properties", description)
            XCTAssertEqual(presentation?.items.first?.childThreadId, "thread:luna")
            XCTAssertEqual(presentation?.waiting, true)
        }
        XCTAssertEqual(SubagentDisplayTitle.format("Review src/math.ts"), "Review src/math.ts")
        XCTAssertEqual(SubagentDisplayTitle.format("/root//broken"), "/root//broken")
    }

    func testAnUnnamedSubagentFallsBackToItsNoun() {
        for description in ["Subagent:", "Subagent:   "] {
            let presentation = PendingBackgroundWorkPresentation([
                Entry(taskId: "unnamed", description: description, kind: .subagent),
            ])
            XCTAssertEqual(presentation?.title, "Waiting on a subagent")
            XCTAssertEqual(presentation?.items.first?.label, "subagent")
        }
    }

    func testNamesASinglePieceOfWorkByKind() {
        XCTAssertEqual(
            title([Entry(taskId: "a", description: "Review src/math.ts", kind: .subagent)]),
            "Waiting on subagent Review src/math.ts"
        )
        XCTAssertEqual(title([Entry(taskId: "a", kind: .monitor)]), "Waiting on a monitor")
        XCTAssertNil(PendingBackgroundWorkPresentation([]))
    }

    /// A command left running, such as a dev server, does not wake the agent.
    func testCommandsOnlyAreRunningNotWaitedOn() {
        let devServer = PendingBackgroundWorkPresentation([
            Entry(taskId: "dev", description: "Start the shared dev server", kind: .command),
        ])
        XCTAssertEqual(devServer?.title, "Running: Start the shared dev server")
        XCTAssertEqual(devServer?.waiting, false)
        XCTAssertEqual(title([Entry(taskId: "a", kind: .command)]), "Running a command")
        XCTAssertEqual(
            title([
                Entry(taskId: "a", description: "vp run dev", kind: .command),
                Entry(taskId: "b", description: "tailscale serve", kind: .command),
            ]),
            "Running 2 commands"
        )
        XCTAssertEqual(
            title([
                Entry(taskId: "a", description: "vp run dev", kind: .command),
                Entry(taskId: "b", description: "Watch PR checks", kind: .monitor),
            ]),
            "Waiting on 1 command and 1 monitor"
        )
    }

    func testGroupsWorkByKindSubagentsFirstAndKeepsEachName() throws {
        let presentation = try XCTUnwrap(PendingBackgroundWorkPresentation([
            Entry(taskId: "cmd", description: "/root/run_tests", kind: .command),
            Entry(taskId: "b", description: "Write tests", kind: .subagent, childThreadId: "thread:b"),
            Entry(taskId: "a", description: "/root/luna_window_properties", kind: .subagent),
            Entry(taskId: "x", description: "Scheduled wakeup", kind: .backgroundTask),
        ]))
        XCTAssertEqual(presentation.title, "Waiting on 2 subagents, 1 command and 1 background task")
        XCTAssertEqual(presentation.items.map(\.label), [
            "Write tests", "Luna Window Properties", "/root/run_tests", "Scheduled wakeup",
        ])
        XCTAssertEqual(presentation.items.map(\.childThreadId), ["thread:b", nil, nil, nil])
    }

    /// A Background row's header names what it waits on; nothing else does.
    func testOnlyABackgroundThreadNamesItsWork() {
        func thread(_ tasks: [Entry]?, count: Int) -> FeatureThread {
            FeatureThread(
                id: "thread", projectID: "project", title: "Thread",
                backgroundWorkCount: count, pendingBackgroundTasks: tasks
            )
        }
        XCTAssertEqual(
            thread([Entry(taskId: "a", description: "/root/review_diff", kind: .subagent)], count: 1)
                .backgroundWorkStatusTitle,
            "Waiting on subagent Review Diff"
        )
        XCTAssertNil(thread([Entry(taskId: "dev", description: "vp run dev", kind: .command)], count: 1).backgroundWorkStatusTitle)
        XCTAssertNil(thread(nil, count: 1).backgroundWorkStatusTitle)
    }

    /// A dev server left running keeps the row Ready but still marks it;
    /// a Background row already names its commands in its status.
    func testRunningCommandsMarkARowThatIsNotInBackground() {
        func thread(_ tasks: [Entry]?, count: Int) -> FeatureThread {
            FeatureThread(
                id: "thread", projectID: "project", title: "Thread",
                backgroundWorkCount: count, pendingBackgroundTasks: tasks
            )
        }
        let devServer = thread([Entry(taskId: "dev", description: "vp run dev", kind: .command)], count: 1)
        XCTAssertEqual(devServer.homeStatus, .ready)
        XCTAssertEqual(devServer.runningBackgroundCommands.map(\.taskId), ["dev"])
        XCTAssertEqual(devServer.runningBackgroundCommandsTitle, "Running: vp run dev")

        let mixed = thread([
            Entry(taskId: "dev", description: "vp run dev", kind: .command),
            Entry(taskId: "watch", description: "Watch PR checks", kind: .monitor),
        ], count: 2)
        XCTAssertEqual(mixed.homeStatus, .background)
        XCTAssertEqual(mixed.runningBackgroundCommands.count, 1)
        XCTAssertNil(mixed.runningBackgroundCommandsTitle)

        XCTAssertTrue(thread(nil, count: 1).runningBackgroundCommands.isEmpty)
        XCTAssertTrue(thread([], count: 0).runningBackgroundCommands.isEmpty)
    }
}
