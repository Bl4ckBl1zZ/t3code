import XCTest

@testable import T3Code

/// Ports apps/web/src/proposedPlan.test.ts, plus the plan derivations web keeps
/// in session-logic.ts: which plan is current, when the follow-up banner shows,
/// and that a plan card is never folded or grouped away.
final class ProposedPlanTests: XCTestCase {
    // MARK: - Markdown

    func testTitleIsTheFirstHeading() {
        XCTAssertEqual(ProposedPlanMarkdown.title("# Integrate RPC\n\nBody"), "Integrate RPC")
        XCTAssertEqual(ProposedPlanMarkdown.title("Intro\n   ## Later heading  \n"), "Later heading")
        XCTAssertNil(ProposedPlanMarkdown.title("- step 1"))
        XCTAssertNil(ProposedPlanMarkdown.title("#NoSpace\n####### Seven\n    # Indented code"))
    }

    func testImplementationPromptMatchesWeb() {
        XCTAssertEqual(
            ProposedPlanMarkdown.implementationPrompt("## Ship it\n\n- step 1\n"),
            "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1"
        )
    }

    func testCollapsedPreviewDropsTheTitleAndMarksOverflow() {
        XCTAssertEqual(
            ProposedPlanMarkdown.collapsedPreview("# Integrate RPC\n\n## Summary\n\n- step 1\n- step 2", maxLines: 4),
            "- step 1\n- step 2"
        )
        XCTAssertEqual(
            ProposedPlanMarkdown.collapsedPreview("# Integrate RPC\n\n- step 1\n- step 2\n- step 3", maxLines: 2),
            "- step 1\n- step 2\n\n..."
        )
        XCTAssertEqual(ProposedPlanMarkdown.collapsedPreview("# Only a title"), "Only a title")
    }

    func testDisplayedMarkdownDropsTitleAndSummaryHeadingOnly() {
        XCTAssertEqual(ProposedPlanMarkdown.displayed("# Integrate RPC\n\n## Summary\n\n- step 1\n"), "- step 1")
        XCTAssertEqual(ProposedPlanMarkdown.displayed("# Integrate RPC\n\n## Scope\n\n- step 1\n"), "## Scope\n\n- step 1")
        XCTAssertEqual(ProposedPlanMarkdown.displayed("# Plan\r\n\r\n- step 1\r\n"), "- step 1")
    }

    func testImplementationThreadTitleTruncatesLikeWeb() {
        XCTAssertEqual(ProposedPlanMarkdown.implementationThreadTitle("# Integrate RPC\n\nBody"), "Implement Integrate RPC")
        XCTAssertEqual(ProposedPlanMarkdown.implementationThreadTitle("- step 1"), "Implement plan")
        let long = ProposedPlanMarkdown.implementationThreadTitle("# " + String(repeating: "a", count: 60))
        XCTAssertEqual(long, "Implement " + String(repeating: "a", count: 40) + "...")
    }

    func testFilenameIsASlugOfTheTitle() {
        XCTAssertEqual(
            ProposedPlanMarkdown.filename("# Integrate Effect RPC Into Server App"),
            "integrate-effect-rpc-into-server-app.md"
        )
        XCTAssertEqual(ProposedPlanMarkdown.filename("# Don't break (v2.0)!"), "dont-break-v20.md")
        XCTAssertEqual(ProposedPlanMarkdown.filename("# ✨"), "plan.md")
        XCTAssertEqual(ProposedPlanMarkdown.filename("- step 1"), "plan.md")
    }

    func testOnlyLongPlansCollapse() {
        XCTAssertFalse(ProposedPlanMarkdown.isLong("# Short\n\n- one"))
        XCTAssertTrue(ProposedPlanMarkdown.isLong(Array(repeating: "- step", count: 21).joined(separator: "\n")))
        XCTAssertTrue(ProposedPlanMarkdown.isLong(String(repeating: "x", count: 901)))
    }

    // MARK: - Feed

    func testPlansAreCardsThatNameTheirSupersededPredecessors() {
        let items = [
            projected(plan(id: "old", planID: "plan-1", markdown: "# First")),
            projected(workItem(id: "work")),
            projected(plan(id: "new", planID: "plan-2", markdown: "# Second")),
        ]
        let cards = ThreadTimelineFeed.entries(timelineItems: items, messages: []).compactMap { entry -> ThreadProposedPlanEntry? in
            guard case let .proposedPlan(card) = entry else { return nil }
            return card
        }
        XCTAssertEqual(cards.map(\.plan.title), ["First", "Second"])
        XCTAssertEqual(cards.map(\.isSuperseded), [true, false])
    }

