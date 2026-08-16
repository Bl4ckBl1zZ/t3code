import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/threadActivityInspector.test.ts. Both clients read
/// the same projection, so the inspector has to surface the same provenance.
final class ThreadActivityInspectorTests: XCTestCase {
    private let sourceThreadID = "thread-source"

    /// Inherited rows are the interesting case — they carry a source thread
    /// that differs from the thread being viewed.
    private func inheritedRow(_ item: OrchestrationV2TurnItem) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: 0,
            visibility: .inherited,
            sourceThreadId: sourceThreadID,
            sourceItemId: item.id,
            item: item
        )
    }

    private func block(
        _ model: ThreadActivityInspectorModel,
        _ label: String
    ) -> ThreadActivityInspectorBlock? {
        model.blocks.first { $0.label == label }
    }

    func testCommandExecutionPresentsLifecycleSupportOutputAndExitState() {
        let item = V2Fixture.turnItem(
            id: "command",
            type: "command_execution",
            extra: [
                "input": .string("vp check"),
                "output": .string("all checks passed"),
                "exitCode": .number(0),
                "startedAt": .string("2026-06-20T00:00:00.000Z"),
                "completedAt": .string("2026-06-20T00:00:02.000Z"),
            ]
        )
        let support = ThreadActivityItemSupport(
            run: .init(status: "completed"),
            attempts: [
                .init(attemptOrdinal: 1, status: "superseded", reason: "initial"),
                .init(attemptOrdinal: 2, status: "completed", reason: "steering_restart"),
            ],
            node: .init(kind: "tool_call", status: "completed"),
            providerSession: .init(status: "ready", model: "gpt-5.4", cwd: "/workspace/project")
        )

        let model = ThreadActivityInspector.build(
            row: inheritedRow(item),
            support: support,
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )

        XCTAssertEqual(model.fields.first, .init(label: "Item", value: "command execution"))
        for expected: ThreadActivityInspectorField in [
            .init(label: "Duration", value: "2.0s"),
            .init(label: "Run", value: "completed"),
            .init(label: "Working directory", value: "/workspace/project"),
            .init(label: "Visibility", value: "inherited"),
            // The latest attempt wins, and the underscored reason reads as prose.
            .init(label: "Attempt", value: "2 · completed · steering restart"),
            .init(label: "Node", value: "tool call · completed"),
        ] {
            XCTAssertTrue(model.fields.contains(expected), "missing field \(expected.label)")
        }

        XCTAssertEqual(block(model, "Command")?.value, "vp check")
        XCTAssertEqual(block(model, "Output")?.value, "all checks passed")
        XCTAssertEqual(block(model, "Exit")?.value, "Process exited with code 0")
        XCTAssertEqual(
            block(model, "Attempt history")?.value,
            "Attempt 1 · superseded · initial\nAttempt 2 · completed · steering restart"
        )
    }

    func testSingleAttemptSkipsTheAttemptHistoryBlock() {
        let item = V2Fixture.turnItem(
            id: "command",
            type: "command_execution",
            extra: ["input": .string("vp check")]
        )
        let model = ThreadActivityInspector.build(
            row: inheritedRow(item),
            support: .init(attempts: [.init(attemptOrdinal: 1, status: "completed", reason: "initial")]),
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )
        XCTAssertNil(block(model, "Attempt history"))
        XCTAssertEqual(
            model.fields.first { $0.label == "Attempt" }?.value,
            "1 · completed · initial"
        )
    }

    func testFileSearchResultsCarryTheirLineAndPreview() {
        let item = V2Fixture.turnItem(
            id: "file-search",
            type: "file_search",
            extra: [
                "pattern": .string("resolveSession"),
                "results": .array([
                    .object([
                        "fileName": .string("src/session.ts"),
                        "line": .number(42),
                        "preview": .string("function resolveSession()"),
                    ])
                ]),
            ]
        )

        let model = ThreadActivityInspector.build(
            row: inheritedRow(item),
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )

        XCTAssertEqual(
            model.fileLinks,
            [
                ThreadActivityFileLink(
                    label: "src/session.ts — function resolveSession()",
                    path: "src/session.ts",
                    line: 42
                )
            ]
        )
        XCTAssertEqual(block(model, "Query")?.value, "resolveSession")
    }

    func testWebSearchResultsBecomeLinksAndSnippetBlocks() {
        let item = V2Fixture.turnItem(
            id: "web-search",
            type: "web_search",
            extra: [
                "patterns": .array([.string("Effect Schema docs")]),
                "results": .array([
                    .object([
                        "title": .string("Schema"),
                        "url": .string("https://effect.website/docs/schema"),
                        "snippet": .string("Typed schemas"),
                    ])
                ]),
            ]
        )

        let model = ThreadActivityInspector.build(
            row: inheritedRow(item),
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )

        XCTAssertEqual(
            model.webLinks,
            [ThreadActivityWebLink(label: "Schema", url: "https://effect.website/docs/schema")]
        )
        XCTAssertEqual(block(model, "Schema")?.value, "Typed schemas")
        XCTAssertEqual(block(model, "Queries")?.value, "Effect Schema docs")
    }

    func testDynamicToolPayloadsArePrettyPrintedAlongsideTheRawRow() {
        let item = V2Fixture.turnItem(
            id: "dynamic",
            type: "dynamic_tool",
            extra: [
                "toolName": .string("custom"),
                "input": .object(["nested": .object(["value": .number(1)])]),
                "output": .object(["ok": .bool(true)]),
            ]
        )

        let model = ThreadActivityInspector.build(
            row: inheritedRow(item),
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )

        XCTAssertEqual(
            block(model, "Input")?.value,
            """
            {
              "nested": {
                "value": 1
              }
            }
            """
        )
        XCTAssertEqual(
            block(model, "Output")?.value,
            """
            {
              "ok": true
            }
            """
        )
        XCTAssertTrue(model.structuredDetails.contains("\"type\": \"dynamic_tool\""))
        XCTAssertTrue(model.structuredDetails.contains("\"sourceThreadId\": \"thread-source\""))
    }

    func testRollbackIsOfferedOnlyForTheMatchingReadyCheckpoint() {
        let item = V2Fixture.turnItem(
            id: "checkpoint",
            type: "checkpoint",
            extra: [
                "checkpointId": .string("checkpoint-1"),
                "scopeId": .string("scope-1"),
                "files": .array([
                    .object([
                        "path": .string("src/main.ts"),
                        "kind": .string("modified"),
                        "additions": .number(2),
                        "deletions": .number(1),
                    ])
                ]),
            ]
        )
        let support = ThreadActivityItemSupport(
            checkpoint: .init(id: "checkpoint-1", scopeID: "scope-1", status: "ready")
        )

        let owning = ThreadActivityInspector.build(
            row: inheritedRow(item),
            support: support,
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )
        XCTAssertTrue(owning.canRollback)
        XCTAssertEqual(
            owning.rollbackTarget,
            ThreadActivityRollbackTarget(
                threadID: sourceThreadID,
                checkpointID: "checkpoint-1",
                scopeID: "scope-1"
            )
        )
        XCTAssertEqual(
            owning.checkpointFiles,
            [
                OrchestrationV2CheckpointFileSummary(
                    path: "src/main.ts",
                    kind: "modified",
                    additions: 2,
                    deletions: 1
                )
            ]
        )

        // The same row inherited into a child thread must not offer to rewrite
        // the parent's history.
        let inherited = ThreadActivityInspector.build(
            row: inheritedRow(item),
            support: support,
            currentThreadID: "child-thread",
            currentWireThreadID: "child-thread"
        )
        XCTAssertFalse(inherited.canRollback)
        XCTAssertNil(inherited.rollbackTarget)
    }

    func testUnreadyCheckpointCannotRollBack() {
        let item = V2Fixture.turnItem(
            id: "checkpoint",
            type: "checkpoint",
            extra: [
                "checkpointId": .string("checkpoint-1"),
                "scopeId": .string("scope-1"),
            ]
        )
        let model = ThreadActivityInspector.build(
            row: inheritedRow(item),
            support: .init(checkpoint: .init(id: "checkpoint-1", scopeID: "scope-1", status: "stale")),
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )
        XCTAssertFalse(model.canRollback)
        XCTAssertNil(model.rollbackTarget)
        XCTAssertEqual(model.checkpointFiles, [])
    }

    func testSubagentsNeverReachTheInspectorBecauseTheyAreLifecycleRows() {
        // Subagents render as first-class lifecycle rows, not work-log
        // activities — the feed routes them past the inspector path.
        let item = V2Fixture.turnItem(
            id: "subagent",
            type: "subagent",
            extra: [
                "subagentId": .string("node-1"),
                "origin": .string("provider_native"),
                "driver": .string("claude"),
                "providerInstanceId": .string("claude"),
                "prompt": .string("Audit the reducer"),
                "progress": .string("Starting"),
            ]
        )
        XCTAssertTrue(ThreadLifecycle.isLifecycleTimelineItem(item))
    }

    func testFileChangeHidesBeforeAndAfterWhenAUnifiedDiffExists() {
        func fileChange(diff: JSONValue) -> ThreadActivityInspectorModel {
            let item = V2Fixture.turnItem(
                id: "file-change",
                type: "file_change",
                extra: [
                    "fileName": .string("src/main.ts"),
                    "additions": .number(2),
                    "deletions": .number(1),
                    "oldStr": .string("before"),
                    "newStr": .string("after"),
                    "diffStr": diff,
                ]
            )
            return ThreadActivityInspector.build(
                row: inheritedRow(item),
                currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
            )
        }

        let withDiff = fileChange(diff: .string("@@ -1 +1 @@"))
        XCTAssertEqual(withDiff.diff, "@@ -1 +1 @@")
        XCTAssertNil(block(withDiff, "Before"))
        XCTAssertNil(block(withDiff, "After"))
        XCTAssertEqual(
            withDiff.fields.first { $0.label == "Changes" }?.value,
            "+2 −1"
        )
        XCTAssertEqual(
            withDiff.fileLinks,
            [ThreadActivityFileLink(label: "src/main.ts", path: "src/main.ts")]
        )

        // An empty diff string is not a diff, so the text fallback returns.
        let withoutDiff = fileChange(diff: .string(""))
        XCTAssertEqual(withoutDiff.diff, "")
        XCTAssertEqual(block(withoutDiff, "Before")?.value, "before")
        XCTAssertEqual(block(withoutDiff, "After")?.value, "after")
    }

    func testErrorReportsCodeAndRetryabilityOnlyWhenTheProviderSuppliedThem() {
        func errorItem(extraFailureKeys: [String: JSONValue]) -> ThreadActivityInspectorModel {
            var failure: [String: JSONValue] = [
                "class": .string("provider_error"),
                "message": .string("boom"),
            ]
            for (key, value) in extraFailureKeys { failure[key] = value }
            let item = V2Fixture.turnItem(
                id: "error",
                type: "error",
                status: "failed",
                extra: ["failure": .object(failure)]
            )
            return ThreadActivityInspector.build(
                row: inheritedRow(item),
                currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
            )
        }

        let bare = errorItem(extraFailureKeys: [:])
        XCTAssertEqual(block(bare, "Error")?.value, "boom")
        XCTAssertNil(bare.fields.first { $0.label == "Code" })
        XCTAssertNil(bare.fields.first { $0.label == "Retryable" })

        let detailed = errorItem(
            extraFailureKeys: ["code": .string("429"), "retryable": .bool(false)]
        )
        XCTAssertEqual(detailed.fields.first { $0.label == "Code" }?.value, "429")
        XCTAssertEqual(detailed.fields.first { $0.label == "Retryable" }?.value, "no")
    }

    func testTodoListMarksCompletedSteps() {
        let item = V2Fixture.turnItem(
            id: "todo",
            type: "todo_list",
            extra: [
                "planId": .string("plan-1"),
                "steps": .array([
                    .object([
                        "id": .string("step-1"),
                        "text": .string("Read the reducer"),
                        "status": .string("completed"),
                    ]),
                    .object([
                        "id": .string("step-2"),
                        "text": .string("Write the test"),
                        "status": .string("pending"),
                    ]),
                ]),
                "explanation": .string("Two steps"),
            ]
        )

        let model = ThreadActivityInspector.build(
            row: inheritedRow(item),
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )

        XCTAssertEqual(block(model, "Tasks")?.value, "✓ Read the reducer\n○ Write the test")
        XCTAssertEqual(block(model, "Explanation")?.monospaced, false)
    }

    func testLocalVisibilityIsTheDefaultAndGoesUnlabelled() {
        let item = V2Fixture.turnItem(
            id: "reasoning",
            type: "reasoning",
            extra: ["text": .string("thinking")]
        )
        let model = ThreadActivityInspector.build(
            row: OrchestrationV2ProjectedTurnItem(
                position: 0,
                visibility: .local,
                sourceThreadId: sourceThreadID,
                sourceItemId: item.id,
                item: item
            ),
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID
        )
        XCTAssertNil(model.fields.first { $0.label == "Visibility" })
        XCTAssertEqual(block(model, "Reasoning")?.value, "thinking")
    }

    func testRunningItemMeasuresItsDurationAgainstTheClock() {
        let item = V2Fixture.turnItem(
            id: "command",
            type: "command_execution",
            status: "running",
            extra: [
                "input": .string("pnpm build"),
                "startedAt": .string("2026-06-20T00:00:00.000Z"),
            ]
        )
        let model = ThreadActivityInspector.build(
            row: inheritedRow(item),
            currentThreadID: sourceThreadID,
            currentWireThreadID: sourceThreadID,
            now: Date(timeIntervalSince1970: 1_781_913_690)  // 2026-06-20T00:01:30Z
        )
        XCTAssertEqual(model.fields.first { $0.label == "Duration" }?.value, "1m 30s")
    }

    func testFormatDurationMatchesTheSharedTimingHelper() {
        XCTAssertEqual(ThreadActivityInspector.formatDuration(0), "1ms")
        XCTAssertEqual(ThreadActivityInspector.formatDuration(-5), "0ms")
        XCTAssertEqual(ThreadActivityInspector.formatDuration(999), "999ms")
        XCTAssertEqual(ThreadActivityInspector.formatDuration(2_000), "2.0s")
        XCTAssertEqual(ThreadActivityInspector.formatDuration(12_400), "12s")
        XCTAssertEqual(ThreadActivityInspector.formatDuration(60_000), "1m")
        XCTAssertEqual(ThreadActivityInspector.formatDuration(90_000), "1m 30s")
        // A remainder that rounds to a full minute rolls over rather than
        // rendering "1m 60s".
        XCTAssertEqual(ThreadActivityInspector.formatDuration(119_600), "2m")
    }
}
