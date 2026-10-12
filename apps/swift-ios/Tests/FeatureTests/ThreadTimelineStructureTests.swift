import XCTest

@testable import T3Code

/// The structural rows web derives in `deriveMessagesTimelineRows`:
/// agent-update runs, superseded attempts, and subagent fan-outs.
final class ThreadTimelineStructureTests: XCTestCase {
    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private static func date(_ iso: String) -> Date {
        ThreadTimelineDay.date(fromISO8601: iso)!
    }

    private func projected(_ item: OrchestrationV2TurnItem, position: Int = 0) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: position, visibility: .local, sourceThreadId: "thread-v2", sourceItemId: item.id, item: item
        )
    }

    private func command(_ id: String, at startedAt: String = V2Fixture.timestamp, nodeID: String? = nil) -> OrchestrationV2ProjectedTurnItem {
        var extra: [String: JSONValue] = ["input": .string("ls"), "startedAt": .string(startedAt)]
        if let nodeID { extra["nodeId"] = .string(nodeID) }
        return projected(V2Fixture.turnItem(id: id, type: "command_execution", extra: extra))
    }

    private func agentMessage(_ id: String, text: String) -> FeatureMessage {
        FeatureMessage(id: id, role: .user, text: text, createdAt: Self.date(V2Fixture.timestamp), createdBy: "agent")
    }

    // MARK: - Agent updates

    func testDelegatedTaskWakesParseToTitleAndStatus() {
        XCTAssertEqual(
            DelegatedTaskWake.parse(#"Delegated task "Fix the "flaky" test" completed. Use task_status with taskId task-1 to read the result."#),
            DelegatedTaskWake(title: #"Fix the "flaky" test"#, taskID: "task-1", status: "completed")
        )
        XCTAssertEqual(
            DelegatedTaskWake.parse("  Delegated task task-2 ended with status failed. Use task_status with taskId task-2 for details.\n"),
            DelegatedTaskWake(title: "task-2", taskID: "task-2", status: "failed")
        )
        XCTAssertNil(DelegatedTaskWake.parse("Please look at the build again."))
        XCTAssertNil(DelegatedTaskWake.parse(#"Delegated task "x" completed."#))
    }

    func testConsecutiveAgentMessagesCollapseIntoOneGroupAnchoredOnTheFirst() {
        let wake = agentMessage("a1", text: #"Delegated task "Lint" ended with status failed. Use task_status with taskId t1 for details."#)
        let note = agentMessage("a2", text: "Second line\nmore")
        let mine = FeatureMessage(id: "u1", role: .user, text: "thanks", createdAt: wake.createdAt)
        let lone = agentMessage("a3", text: "Only one")

        let merged = ThreadAgentUpdateGrouping.merge([
            .message(wake), .message(note), .message(mine), .message(lone),
        ])

        XCTAssertEqual(merged.map(\.id), ["agent-updates:message:a1", "message:u1", "message:a3"])
        guard case let .structural(.agentUpdates(group)) = merged.first else {
            return XCTFail("expected an agent-updates group, got \(merged.map(\.id))")
        }
        XCTAssertEqual(group.updates.map(\.title), ["Lint", "Second line"])
        XCTAssertEqual(group.updates.map(\.statusLabel), ["Failed", nil])
        XCTAssertTrue(group.updates[0].isFailure)
    }

    func testAnAgentMessageNamesTheThreadThatSentIt() throws {
        let item = V2Fixture.turnItem(id: "u", type: "user_message", extra: [
            "messageId": .string("m-u"), "inputIntent": .string("turn_start"), "text": .string("wake"),
            "createdBy": .string("agent"), "creationSource": .string("mcp"), "senderThreadId": .string("sender"),
        ])
        XCTAssertEqual(item.senderThreadId, "sender")
        let decoded = try JSONDecoder.t3.decode(OrchestrationV2TurnItem.self, from: JSONEncoder.t3.encode(item))
        XCTAssertEqual(decoded.senderThreadId, "sender")
        XCTAssertNil(V2Fixture.assistantMessage(id: "a", text: "hi").senderThreadId)
    }

    // MARK: - Attempts

    /// Older servers send attempts and nodes without the join columns; they
    /// decode, and simply resolve no attempt.
    func testAttemptJoinColumnsDecodeAndStayOptional() throws {
        let current = try JSONDecoder.t3.decode(OrchestrationV2RunAttempt.self, from: Data(
            #"{"id":"a","runId":"r","attemptOrdinal":2,"status":"superseded","reason":"retry","rootNodeId":"n"}"#.utf8
        ))
        XCTAssertEqual(current.rootNodeId, "n")
        let older = try JSONDecoder.t3.decode(OrchestrationV2RunAttempt.self, from: Data(
            #"{"id":"a","runId":"r","attemptOrdinal":2,"status":"superseded","reason":"retry"}"#.utf8
        ))
        XCTAssertNil(older.rootNodeId)
        let node = try JSONDecoder.t3.decode(OrchestrationV2ExecutionNode.self, from: Data(
            #"{"id":"n2","runId":"r","kind":"tool_call","status":"completed","parentNodeId":"n","rootNodeId":"n"}"#.utf8
        ))
        XCTAssertEqual(node.parentNodeId, "n")
        XCTAssertNil(ThreadTimelineAttemptResolver(attempts: [older], nodes: [node]).attempt(for: command("c", nodeID: "n2").item))
    }

    private func attempt(_ id: String, run: String = "run-1", root: String, status: String) -> OrchestrationV2RunAttempt {
        OrchestrationV2RunAttempt(id: id, runId: run, attemptOrdinal: 1, status: status, reason: "retry", rootNodeId: root)
    }

    private func node(_ id: String, parent: String?, root: String) -> OrchestrationV2ExecutionNode {
        OrchestrationV2ExecutionNode(
            id: id, runId: "run-1", kind: "tool_call", status: "completed", runtimeRequestId: nil,
            startedAt: nil, completedAt: nil, parentNodeId: parent, rootNodeId: root
        )
    }

    func testAnItemResolvesToTheAttemptItsNodeDescendsFrom() {
        let resolver = ThreadTimelineAttemptResolver(
            attempts: [attempt("att-1", root: "root-1", status: "superseded"), attempt("att-other", run: "run-2", root: "root-2", status: "running")],
            nodes: [node("child", parent: "mid", root: "elsewhere"), node("mid", parent: "root-1", root: "root-1"),
                    node("loop-a", parent: "loop-b", root: "x"), node("loop-b", parent: "loop-a", root: "x"),
                    node("foreign", parent: nil, root: "root-2")]
        )

        XCTAssertEqual(resolver.attempt(for: command("c", nodeID: "child").item)?.id, "att-1")
        XCTAssertEqual(resolver.attempt(for: command("c", nodeID: "root-1").item)?.status, "superseded")
        // Another run's attempt never claims this run's item.
        XCTAssertNil(resolver.attempt(for: command("c", nodeID: "foreign").item))
        XCTAssertNil(resolver.attempt(for: command("c", nodeID: "loop-a").item))
        XCTAssertNil(resolver.attempt(for: command("c").item))
    }

    func testSupersededOutputFoldsBehindOneRowAndFailedRunsStayOpen() {
        let superseded = ThreadTimelineAttempt(id: "att-1", runID: "run-1", status: "superseded")
        let live = ThreadTimelineAttempt(id: "att-2", runID: "run-1", status: "running")
        let failedRun = ThreadTimelineAttempt(id: "att-3", runID: "run-9", status: "superseded")
        let candidates: [ThreadAttemptFolding.Candidate] = [
            .init(entryID: "user", attempt: nil),
            .init(entryID: "reply-1", attempt: superseded),
            .init(entryID: "work-1", attempt: superseded),
            .init(entryID: "reply-2", attempt: live),
            .init(entryID: "failed", attempt: failedRun),
        ]

        let collapsed = ThreadAttemptFolding.folds(candidates: candidates, failedRunIDs: ["run-9"], expandedKeys: [])
        XCTAssertEqual(Set(collapsed.byAnchorID.keys), ["reply-1"])
        XCTAssertEqual(Set(collapsed.hiddenIDs.keys), ["reply-1", "work-1"])
        XCTAssertEqual(collapsed.byAnchorID["reply-1"]?.isExpanded, false)

        let expanded = ThreadAttemptFolding.folds(
            candidates: candidates, failedRunIDs: ["run-9"], expandedKeys: [ThreadAttemptFold.expansionKey("att-1")]
        )
        XCTAssertEqual(expanded.byAnchorID["reply-1"]?.isExpanded, true)
    }

    /// A reply that finished before the steer was whole, so its attempt is not
    /// folded as partial output. One the steer closed, or one followed by more
    /// work, was cut off.
    func testAReplyFinishedBeforeTheSteerIsCompleteAndItsAttemptStaysOpen() {
        let steeredAt = Date(timeIntervalSince1970: 1_000)
        let whole = ThreadTimelineAttempt(id: "att-1", runID: "run-1", status: "superseded", completedAt: steeredAt)
        let cutOff = ThreadTimelineAttempt(id: "att-2", runID: "run-2", status: "superseded", completedAt: steeredAt)
        let trailing = ThreadTimelineAttempt(id: "att-3", runID: "run-3", status: "superseded", completedAt: steeredAt)
        let outputs: [ThreadAttemptFolding.Output] = [
            .init(entryID: "work-1", attempt: whole, replyCompletedAt: nil),
            .init(entryID: "reply-1", attempt: whole, replyCompletedAt: steeredAt.addingTimeInterval(-5)),
            // Closed by the steer: completed after the attempt was replaced.
            .init(entryID: "reply-2", attempt: cutOff, replyCompletedAt: steeredAt.addingTimeInterval(1)),
            // A finished reply followed by more work: the attempt was still going.
            .init(entryID: "reply-3", attempt: trailing, replyCompletedAt: steeredAt.addingTimeInterval(-5)),
            .init(entryID: "work-3", attempt: trailing, replyCompletedAt: nil),
        ]
        XCTAssertEqual(ThreadAttemptFolding.completeReplyEntryIDs(outputs: outputs), ["reply-1"])

        let candidates: [ThreadAttemptFolding.Candidate] = [
            .init(entryID: "work-1", attempt: whole),
            .init(entryID: "reply-1", attempt: whole),
            .init(entryID: "reply-2", attempt: cutOff),
        ]
        let folds = ThreadAttemptFolding.folds(
            candidates: candidates, failedRunIDs: [], completeAttemptIDs: ["att-1"], expandedKeys: []
        )
        XCTAssertEqual(Set(folds.hiddenIDs.keys), ["reply-2"])
    }

    /// The fold works on the real feed too, and still applies when the reader
    /// asked for every turn's activity to stay open.
    func testTheFeedFoldsASupersededAttemptEvenWhenActivityIsAlwaysExpanded() {
        let superseded = ThreadTimelineAttempt(id: "att-1", runID: "run-1", status: "superseded")
        let current = ThreadTimelineAttempt(id: "att-2", runID: "run-1", status: "running")
        let old = command("old")
        let new = command("new")
        var support: [String: ThreadActivityItemSupport] = [:]
        var oldSupport = ThreadActivityItemSupport()
        oldSupport.attempt = superseded
        var newSupport = ThreadActivityItemSupport()
        newSupport.attempt = current
        support[old.id] = oldSupport
        support[new.id] = newSupport

        let entries = ThreadTimelineFeed.entries(timelineItems: [old, new], messages: [], support: support, calendar: Self.utc)
        // The attempt boundary splits what would otherwise be one work group.
        XCTAssertEqual(entries.map(\.id), ["work:local:thread-v2:old", "work:local:thread-v2:new"])

        let detail = FeatureThreadDetail(
            thread: FeatureThread(id: "thread", projectID: "project", title: "Thread"),
            timelineItems: [old, new],
            itemSupport: support
        )
        let collapsed = ThreadTimelineFoldPresentation.apply(entries: entries, detail: detail, expandedRunIDs: [], alwaysExpand: true)
        XCTAssertEqual(collapsed.entries.map(\.id), ["attempt-fold:att-1", "work:local:thread-v2:new"])

        let open = ThreadTimelineFoldPresentation.apply(
            entries: entries, detail: detail, expandedRunIDs: [ThreadAttemptFold.expansionKey("att-1")], alwaysExpand: true
        )
        XCTAssertEqual(open.entries.map(\.id), ["attempt-fold:att-1", "work:local:thread-v2:old", "work:local:thread-v2:new"])
    }

    // MARK: - Subagent groups

    private func subagent(_ id: String, status: String, startedAt: String?, completedAt: String?) -> OrchestrationV2ProjectedTurnItem {
        var extra: [String: JSONValue] = [
            "subagentId": .string(id), "origin": .string("delegated_task"), "driver": .string("claude"),
            "providerInstanceId": .string("claude"), "prompt": .string("go"),
            "startedAt": startedAt.map(JSONValue.string) ?? .null,
            "completedAt": completedAt.map(JSONValue.string) ?? .null,
        ]
        extra["childThreadId"] = .string("child-\(id)")
        return projected(V2Fixture.turnItem(id: id, type: "subagent", status: status, extra: extra))
    }

    func testASubagentFanOutSummarizesStatusesAndOneSpan() throws {
        let summary = try XCTUnwrap(SubagentGroupSummary(rows: [
            subagent("a", status: "completed", startedAt: "2026-07-31T12:00:00.000Z", completedAt: "2026-07-31T12:02:00.000Z"),
            subagent("b", status: "failed", startedAt: "2026-07-31T12:01:00.000Z", completedAt: "2026-07-31T12:05:30.000Z"),
            subagent("c", status: "cancelled", startedAt: "2026-07-31T11:59:00.000Z", completedAt: "2026-07-31T12:03:00.000Z"),
        ]))

        XCTAssertEqual(summary.statusSummary, "1 done · 1 failed · 1 stopped")
        XCTAssertFalse(summary.isLive)
        XCTAssertTrue(summary.hasFailure)
        XCTAssertEqual(summary.agents.map(\.orbSeed), ["child-a", "child-b", "child-c"])
        // 11:59:00 to 12:05:30, frozen whatever the clock says.
        XCTAssertEqual(summary.elapsedLabel(now: .distantFuture), "6m")
    }

    func testALiveGroupCountsOnTheMinuteAndAnUnknownEndWithholdsTheSpan() {
        let start = Self.date("2026-07-31T12:00:00.000Z")
        let live = SubagentGroupSummary(agents: [
            .init(status: "running", startedAt: start, completedAt: nil, orbSeed: "a"),
            .init(status: "completed", startedAt: start, completedAt: start.addingTimeInterval(30), orbSeed: "b"),
        ])
        XCTAssertEqual(live.statusSummary, "1 working · 1 done")
        XCTAssertEqual(live.elapsedLabel(now: start.addingTimeInterval(30)), "<1m")
        XCTAssertEqual(live.elapsedLabel(now: start.addingTimeInterval(125)), "2m")

        let unknownEnd = SubagentGroupSummary(agents: [
            .init(status: "completed", startedAt: start, completedAt: nil, orbSeed: "a"),
            .init(status: "completed", startedAt: start, completedAt: start.addingTimeInterval(60), orbSeed: "b"),
        ])
        XCTAssertNil(unknownEnd.elapsedLabel(now: .distantFuture))
    }

    func testAMixedRunIsNotASubagentGroup() {
        let created = projected(V2Fixture.turnItem(id: "t", type: "thread_created", extra: [
            "targetThreadId": .string("x"), "targetProviderInstanceId": .string("codex"), "targetModel": .string("m"),
        ]))
        XCTAssertNil(SubagentGroupSummary(rows: [subagent("a", status: "running", startedAt: nil, completedAt: nil), created]))
    }
}