    func testAnEmptyFinishedPlanStaysAWorkRow() {
        let entries = ThreadTimelineFeed.entries(
            timelineItems: [projected(plan(id: "empty", planID: "plan-1", markdown: "  "))],
            messages: []
        )
        guard case .workLog? = entries.last else { return XCTFail("Expected a work row: \(entries)") }
    }

    func testCompletedRunsFoldAroundThePlanCard() {
        let message = FeatureMessage(id: "final", role: .assistant, text: "Here is the plan.", createdAt: Date(timeIntervalSince1970: 0))
        let items = [
            projected(workItem(id: "work")),
            projected(plan(id: "card", planID: "plan-1", markdown: "# Plan")),
            projected(V2Fixture.assistantMessage(id: "final", text: "Here is the plan.", streaming: false)),
        ]
        let detail = FeatureThreadDetail(
            thread: FeatureThread(id: "thread", projectID: "project", title: "Thread"),
            messages: [message],
            timelineItems: items,
            workflow: FeatureThreadWorkflow(runs: [ThreadWorkflowRun(id: "run-1", ordinal: 0, status: "completed")])
        )
        let entries = ThreadTimelineFeed.entries(for: detail)
        let folded = ThreadTimelineFoldPresentation.apply(entries: entries, detail: detail, expandedRunIDs: [], alwaysExpand: false)
        XCTAssertEqual(
            folded.entries.filter { if case .dayDivider = $0 { false } else { true } }.map(\.id),
            ["turn-fold:run-1", "proposed-plan:thread/card", "message:final"]
        )
    }

    // MARK: - Follow-up

    func testFollowUpOffersTheSettledPlanInPlanMode() {
        let detail = detail(items: [projected(plan(id: "card", planID: "plan-1", markdown: "# Ship it"))])
        XCTAssertEqual(ThreadProposedPlans.followUp(in: detail, thread: detail.thread)?.planID, "plan-1")
    }

    func testFollowUpStaysHiddenOutsideItsMoment() {
        let items = [projected(plan(id: "card", planID: "plan-1", markdown: "# Ship it"))]
        XCTAssertNil(followUp(detail(items: items, mode: .standard)), "Build mode")
        XCTAssertNil(followUp(detail(items: items, actionable: false)), "The server no longer counts it")
        XCTAssertNil(followUp(detail(items: items, state: .working, runStatus: "running")), "A turn is running")
        XCTAssertNil(followUp(detail(items: items, runStatus: "queued")), "A run is queued")
        XCTAssertNil(followUp(detail(items: items, runs: [])), "No run has settled")
        let streaming = [projected(plan(id: "card", planID: "plan-1", markdown: "# Ship", streaming: true))]
        XCTAssertNil(followUp(detail(items: streaming)), "Still drafting")
        var asking = detail(items: items)
        asking.userInputs = [FeatureUserInput(id: "input", threadID: "thread", questions: [])]
        XCTAssertNil(followUp(asking), "A question is pending")
        XCTAssertNotNil(followUp(detail(items: items, actionable: nil)), "An unknown verdict defers to the item")
    }

    func testLatestPlanPrefersTheLatestRunThenTheNewestOverall() {
        let items = [
            projected(plan(id: "a", planID: "plan-a", markdown: "# A", runID: "run-2")),
            projected(plan(id: "b", planID: "plan-b", markdown: "# B", runID: "run-1")),
            projected(plan(id: "c", planID: "plan-c", markdown: "# C", runID: "run-1"), visibility: .inherited),
        ]
        let runs = [
            ThreadWorkflowRun(id: "run-1", ordinal: 1, status: "completed"),
            ThreadWorkflowRun(id: "run-2", ordinal: 2, status: "completed"),
        ]
        XCTAssertEqual(ThreadProposedPlans.latest(in: detail(items: items, runs: runs))?.planID, "plan-a")
        let afterImplementation = runs + [ThreadWorkflowRun(id: "run-3", ordinal: 3, status: "completed")]
        XCTAssertEqual(
            ThreadProposedPlans.latest(in: detail(items: items, runs: afterImplementation))?.planID,
            "plan-b",
            "A run with no plan falls back to the thread's newest own plan"
        )
    }

