import Foundation
import XCTest
@testable import T3Code

/// Covers the Live Activity's escalated presentation, ported from
/// apps/mobile/src/widgets/AgentActivity.tsx.
final class LiveActivityEscalationTests: XCTestCase {
    // MARK: - Escalation state selection

    func testABlockedAgentEscalatesAndDemotesTheRestOfTheFleet() {
        let presentation = Self.presentation(rows: [
            Self.row(id: "working", phase: .running, status: "Working"),
            Self.row(id: "approval", phase: .waitingForApproval, status: "Approval"),
            Self.row(id: "starting", phase: .starting, status: "Starting"),
        ], activeCount: 3)

        XCTAssertEqual(presentation.escalatedRow?.threadId, "approval")
        XCTAssertEqual(presentation.heroRow?.threadId, "approval")
        XCTAssertEqual(presentation.headline, "Waiting on you")
        XCTAssertEqual(presentation.footer, "+2 other agents running")
        XCTAssertEqual(presentation.attentionCount, 1)
    }

    func testSeveralBlockedAgentsCountTheOthersAsWaitingRatherThanRunning() {
        let presentation = Self.presentation(rows: [
            Self.row(id: "input", phase: .waitingForInput, status: "Input"),
            Self.row(id: "approval", phase: .waitingForApproval, status: "Approval"),
            Self.row(id: "working", phase: .running, status: "Working"),
        ], activeCount: 3)

        XCTAssertEqual(presentation.escalatedRow?.threadId, "input")
        XCTAssertEqual(presentation.footer, "+1 more waiting on you")
        XCTAssertEqual(presentation.attentionSuffix, "2 need attention")
    }

    func testASingleBlockedAgentWithNothingElseRunningHasNoFooter() {
        let presentation = Self.presentation(rows: [
            Self.row(id: "approval", phase: .waitingForApproval, status: "Approval"),
            Self.row(id: "done", phase: .completed, status: "Done"),
        ], activeCount: 1)

        XCTAssertEqual(presentation.footer, "")
        XCTAssertEqual(presentation.attentionSuffix, "1 needs attention")
    }

    /// Failures are informational: the row list still reports them (with the red
    /// wash), but they must not take over the card.
    func testFailuresDoNotEscalateButStillLeadAsTheHeroRow() {
        let presentation = Self.presentation(rows: [
            Self.row(id: "working", phase: .running, status: "Working"),
            Self.row(id: "failed", phase: .failed, status: "Failed"),
        ], activeCount: 1)

        XCTAssertNil(presentation.escalatedRow)
        XCTAssertEqual(presentation.heroRow?.threadId, "failed")
        XCTAssertEqual(presentation.headline, "1 active agent")
        XCTAssertEqual(presentation.backgroundTint, .red)
    }

    func testAnEmptyFleetLeadsWithTheOutcomeRatherThanZeroActiveAgents() {
        let completed = Self.presentation(rows: [
            Self.row(id: "done", phase: .completed, status: "Done"),
        ], activeCount: 0)
        let failed = Self.presentation(rows: [
            Self.row(id: "done", phase: .completed, status: "Done"),
            Self.row(id: "failed", phase: .failed, status: "Failed"),
        ], activeCount: 0)

        XCTAssertTrue(completed.isAllDone)
        XCTAssertEqual(completed.headline, "Agent work completed")
        XCTAssertEqual(completed.doneLabel, "Done")
        XCTAssertEqual(completed.summary, "Done")
        // A failure anywhere dominates a newer success.
        XCTAssertEqual(failed.headline, "Agent work failed")
        XCTAssertEqual(failed.doneLabel, "Failed")
    }

    func testTheDeepLinkFollowsTheBlockedAgentRatherThanTheFirstRow() throws {
        let presentation = Self.presentation(rows: [
            Self.row(id: "working", phase: .running, status: "Working"),
            Self.row(id: "approval", phase: .waitingForApproval, status: "Approval"),
        ], activeCount: 2)

        let url = try XCTUnwrap(presentation.deepLinkURL)
        XCTAssertEqual(
            url.absoluteString,
            "\(T3SharedContainer.urlScheme)://threads?environment=env&thread=approval"
        )
    }

    func testAnAbsentAggregateFallsBackToTheUpdatingPlaceholder() {
        let presentation = T3AgentActivityPresentation(aggregate: nil)

        XCTAssertNil(presentation.heroRow)
        XCTAssertEqual(presentation.shortStatus, "Updating")
        XCTAssertEqual(presentation.subtitle, "Waiting for the latest task status.")
        XCTAssertNil(presentation.backgroundTint)
        XCTAssertNil(presentation.deepLinkURL)
    }

    // MARK: - Tint per request kind

    func testTheCardIsWashedAmberForApprovalIndigoForInputAndRedForFailure() {
        let approval = Self.presentation(
            rows: [Self.row(id: "a", phase: .waitingForApproval, status: "Approval")],
            activeCount: 1
        )
        let input = Self.presentation(
            rows: [Self.row(id: "b", phase: .waitingForInput, status: "Input")],
            activeCount: 1
        )
        let failed = Self.presentation(
            rows: [Self.row(id: "c", phase: .failed, status: "Failed")],
            activeCount: 0
        )

        XCTAssertEqual(approval.backgroundTint, .amber)
        XCTAssertEqual(input.backgroundTint, .indigo)
        XCTAssertEqual(failed.backgroundTint, .red)
        XCTAssertEqual(approval.headerTint, .amber)
        XCTAssertEqual(input.headerTint, .indigo)
        XCTAssertEqual(failed.headerTint, .red)
    }

