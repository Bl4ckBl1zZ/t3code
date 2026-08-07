import XCTest

@testable import T3Code

/// Ports the work-section half of
/// apps/mobile/src/features/threads/threadListV2.test.ts
/// (`withWorkSectionHeaders` via `buildThreadListV2ListItems`).
final class WorkInboxSectionsTests: XCTestCase {
    private func thread(
        id: String,
        state: FeatureThreadState = .idle
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: "project-1",
            environmentID: "environment:local",
            title: id,
            state: state,
            providerID: "hermes",
            modelID: "default"
        )
    }

    func testInboxOrderPutsMainFirstAndBlockedWorkAheadOfOrdinaryWork() {
        XCTAssertEqual(
            WorkInboxSections.ordered.map(\.section),
            [.main, .needsYou, .active]
        )
        XCTAssertEqual(
            WorkInboxSections.ordered.map(\.label),
            ["Main", "Needs you", "Active"]
        )
    }

    func testOnlyBlockedWorkDrawsInTheAttentionTone() {
        // Three loud labels would mark nothing, so exactly one earns colour.
        XCTAssertEqual(
            WorkInboxSections.ordered.filter { $0.tone == .attention }.map(\.section),
            [.needsYou]
        )
    }

    func testSectionKeysMatchTheReactNativeListSoLayoutsCorrespond() {
        XCTAssertEqual(
            WorkInboxSections.ordered.map(\.id),
            [
                "v2-work-section:main",
                "v2-work-section:needs-you",
                "v2-work-section:active",
            ]
        )
    }

    func testGroupsTheActiveBlockAndKeepsEachSectionsIncomingOrder() {
        let rows = [
            thread(id: "active-first"),
            thread(id: "approval", state: .waitingForApproval),
            thread(id: "main"),
            thread(id: "input", state: .waitingForInput),
            thread(id: "active-second"),
        ]

        let groups = WorkInboxSections.groups(
            active: rows,
            workInboxRole: { thread in thread.id == "main" ? "main" : nil }
        )

        XCTAssertEqual(groups.map(\.header.section), [.main, .needsYou, .active])
        XCTAssertEqual(groups.map { $0.rows.map(\.id) }, [
            ["main"],
            ["approval", "input"],
            ["active-first", "active-second"],
        ])
    }

    func testSectionsWithNoRowsAreOmittedEntirelySoAnEmptyInboxStaysQuiet() {
        let groups = WorkInboxSections.groups(active: [thread(id: "only-active")])

        XCTAssertEqual(groups.map(\.header.section), [.active])
    }

    func testAnEmptyActiveBlockProducesNoHeadersAtAll() {
        XCTAssertTrue(WorkInboxSections.groups(active: [FeatureThread]()).isEmpty)
    }

    func testMainOutranksBlockedWorkSoThePinnedThreadNeverLeavesTheTop() {
        // The always-pinned Work thread is the inbox's anchor; letting an
        // approval move it would make the list's first row unpredictable.
        XCTAssertEqual(
            WorkInboxSections.section(
                of: thread(id: "main", state: .waitingForApproval),
                workInboxRole: "main"
            ),
            .main
        )
        XCTAssertEqual(
            WorkInboxSections.section(of: thread(id: "blocked", state: .waitingForInput)),
            .needsYou
        )
        XCTAssertEqual(
            WorkInboxSections.section(of: thread(id: "working", state: .working)),
            .active
        )
    }
}
