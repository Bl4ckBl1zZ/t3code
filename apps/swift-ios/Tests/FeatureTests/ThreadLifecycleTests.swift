import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/threadLifecycle.test.ts and
/// userMessageIntentBadge.test.ts. Both clients read the same projection, so
/// they have to divide the timeline identically.
final class ThreadLifecycleTests: XCTestCase {
    private func item(
        _ type: String,
        status: String = "completed",
        runID: String? = "run-1",
        title: String? = nil,
        extra: [String: JSONValue] = [:]
    ) -> OrchestrationV2TurnItem {
        var payload = extra
        if let title { payload["title"] = .string(title) }
        var built = V2Fixture.turnItem(id: "item-\(type)", type: type, status: status, extra: payload)
        if title != nil || runID != "run-1" {
            // Rebuild through JSON so base fields land the same way production does.
            var object: [String: JSONValue] = [
                "id": .string("item-\(type)"),
                "threadId": .string("thread-v2"),
                "runId": runID.map { JSONValue.string($0) } ?? .null,
                "nodeId": .null, "providerThreadId": .null, "providerTurnId": .null,
                "nativeItemRef": .null, "parentItemId": .null,
                "ordinal": .number(0), "status": .string(status),
                "title": title.map { JSONValue.string($0) } ?? .null,
                "startedAt": .string(V2Fixture.timestamp), "completedAt": .null,
                "updatedAt": .string(V2Fixture.timestamp),
                "type": .string(type),
            ]
            for (k, v) in extra { object[k] = v }
            let data = try! JSONEncoder.t3.encode(JSONValue.object(object))
            built = try! JSONDecoder.t3.decode(OrchestrationV2TurnItem.self, from: data)
        }
        return built
    }

    func testCheckpointsStayInTheWorkLogRatherThanBecomingDividers() {
        XCTAssertFalse(ThreadLifecycle.isLifecycleTimelineItem(item("checkpoint")))
        XCTAssertTrue(ThreadLifecycle.isLifecycleTimelineItem(item("checkpoint_rollback")))
        XCTAssertFalse(ThreadLifecycle.isLifecycleTimelineItem(item("assistant_message")))
        XCTAssertTrue(ThreadLifecycle.isLifecycleTimelineItem(item("subagent")))
    }

    func testRollbackDetailPluralisesAndOmitsEmptyParts() {
        XCTAssertEqual(
            ThreadLifecycle.rollbackDetail(rolledBackRunCount: 1, restoredFileCount: 0),
            "1 turn"
        )
        XCTAssertEqual(
            ThreadLifecycle.rollbackDetail(rolledBackRunCount: 2, restoredFileCount: 3),
            "2 turns · 3 files restored"
        )
        XCTAssertNil(ThreadLifecycle.rollbackDetail(rolledBackRunCount: 0, restoredFileCount: 0))
    }

    func testCompactionFallsBackToTokenCountsWhenThereIsNoSummary() {
        let compaction = item(
            "compaction",
            extra: ["driver": .string("codex"), "beforeTokenCount": .number(100), "afterTokenCount": .number(10)]
        )
        guard case let .divider(divider)? = ThreadLifecycle.resolvePresentation(compaction) else {
            return XCTFail("expected a divider")
        }
        XCTAssertEqual(divider.label, "Chat compacted")
        XCTAssertEqual(divider.detail, "100 → 10 tokens")
    }

