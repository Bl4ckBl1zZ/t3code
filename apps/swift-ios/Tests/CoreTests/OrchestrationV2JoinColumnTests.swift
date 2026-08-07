import XCTest

@testable import T3Code

/// The projection's relational tables are only useful for their join columns:
/// a subagent row that does not carry `childThreadId` cannot be opened, a
/// context transfer without its two thread ids draws no lineage edge, and a run
/// without `queuePosition` / `activeAttemptId` leaves the queue control unable
/// to tell a queued run from a running one.
///
/// These tests decode real wire rows into the narrowed Swift models and then
/// decode the same rows stripped back to what an older server sends, because
/// both halves matter: the columns have to arrive, and their absence has to
/// degrade rather than blank the projection.
final class OrchestrationV2JoinColumnTests: XCTestCase {
    private static let timestamp = "2026-07-31T12:00:00.000Z"

    /// The generated contract fixture, patched. Building on it rather than on a
    /// hand-written literal keeps the surrounding thread shape honest — these
    /// rows have to decode inside a projection, not on their own.
    private func decodeProjection(
        _ patch: (inout [String: Any]) -> Void
    ) throws -> OrchestrationV2ThreadProjection {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/orchestrationV2Projection.json")
        var raw = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        patch(&raw)
        return try JSONDecoder().decode(
            OrchestrationV2ThreadProjection.self,
            from: try JSONSerialization.data(withJSONObject: raw)
        )
    }

    // MARK: - Subagents

    func testSubagentRowsCarryTheThreadIdsAndAnnotationsTheRosterRenders() throws {
        let phases: [[String: Any]] = [
            ["index": 0, "title": "Survey"],
            ["index": 1, "title": "Report", "detail": "Write it up"],
        ]
        let workflow: [String: Any] = [
            "name": "review",
            "description": "Two-phase review",
            "phases": phases,
            "currentPhase": "Report",
            "spawnedCount": 3,
        ]
        let usage: [String: Any] = [
            "totalTokens": 4200,
            "inputTokens": 4000,
            "outputTokens": 200,
            "toolUses": 6,
        ]
        let row: [String: Any] = [
            "id": "node-subagent",
            "threadId": "thread-v2",
            "runId": "run-1",
            "parentNodeId": "node-root",
            "origin": "app_owned",
            "createdBy": "agent",
            "driver": "claude",
            "providerInstanceId": "claude",
            "providerThreadId": NSNull(),
            "childThreadId": "thread-child",
            "nativeTaskRef": NSNull(),
            "prompt": "Audit the mapper",
            "title": "Audit the mapper",
            "model": "opus",
            "status": "running",
            "progress": "reading",
            "result": NSNull(),
            "taskType": "subagent",
            "agentKind": "agent",
            "usage": usage,
            "workflow": workflow,
            "startedAt": Self.timestamp,
            "completedAt": NSNull(),
            "updatedAt": Self.timestamp,
        ]

        let projection = try decodeProjection { $0["subagents"] = [row] }
        let subagent = try XCTUnwrap(projection.subagents.first)

        XCTAssertEqual(subagent.threadId, "thread-v2")
        // The navigation target and the orb seed both hang off this.
        XCTAssertEqual(subagent.childThreadId, "thread-child")
        XCTAssertEqual(subagent.title, "Audit the mapper")
        XCTAssertEqual(subagent.workflow?.name, "review")
        XCTAssertEqual(subagent.workflow?.currentPhase, "Report")
        XCTAssertEqual(subagent.workflow?.spawnedCount, 3)
        XCTAssertEqual(subagent.workflow?.phases.map(\.title), ["Survey", "Report"])
        XCTAssertEqual(subagent.workflow?.phases.last?.detail, "Write it up")
        XCTAssertEqual(subagent.usage?.totalTokens, 4200)
        XCTAssertEqual(subagent.usage?.toolUses, 6)
        // Not reported is not zero: a driver that never emits reasoning tokens
        // must not render as having spent none.
        XCTAssertNil(subagent.usage?.reasoningOutputTokens)
    }