    func testStepsPreferTheLatestRunsTodoList() {
        let items = [
            projected(todo(id: "t1", runID: "run-2", steps: [("Read", "completed")], explanation: "Older")),
            projected(todo(id: "t2", runID: "run-1", steps: [("Write", "running"), ("Test", "pending")], explanation: " ")),
        ]
        let runs = [
            ThreadWorkflowRun(id: "run-1", ordinal: 1, status: "completed"),
            ThreadWorkflowRun(id: "run-2", ordinal: 2, status: "running"),
        ]
        let steps = ThreadProposedPlans.steps(in: detail(items: items, runs: runs))
        XCTAssertEqual(steps?.steps.map(\.text), ["Read"])
        XCTAssertEqual(steps?.explanation, "Older")
        let fallback = ThreadProposedPlans.steps(in: detail(items: items, runs: [ThreadWorkflowRun(id: "run-9", ordinal: 9, status: "completed")]))
        XCTAssertEqual(fallback?.steps.map(\.text), ["Write", "Test"])
        XCTAssertNil(fallback?.explanation, "A blank explanation is no explanation")
    }

    func testImplementationCarriesWhatWebSends() throws {
        let plan = try XCTUnwrap(ThreadProposedPlan(projected(plan(id: "card", planID: "plan-1", markdown: "# Ship it\n\n- step\n"))))
        let implementation = FeatureProposedPlanImplementation(threadID: "env:thread", plan: plan, selection: nil)
        XCTAssertEqual(implementation.planID, "plan-1")
        XCTAssertEqual(implementation.prompt, "PLEASE IMPLEMENT THIS PLAN:\n# Ship it\n\n- step")
        XCTAssertEqual(implementation.newThreadTitle, "Implement Ship it")
        XCTAssertEqual(plan.exportedMarkdown, "# Ship it\n\n- step\n")
    }

    // MARK: - Fixtures

    private func followUp(_ detail: FeatureThreadDetail) -> ThreadProposedPlan? {
        ThreadProposedPlans.followUp(in: detail, thread: detail.thread)
    }

    private func detail(
        items: [OrchestrationV2ProjectedTurnItem],
        mode: FeatureInteractionMode = .plan,
        actionable: Bool? = true,
        state: FeatureThreadState = .completed,
        runStatus: String = "completed",
        runs: [ThreadWorkflowRun]? = nil
    ) -> FeatureThreadDetail {
        FeatureThreadDetail(
            thread: FeatureThread(
                id: "thread",
                projectID: "project",
                title: "Thread",
                state: state,
                hasActionableProposedPlan: actionable,
                interactionMode: mode
            ),
            timelineItems: items,
            workflow: FeatureThreadWorkflow(runs: runs ?? [ThreadWorkflowRun(id: "run-1", ordinal: 1, status: runStatus)])
        )
    }

    private func projected(
        _ item: OrchestrationV2TurnItem,
        visibility: OrchestrationV2TurnItemVisibility = .local
    ) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: 0, visibility: visibility, sourceThreadId: "thread", sourceItemId: item.id, item: item
        )
    }

    private func plan(
        id: String,
        planID: String,
        markdown: String,
        runID: String = "run-1",
        streaming: Bool = false
    ) -> OrchestrationV2TurnItem {
        V2Fixture.turnItem(id: id, type: "proposed_plan", status: streaming ? "running" : "completed", extra: [
            "runId": .string(runID),
            "planId": .string(planID),
            "markdown": .string(markdown),
            "streaming": .bool(streaming),
        ])
    }

    private func todo(
        id: String,
        runID: String,
        steps: [(String, String)],
        explanation: String?
    ) -> OrchestrationV2TurnItem {
        V2Fixture.turnItem(id: id, type: "todo_list", extra: [
            "runId": .string(runID),
            "planId": .string("todo-" + id),
            "steps": .array(steps.enumerated().map { index, step in
                .object(["id": .string("\(index)"), "text": .string(step.0), "status": .string(step.1)])
            }),
            "explanation": explanation.map(JSONValue.string) ?? .null,
        ])
    }

    private func workItem(id: String) -> OrchestrationV2TurnItem {
        V2Fixture.turnItem(id: id, type: "command_execution", extra: [
            "input": .string("ls"),
            "output": .string(""),
            "exitCode": .number(0),
        ])
    }
}