    func testHandoffRecoversOriginModelsFromRunHistory() {
        // Items persisted before models were stamped carry only instance ids.
        let handoff = item(
            "handoff",
            extra: [
                "contextHandoffId": .string("handoff-1"),
                "fromProviderInstanceIds": .array([.string("claude")]),
                "toProviderThreadId": .string("provider-thread-2"),
                "toProviderInstanceId": .string("codex"),
                "strategy": .string("full_thread_summary"),
            ]
        )
        let runs = [
            LifecycleTimelineRun(id: "run-0", ordinal: 1, providerInstanceID: "claude", model: "opus-5"),
            LifecycleTimelineRun(id: "run-1", ordinal: 2, providerInstanceID: "codex", model: "gpt-5.4"),
        ]

        guard case let .divider(divider)? = ThreadLifecycle.resolvePresentation(handoff, runs: runs)
        else { return XCTFail("expected a divider") }
        XCTAssertEqual(divider.detail, "opus-5 → gpt-5.4")
        XCTAssertEqual(divider.layout, .stacked)
        XCTAssertFalse(divider.busy)
    }

    func testInFlightHandoffReadsAsBusyRatherThanComplete() {
        let handoff = item(
            "handoff",
            status: "running",
            extra: [
                "contextHandoffId": .string("handoff-1"),
                "fromProviderInstanceIds": .array([]),
                "toProviderThreadId": .string("provider-thread-2"),
                "toProviderInstanceId": .string("codex"),
                "toModel": .string("gpt-5.4"),
                "strategy": .string("full_thread_summary"),
            ]
        )
        guard case let .divider(divider)? = ThreadLifecycle.resolvePresentation(handoff) else {
            return XCTFail("expected a divider")
        }
        XCTAssertEqual(divider.label, "Preparing context handoff")
        XCTAssertTrue(divider.busy)
        XCTAssertEqual(divider.detail, "gpt-5.4")
    }

    func testRunningSubagentPrefersLiveProgressAndTerminalPrefersResult() {
        let extra: [String: JSONValue] = [
            "subagentId": .string("node-sub"),
            "origin": .string("app_owned"),
            "driver": .string("codex"),
            "providerInstanceId": .string("codex"),
            "childThreadId": .string("thread-child"),
            "prompt": .string("Investigate"),
            "progress": .string("halfway"),
            "result": .string("done"),
        ]

        guard case let .relatedThread(running)? =
            ThreadLifecycle.resolvePresentation(item("subagent", status: "running", extra: extra))
        else { return XCTFail("expected a related-thread card") }
        XCTAssertEqual(running.detail, "halfway")
        XCTAssertEqual(running.orbState, .active)
        // Child thread id keeps one agent the same colour across surfaces.
        XCTAssertEqual(running.orbSeed, "thread-child")

        guard case let .relatedThread(finished)? =
            ThreadLifecycle.resolvePresentation(item("subagent", status: "completed", extra: extra))
        else { return XCTFail("expected a related-thread card") }
        XCTAssertEqual(finished.detail, "done")
        XCTAssertEqual(finished.orbState, .done)
        XCTAssertEqual(finished.badgeTone, .success)
    }

    func testForkOffersToOpenItsSourceConversation() {
        let fork = item(
            "fork",
            extra: [
                "source": .object([
                    "type": .string("run"),
                    "threadId": .string("thread-source"),
                    "runId": .string("run-9"),
                ]),
                "targetThreadId": .string("thread-fork"),
            ]
        )
        guard case let .divider(divider)? = ThreadLifecycle.resolvePresentation(fork) else {
            return XCTFail("expected a divider")
        }
        XCTAssertEqual(divider.label, "Forked from conversation")
        XCTAssertEqual(divider.actionLabel, "Open source conversation")
        XCTAssertEqual(divider.openThreadID, "thread-source")
    }

    func testIntentBadgeAnnotatesOnlyNonDefaultIntents() {
        XCTAssertNil(UserMessageIntentBadge.resolve(.turnStart))
        XCTAssertNil(UserMessageIntentBadge.resolve(nil))
        XCTAssertEqual(UserMessageIntentBadge.resolve(.queuedTurn)?.label, "queued")
        XCTAssertEqual(UserMessageIntentBadge.resolve(.steer)?.label, "steered the run")
        XCTAssertEqual(
            UserMessageIntentBadge.resolve(.promotedQueuedToSteer)?.label,
            "queued → steered the run"
        )
    }
}