    func testSubagentWithoutObservabilityAnnotationsStillDecodes() throws {
        let row: [String: Any] = [
            "id": "node-subagent",
            "threadId": "thread-v2",
            "origin": "provider_native",
            "childThreadId": NSNull(),
            "title": NSNull(),
            "status": "completed",
            "progress": NSNull(),
            "result": "done",
            "updatedAt": Self.timestamp,
        ]

        let projection = try decodeProjection { $0["subagents"] = [row] }
        let subagent = try XCTUnwrap(projection.subagents.first)

        XCTAssertNil(subagent.childThreadId)
        XCTAssertNil(subagent.title)
        XCTAssertNil(subagent.workflow)
        XCTAssertNil(subagent.usage)
        XCTAssertEqual(subagent.result, "done")
    }

    func testWorkflowWithNoDeclaredPhasesDecodesToAnEmptyList() throws {
        // A driver that reports it is running a workflow but has not declared
        // phases yet still has to decode — the roster shows the name without a
        // phase counter rather than dropping the row.
        let row: [String: Any] = [
            "id": "node-subagent",
            "threadId": "thread-v2",
            "origin": "app_owned",
            "status": "running",
            "workflow": ["name": "review"],
            "usage": ["totalTokens": 0],
            "updatedAt": Self.timestamp,
        ]

        let projection = try decodeProjection { $0["subagents"] = [row] }
        let workflow = try XCTUnwrap(projection.subagents.first?.workflow)

        XCTAssertEqual(workflow.phases, [])
        XCTAssertNil(workflow.currentPhase)
        XCTAssertEqual(projection.subagents.first?.usage?.totalTokens, 0)
    }

    // MARK: - Context transfers

    func testContextTransfersCarryBothEndsOfTheEdge() throws {
        let resolution: [String: Any] = [
            "strategy": "portable_context",
            "contextHandoffId": "handoff-1",
        ]
        let row: [String: Any] = [
            "id": "transfer-1",
            "type": "provider_handoff",
            "sourceThreadId": "thread-v2",
            "targetThreadId": "thread-handoff",
            "sourcePoint": ["threadId": "thread-v2"],
            "basePoint": NSNull(),
            "sourceProviderInstanceId": "codex",
            "targetProviderInstanceId": "claude",
            "targetRunId": NSNull(),
            "status": "resolved_portable",
            "resolution": resolution,
            "createdBy": "user",
            "error": NSNull(),
            "createdAt": Self.timestamp,
            "updatedAt": Self.timestamp,
            "consumedAt": NSNull(),
        ]

        let projection = try decodeProjection { $0["contextTransfers"] = [row] }
        let transfer = try XCTUnwrap(projection.contextTransfers.first)

        XCTAssertEqual(transfer.sourceThreadId, "thread-v2")
        XCTAssertEqual(transfer.targetThreadId, "thread-handoff")
        XCTAssertEqual(transfer.resolution?.strategy, "portable_context")
    }

    // MARK: - Runs, attempts and provider rows

    private func runRow(
        id: String,
        status: String,
        queuePosition: Int? = nil,
        activeAttemptId: String? = nil
    ) -> [String: Any] {
        var row: [String: Any] = [
            "id": id,
            "threadId": "thread-v2",
            "ordinal": 3,
            "providerInstanceId": "codex",
            "modelSelection": ["instanceId": "codex", "model": "gpt-5.6-sol"],
            "providerThreadId": "provider-thread-1",
            "userMessageId": "message-\(id)",
            "rootNodeId": NSNull(),
            "status": status,
            "requestedAt": Self.timestamp,
            "startedAt": NSNull(),
            "completedAt": NSNull(),
            "checkpointId": NSNull(),
            "contextHandoffId": NSNull(),
        ]
        row["activeAttemptId"] = activeAttemptId.map { $0 as Any } ?? NSNull()
        if let queuePosition { row["queuePosition"] = queuePosition }
        return row
    }