    func testRunningAndCompletedWorkNeverWashesTheCard() {
        for phase in [T3AgentActivityPhase.running, .starting, .completed, .stale] {
            let presentation = Self.presentation(
                rows: [Self.row(id: "row", phase: phase, status: "Status")],
                activeCount: 1
            )
            XCTAssertNil(presentation.backgroundTint, "\(phase) should not wash the card")
        }
    }

    /// The always-on display wants the dimmest possible card.
    func testReducedLuminanceDropsTheWashAndFallsBackToSecondaryText() {
        let presentation = Self.presentation(
            rows: [Self.row(id: "a", phase: .waitingForApproval, status: "Approval")],
            activeCount: 1,
            isLuminanceReduced: true
        )

        XCTAssertNil(presentation.backgroundTint)
        XCTAssertEqual(presentation.headerTint, .neutral)
        XCTAssertNil(presentation.headerTint.rgb(isLightScheme: false))
        // The escalated layout itself survives; only the color is dropped.
        XCTAssertEqual(presentation.headline, "Waiting on you")
    }

    func testTheWashIsTranslucentAndPicksTheAlphaOffTheColorScheme() {
        let dark = T3AgentActivityBackgroundTint.amber.argb(isLightScheme: false)
        let light = T3AgentActivityBackgroundTint.amber.argb(isLightScheme: true)

        XCTAssertEqual(dark, 0x40F5_9E0B)
        XCTAssertEqual(light, 0x33F5_9E0B)
        // Translucent, so it tints the OS material rather than replacing it.
        XCTAssertLessThan((dark >> 24) & 0xFF, 0xFF)
        XCTAssertEqual(T3AgentActivityBackgroundTint.indigo.argb(isLightScheme: false) & 0xFF_FFFF, 0x6366F1)
        XCTAssertEqual(T3AgentActivityBackgroundTint.red.argb(isLightScheme: false) & 0xFF_FFFF, 0xEF4444)
    }

    func testForegroundTintsCarryTheWebPalettesLightAndDarkVariants() {
        XCTAssertEqual(T3AgentActivityTint.amber.rgb(isLightScheme: true), 0xD977_06)
        XCTAssertEqual(T3AgentActivityTint.amber.rgb(isLightScheme: false), 0xFCD3_4D)
        XCTAssertEqual(T3AgentActivityTint.forPhase(.waitingForInput), .indigo)
        XCTAssertEqual(T3AgentActivityTint.forPhase(.completed), .emerald)
        XCTAssertEqual(T3AgentActivityTint.forPhase(.running), .sky)
        XCTAssertEqual(T3AgentActivityTint.forPhase(nil), .sky)
        XCTAssertEqual(T3AgentActivityTint.forPhase(.failed, isLuminanceReduced: true), .neutral)
    }

    // MARK: - Live elapsed counter

    func testTheElapsedCounterParsesBothRelayAndLocallyArmedTimestamps() throws {
        let fractional = Self.row(
            id: "relay",
            phase: .waitingForApproval,
            status: "Approval",
            updatedAt: "2026-08-01T12:00:00.000Z"
        )
        let plain = Self.row(
            id: "local",
            phase: .waitingForApproval,
            status: "Approval",
            updatedAt: "2026-08-01T12:00:00Z"
        )
        let unparseable = Self.row(
            id: "broken",
            phase: .waitingForApproval,
            status: "Approval",
            updatedAt: "not a date"
        )

        XCTAssertEqual(try XCTUnwrap(fractional.phaseSince), try XCTUnwrap(plain.phaseSince))
        // A dangling "·" separator is exactly what the nil case prevents.
        XCTAssertNil(unparseable.phaseSince)
    }

    // MARK: - Dynamic Island short status

    func testTheCompactStatusNamesTheBlockingKindBeforeTheFleetCount() {
        XCTAssertEqual(
            Self.presentation(
                rows: [Self.row(id: "a", phase: .waitingForApproval, status: "Approval")],
                activeCount: 2
            ).shortStatus,
            "Approval"
        )
        XCTAssertEqual(
            Self.presentation(
                rows: [Self.row(id: "b", phase: .waitingForInput, status: "Input")],
                activeCount: 2
            ).shortStatus,
            "Input"
        )
        XCTAssertEqual(
            Self.presentation(
                rows: [Self.row(id: "c", phase: .running, status: "Working")],
                activeCount: 2
            ).shortStatus,
            "2 active"
        )
    }

    // MARK: - Fixtures

    private static func presentation(
        rows: [T3RelayAgentActivityAggregateRow],
        activeCount: Int,
        isLuminanceReduced: Bool = false
    ) -> T3AgentActivityPresentation {
        T3AgentActivityPresentation(
            aggregate: T3RelayAgentActivityAggregateState(
                title: "T3 Code",
                subtitle: "subtitle",
                activeCount: activeCount,
                updatedAt: "2026-08-01T12:00:00.000Z",
                activities: rows
            ),
            isLuminanceReduced: isLuminanceReduced
        )
    }

    private static func row(
        id: String,
        phase: T3AgentActivityPhase,
        status: String,
        updatedAt: String = "2026-08-01T12:00:00.000Z"
    ) -> T3RelayAgentActivityAggregateRow {
        T3RelayAgentActivityAggregateRow(
            environmentId: "env",
            threadId: id,
            projectTitle: "t3code",
            threadTitle: "Task \(id)",
            modelTitle: "Claude Opus 5",
            phase: phase,
            status: status,
            updatedAt: updatedAt,
            deepLink: "/env/\(id)"
        )
    }
}
