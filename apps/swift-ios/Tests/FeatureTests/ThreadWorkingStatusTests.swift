import Foundation
import Testing
@testable import T3Code

/// The line the composer wears while a turn runs. It replaced a static
/// "Agent is working" row, so what it must not do is claim work that is not
/// happening: a preparing run says it is starting, and a run whose newest live
/// item belongs to an interrupted attempt says nothing about that item.
@Suite("Thread working status")
struct ThreadWorkingStatusTests {
    private let startedAt = Date(timeIntervalSince1970: 10_000)

    private func projected(
        _ item: OrchestrationV2TurnItem,
        position: Int = 0
    ) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: position,
            visibility: .local,
            sourceThreadId: "thread-v2",
            sourceItemId: item.id,
            item: item
        )
    }

    private func command(
        _ id: String,
        title: String,
        status: String,
        runID: String = "run-1",
        position: Int = 0
    ) -> OrchestrationV2ProjectedTurnItem {
        projected(
            V2Fixture.turnItem(
                id: id,
                type: "command_execution",
                status: status,
                extra: [
                    "runId": .string(runID),
                    "title": .string(title),
                    "input": .string("vp test run"),
                ]
            ),
            position: position
        )
    }

    private func resolve(
        state: FeatureThreadState,
        items: [OrchestrationV2ProjectedTurnItem] = [],
        activeRunID: String? = "run-1"
    ) -> ThreadWorkingStatus? {
        ThreadWorkingStatus.resolve(
            state: state,
            workingStartedAt: startedAt,
            timelineItems: items,
            activeRunID: activeRunID
        )
    }

    /// The defect the redesign started from: `queued` covers preparing, queued
    /// and starting, and the old row called all three "Agent is working".
    @Test
    func aQueuedRunSaysItIsStartingRatherThanWorking() {
        #expect(resolve(state: .queued)?.headline == "Starting agent")
    }

    @Test
    func aRunningTurnNamesItsNewestLiveItem() {
        let status = resolve(
            state: .working,
            items: [
                command("a", title: "Read the file", status: "completed", position: 0),
                command("b", title: "Running tests", status: "running", position: 1),
            ]
        )
        #expect(status?.headline == "Running tests")
        #expect(status?.symbolName == "terminal")
    }

    @Test
    func aStreamingReplyReportsItselfRatherThanFallingBackToThinking() {
        let status = resolve(
            state: .working,
            items: [projected(V2Fixture.assistantMessage(id: "a", text: "hello"))]
        )
        #expect(status?.headline == "Writing a reply")
    }

    @Test
    func aTurnWithNothingInFlightYetReadsAsThinking() {
        let status = resolve(
            state: .working,
            items: [command("a", title: "Read the file", status: "completed")]
        )
        #expect(status?.headline == "Thinking")
    }

    /// An interrupted attempt can leave an item that never reached a terminal
    /// status. Scoping to the active run is what keeps it from reporting
    /// forever under the next turn's timer.
    @Test
    func anItemFromAnotherRunNeverReports() {
        let status = resolve(
            state: .working,
            items: [command("stale", title: "Running tests", status: "running", runID: "run-0")]
        )
        #expect(status?.headline == "Thinking")
    }

    /// Approval and input swap the composer for a panel, so a band above it
    /// would only name the panel; every settled state has nothing to report.
    @Test
    func onlyRunningStatesRenderABand() {
        let silent: [FeatureThreadState] = [
            .idle, .waitingForApproval, .waitingForInput, .failed, .completed,
        ]
        for state in silent {
            #expect(resolve(state: state) == nil)
        }
    }

    @Test
    func theTimerWaitsOutShortTurnsAndThenReadsLikeAHomeRow() {
        let status = ThreadWorkingStatus(
            headline: "Thinking",
            symbolName: "circle.dotted",
            startedAt: startedAt
        )
        #expect(status.durationLabel(at: startedAt.addingTimeInterval(6)) == nil)
        #expect(status.durationLabel(at: startedAt.addingTimeInterval(45)) == "45s")
        #expect(status.durationLabel(at: startedAt.addingTimeInterval(180)) == "3m")
    }

    /// A run the server has not stamped a start on gets no timer rather than one
    /// counting from the moment the view happened to appear.
    @Test
    func aRunWithNoReportedStartShowsNoTimer() {
        let status = ThreadWorkingStatus(
            headline: "Starting agent",
            symbolName: "circle.dotted",
            startedAt: nil
        )
        #expect(status.durationLabel(at: startedAt) == nil)
    }
}