    func testRunsCarryTheColumnsTheQueueControlDerivesFrom() throws {
        let active = runRow(id: "run-active", status: "running", activeAttemptId: "attempt-1")
        let queued = runRow(id: "run-queued", status: "queued", queuePosition: 2)

        let projection = try decodeProjection { $0["runs"] = [active, queued] }

        let running = try XCTUnwrap(projection.runs.first { $0.id == "run-active" })
        XCTAssertEqual(running.providerThreadId, "provider-thread-1")
        XCTAssertEqual(running.userMessageId, "message-run-active")
        XCTAssertEqual(running.activeAttemptId, "attempt-1")
        // A run that was never queued has no explicit position; callers fall
        // back to the ordinal rather than treating it as position zero.
        XCTAssertNil(running.queuePosition)

        let waiting = try XCTUnwrap(projection.runs.first { $0.id == "run-queued" })
        XCTAssertEqual(waiting.queuePosition, 2)
        XCTAssertNil(waiting.activeAttemptId)
    }

    func testProviderTurnsAndThreadsCarryTheirBackReferences() throws {
        let attributed: [String: Any] = [
            "id": "provider-turn-1",
            "providerThreadId": "provider-thread-1",
            "nodeId": "node-root",
            "runAttemptId": "attempt-1",
            "nativeTurnRef": NSNull(),
            "ordinal": 1,
            "status": "running",
            "startedAt": Self.timestamp,
            "completedAt": NSNull(),
        ]
        let orphaned: [String: Any] = [
            "id": "provider-turn-orphan",
            "providerThreadId": "provider-thread-1",
            "nodeId": "node-root",
            "runAttemptId": NSNull(),
            "ordinal": 2,
            "status": "completed",
            "startedAt": NSNull(),
            "completedAt": NSNull(),
        ]
        let providerThread: [String: Any] = [
            "id": "provider-thread-1",
            "driver": "codex",
            "providerInstanceId": "codex",
            "providerSessionId": "provider-session-1",
            "appThreadId": "thread-v2",
            "ownerNodeId": NSNull(),
            "nativeThreadRef": NSNull(),
            "nativeConversationHeadRef": NSNull(),
            "status": "active",
            "firstRunOrdinal": NSNull(),
            "lastRunOrdinal": NSNull(),
            "handoffIds": [String](),
            "forkedFrom": NSNull(),
            "createdAt": Self.timestamp,
            "updatedAt": Self.timestamp,
        ]

        let projection = try decodeProjection { raw in
            raw["providerTurns"] = [attributed, orphaned]
            raw["providerThreads"] = [providerThread]
        }

        let turn = try XCTUnwrap(projection.providerTurns.first { $0.id == "provider-turn-1" })
        XCTAssertEqual(turn.runAttemptId, "attempt-1")
        // A turn the server could not attribute to an attempt is still rendered;
        // it just cannot be matched back to a run.
        let orphan = try XCTUnwrap(
            projection.providerTurns.first { $0.id == "provider-turn-orphan" }
        )
        XCTAssertNil(orphan.runAttemptId)

        XCTAssertEqual(projection.providerThreads.first?.appThreadId, "thread-v2")
    }

    // MARK: - Provider session capabilities

    private func sessionRow(id: String, capabilities: [String: Any]?) -> [String: Any] {
        var row: [String: Any] = [
            "id": id,
            "driver": "codex",
            "providerInstanceId": "codex",
            "status": "ready",
            "cwd": "/workspace",
            "model": "gpt-5.6-sol",
            "createdAt": Self.timestamp,
            "updatedAt": Self.timestamp,
            "lastError": NSNull(),
        ]
        if let capabilities { row["capabilities"] = capabilities }
        return row
    }

    func testProviderSessionsCarryTheTurnCapabilitiesTheQueueChecks() throws {
        let turns: [String: Any] = [
            "exposesNativeTurnId": true,
            "emitsTurnStarted": true,
            "emitsTurnCompleted": true,
            "supportsInterrupt": true,
            "supportsActiveSteering": true,
            "supportsSteeringByInterruptRestart": false,
            "supportsQueuedMessages": true,
            "terminalStatusQuality": "strong",
        ]
        let capabilities: [String: Any] = [
            "turns": turns,
            "subagents": ["supportsSubagents": true],
        ]

        let projection = try decodeProjection {
            $0["providerSessions"] = [sessionRow(id: "provider-session-1", capabilities: capabilities)]
        }

        let decoded = try XCTUnwrap(projection.providerSessions.first?.capabilities?.turns)
        XCTAssertTrue(decoded.supportsActiveSteering)
        XCTAssertFalse(decoded.supportsSteeringByInterruptRestart)
        XCTAssertTrue(decoded.supportsQueuedMessages)
    }

