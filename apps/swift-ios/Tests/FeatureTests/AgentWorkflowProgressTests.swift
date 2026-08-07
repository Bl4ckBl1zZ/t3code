import XCTest

@testable import T3Code

/// Ports the workflowPhaseProgress and formatTokenCount suites from
/// apps/web/src/components/agentsPanel.logic.test.ts. The numbers come from
/// packages/shared/src/workflowObservability.ts on web and React Native, and a
/// phase counter that means one thing on desktop and another on a phone is
/// worse than no counter.
final class AgentWorkflowProgressTests: XCTestCase {
    private func phases(_ titles: [String]) -> [AgentWorkflowPhase] {
        titles.enumerated().map { AgentWorkflowPhase(index: $0.offset, title: $0.element) }
    }

    func testReturnsNilWhenNoPhasesWereDeclared() {
        XCTAssertNil(WorkflowObservability.phaseProgress(nil))
        XCTAssertNil(WorkflowObservability.phaseProgress(AgentWorkflowProgress()))
        XCTAssertNil(
            WorkflowObservability.phaseProgress(
                AgentWorkflowProgress(phases: [], currentPhase: "Scan")
            )
        )
    }

    func testResolvesPositionByTitle() {
        let progress = WorkflowObservability.phaseProgress(
            AgentWorkflowProgress(phases: phases(["Scan", "Fix", "Verify"]), currentPhase: "Fix")
        )
        XCTAssertEqual(progress, WorkflowPhaseProgress(current: 2, total: 3))
    }

    func testReportsProgressRunningBackwardsWhenAScriptRevisitsAPhase() {
        // Honest over monotonic: the workflow really is back in phase 1.
        let progress = WorkflowObservability.phaseProgress(
            AgentWorkflowProgress(phases: phases(["Scan", "Fix"]), currentPhase: "Scan")
        )
        XCTAssertEqual(progress, WorkflowPhaseProgress(current: 1, total: 2))
    }

    func testCountsAnUndeclaredCurrentPhaseAsStartedRatherThanDroppingIt() {
        let progress = WorkflowObservability.phaseProgress(
            AgentWorkflowProgress(phases: phases(["Scan"]), currentPhase: "Improvised")
        )
        XCTAssertEqual(progress, WorkflowPhaseProgress(current: 1, total: 1))
    }

    func testReportsZeroProgressBeforeAnyPhaseIsEntered() {
        let progress = WorkflowObservability.phaseProgress(
            AgentWorkflowProgress(phases: phases(["Scan"]))
        )
        XCTAssertEqual(progress, WorkflowPhaseProgress(current: 0, total: 1))
    }

    func testKeepsSmallTokenCountsExact() {
        XCTAssertEqual(WorkflowObservability.formatTokenCount(0), "0")
        XCTAssertEqual(WorkflowObservability.formatTokenCount(999), "999")
    }

    func testCompactsThousandsAndMillions() {
        XCTAssertEqual(WorkflowObservability.formatTokenCount(1000), "1.0k")
        XCTAssertEqual(WorkflowObservability.formatTokenCount(1234), "1.2k")
        XCTAssertEqual(WorkflowObservability.formatTokenCount(9999), "10.0k")
        XCTAssertEqual(WorkflowObservability.formatTokenCount(45_000), "45k")
        XCTAssertEqual(WorkflowObservability.formatTokenCount(999_999), "1000k")
        XCTAssertEqual(WorkflowObservability.formatTokenCount(1_000_000), "1.0M")
        // Exactly representable in binary, where %.1f alone would round to even
        // and disagree with the other clients' toFixed.
        XCTAssertEqual(WorkflowObservability.formatTokenCount(1_250_000), "1.3M")
        XCTAssertEqual(WorkflowObservability.formatTokenCount(45_000_000), "45M")
    }
}
