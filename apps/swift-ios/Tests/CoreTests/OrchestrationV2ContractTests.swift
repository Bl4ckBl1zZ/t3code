import XCTest

@testable import T3Code

/// Decode tests against a fixture generated from the TypeScript contracts by
/// `scripts/generate-swift-contract-fixtures.ts`.
///
/// The Swift client mirrors `packages/contracts` by hand, so nothing makes a
/// contract change fail at Swift compile time. These tests are the substitute:
/// regenerate the fixture after a contract change and anything the Swift models
/// got wrong fails here rather than at runtime on a device.
final class OrchestrationV2ContractTests: XCTestCase {
    /// Every turn item type the contract defines, as of the generated fixture.
    /// Kept explicit so adding a contract variant without a Swift case fails
    /// loudly rather than silently decoding to `.unknown`.
    private static let expectedTurnItemTypes: Set<String> = [
        "user_message", "assistant_message", "reasoning", "proposed_plan", "todo_list",
        "user_input_request", "file_change", "command_execution", "file_search", "web_search",
        "approval_request", "checkpoint", "checkpoint_rollback", "run_interrupt_request",
        "run_interrupt_result", "error", "compaction", "handoff", "fork", "thread_created",
        "subagent", "dynamic_tool",
    ]

    /// Read from the source tree rather than the test bundle. `ci-test.sh` runs
    /// on a simulator on the machine that built it, so the path always resolves,
    /// and this avoids depending on how the synchronized group classifies JSON.
    private func fixtureData() throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/orchestrationV2Projection.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            XCTFail(
                "Missing \(url.path). Run: node scripts/generate-swift-contract-fixtures.ts"
            )
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    private func projection() throws -> OrchestrationV2ThreadProjection {
        try JSONDecoder().decode(OrchestrationV2ThreadProjection.self, from: fixtureData())
    }

    func testContractGeneratedProjectionDecodes() throws {
        let projection = try projection()
        XCTAssertEqual(projection.thread.id, "thread-v2")
        XCTAssertEqual(projection.thread.createdBy, "user")
        XCTAssertEqual(projection.thread.creationSource, "web")
        XCTAssertFalse(projection.turnItems.isEmpty)
        XCTAssertEqual(projection.visibleTurnItems.count, projection.turnItems.count)
    }

    func testEveryContractTurnItemTypeHasAModeledSwiftCase() throws {
        let projection = try projection()

        XCTAssertEqual(
            Set(projection.turnItems.map(\.type)),
            Self.expectedTurnItemTypes,
            "fixture types drifted; regenerate the fixture and add the missing Swift cases"
        )

        // The real assertion: nothing fell through to the forward-compatible
        // `unknown` case. A new contract variant would land there silently.
        let unmodeled = projection.turnItems.filter {
            if case .unknown = $0.payload { return true }
            return false
        }
        XCTAssertEqual(
            unmodeled.map(\.type).sorted(), [],
            "turn item types decoded as unknown"
        )
    }

    func testWindowedProjectionReportsOmittedHistory() throws {
        let projection = try projection()
        // The fork replaced upstream's keyset `hasMore` with this count; the
        // "load earlier" affordance keys off it.
        XCTAssertEqual(projection.truncatedVisibleItemCount, 7)
        XCTAssertTrue(projection.hasOlderItems)
    }

    func testUserMessagesCarryIntentAndCreationProvenance() throws {
        let projection = try projection()
        let userMessages = projection.turnItems.compactMap {
            item -> (item: OrchestrationV2TurnItem, id: String, intent: OrchestrationV2UserMessageInputIntent)? in
            guard case let .userMessage(messageID, intent, _, _) = item.payload else { return nil }
            return (item, messageID, intent)
        }
        XCTAssertEqual(userMessages.count, 2)

        let scheduled = try XCTUnwrap(
            userMessages.first { $0.id.hasPrefix("scheduled-task-message:") }
        )
        XCTAssertEqual(scheduled.intent, .queuedTurn)
        XCTAssertEqual(scheduled.item.base.createdBy, "system")

        let typed = try XCTUnwrap(userMessages.first { $0.id == "message-user" })
        XCTAssertEqual(typed.intent, .turnStart)
    }

    func testBackgroundCommandLivenessSurvivesDecoding() throws {
        let projection = try projection()
        let commands = projection.turnItems.compactMap { item -> OrchestrationV2CommandLiveness? in
            guard case let .commandExecution(_, _, _, liveness) = item.payload else { return nil }
            return liveness
        }
        XCTAssertEqual(commands.count, 2)

        // A background command that outlived its tool call is what the fork's
        // background-task rows are built on, so these fields must survive.
        let background = try XCTUnwrap(commands.first { $0.taskId == "task-1" })
        XCTAssertEqual(background.background, true)
        XCTAssertEqual(background.hasOutputStream, true)
        XCTAssertEqual(background.exitReason, "exited")

        // A monitor folds into the task it waits on rather than counting as a
        // second running process.
        let monitor = try XCTUnwrap(commands.first { $0.waitKind == "monitor" })
        XCTAssertEqual(monitor.waitingOnTaskId, "task-1")
    }

    func testUnknownTurnItemTypeDegradesToAPlaceholder() throws {
        // Simulates the server shipping a turn item type this build predates.
        // The whole projection must still decode, or one new item type would
        // blank an entire transcript.
        var raw = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any]
        )
        var items = try XCTUnwrap(raw["turnItems"] as? [[String: Any]])
        var invented = items[0]
        invented["id"] = "item-from-the-future"
        invented["type"] = "holographic_projection"
        items.append(invented)
        raw["turnItems"] = items

        let patched = try JSONSerialization.data(withJSONObject: raw)
        let projection = try JSONDecoder().decode(
            OrchestrationV2ThreadProjection.self, from: patched
        )

        let future = try XCTUnwrap(projection.turnItems.first { $0.id == "item-from-the-future" })
        XCTAssertEqual(future.payload, .unknown(type: "holographic_projection"))
        XCTAssertEqual(projection.turnItems.count, items.count)
    }

    func testUnknownStatusIsNotMistakenForFinishedWork() throws {
        var raw = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any]
        )
        var items = try XCTUnwrap(raw["turnItems"] as? [[String: Any]])
        items[0]["status"] = "quantum_superposition"
        raw["turnItems"] = items

        let patched = try JSONSerialization.data(withJSONObject: raw)
        let projection = try JSONDecoder().decode(
            OrchestrationV2ThreadProjection.self, from: patched
        )

        XCTAssertEqual(projection.turnItems[0].status, .unknown)
        // Rendering an unrecognized status as finished would drop the spinner on
        // work that is still running.
        XCTAssertFalse(projection.turnItems[0].status.isTerminal)
    }
}