    func testAbsentCapabilitiesReadAsNoEvidenceRatherThanAsSupport() throws {
        // The second descriptor is one written before the steering flags existed.
        let legacy: [String: Any] = ["turns": ["supportsInterrupt": true]]

        let projection = try decodeProjection {
            $0["providerSessions"] = [
                sessionRow(id: "session-without-capabilities", capabilities: nil),
                sessionRow(id: "session-with-partial-capabilities", capabilities: legacy),
            ]
        }

        let bare = try XCTUnwrap(
            projection.providerSessions.first { $0.id == "session-without-capabilities" }
        )
        XCTAssertNil(bare.capabilities)

        let partial = try XCTUnwrap(
            projection.providerSessions
                .first { $0.id == "session-with-partial-capabilities" }?
                .capabilities?.turns
        )
        // Offering a steer the provider silently drops is worse than not
        // offering it, so an unreported flag reads false rather than assumed.
        XCTAssertFalse(partial.supportsActiveSteering)
        XCTAssertFalse(partial.supportsSteeringByInterruptRestart)
        XCTAssertFalse(partial.supportsQueuedMessages)
    }

    // MARK: - Messages

    func testProjectionCarriesTheMessageTableWithAttachments() throws {
        let attachment: [String: Any] = [
            "type": "image",
            "id": "attachment-1",
            "name": "screenshot.png",
            "mimeType": "image/png",
            "sizeBytes": 2048,
            "workspacePath": ".t3code/uploads/a3f/screenshot.png",
        ]
        let row: [String: Any] = [
            "createdBy": "user",
            "creationSource": "mobile",
            "id": "message-user",
            "threadId": "thread-v2",
            "runId": "run-1",
            "nodeId": NSNull(),
            "role": "user",
            "text": "Look at this",
            "attachments": [attachment],
            "streaming": false,
            "createdAt": Self.timestamp,
            "updatedAt": Self.timestamp,
        ]

        let projection = try decodeProjection { $0["messages"] = [row] }
        let message = try XCTUnwrap(projection.messages.first)

        XCTAssertEqual(message.id, "message-user")
        XCTAssertEqual(message.role, "user")
        XCTAssertEqual(message.text, "Look at this")
        XCTAssertEqual(message.creationSource, "mobile")
        XCTAssertEqual(message.attachments.map(\.id), ["attachment-1"])
        XCTAssertEqual(message.attachments.first?.mimeType, "image/png")
    }

    func testAttachmentOnlyAndAbsentMessagesBothDegradeToEmptyRatherThanFailing() throws {
        let row: [String: Any] = [
            "id": "message-attachment-only",
            "threadId": "thread-v2",
            "role": "user",
            "createdAt": Self.timestamp,
            "updatedAt": Self.timestamp,
        ]

        let projection = try decodeProjection { $0["messages"] = [row] }
        let message = try XCTUnwrap(projection.messages.first)
        XCTAssertEqual(message.text, "")
        XCTAssertEqual(message.attachments, [])
        XCTAssertFalse(message.streaming)

        // A server that predates the table blanks nothing.
        let withoutMessages = try decodeProjection { $0.removeValue(forKey: "messages") }
        XCTAssertEqual(withoutMessages.messages, [])
        XCTAssertFalse(withoutMessages.turnItems.isEmpty)
    }

    func testReplacingKeepsTheMessageTableUnlessItIsReplaced() throws {
        let row: [String: Any] = [
            "id": "message-user",
            "threadId": "thread-v2",
            "role": "user",
            "text": "first",
            "createdAt": Self.timestamp,
            "updatedAt": Self.timestamp,
        ]

        let projection = try decodeProjection { $0["messages"] = [row] }

        // The live-event reducer copies the projection to swap one collection;
        // every other table has to survive that copy.
        let sameMessages = projection.replacing(turnItems: [])
        XCTAssertEqual(sameMessages.messages.map(\.id), ["message-user"])

        let cleared = projection.replacing(messages: [])
        XCTAssertEqual(cleared.messages, [])
        XCTAssertEqual(cleared.turnItems.count, projection.turnItems.count)
    }
}
