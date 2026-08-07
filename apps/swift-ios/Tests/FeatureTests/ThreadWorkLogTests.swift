import XCTest

@testable import T3Code

/// Ports the row-presentation half of apps/mobile/src/lib/threadActivity.ts,
/// apps/mobile/src/features/threads/thread-work-log-labels.ts, and
/// packages/shared/src/changedFilesPreview.ts. The work log is what a reader
/// scans to see what the agent did, so the two clients have to say the same
/// thing about the same item.
final class ThreadWorkLogTests: XCTestCase {
    private func projected(
        _ item: OrchestrationV2TurnItem
    ) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: 0,
            visibility: .local,
            sourceThreadId: "thread-v2",
            sourceItemId: item.id,
            item: item
        )
    }

    private func row(_ item: OrchestrationV2TurnItem) -> ThreadWorkLogRow {
        ThreadWorkLogRow.make(projected(item))
    }

    private func command(
        id: String,
        input: String,
        output: String? = nil,
        status: String = "completed",
        background: Bool? = nil,
        waitKind: String? = nil
    ) -> OrchestrationV2TurnItem {
        var extra: [String: JSONValue] = ["input": .string(input)]
        if let output { extra["output"] = .string(output) }
        if let background { extra["background"] = .bool(background) }
        if let waitKind { extra["waitKind"] = .string(waitKind) }
        return V2Fixture.turnItem(
            id: id, type: "command_execution", status: status, extra: extra
        )
    }

    private func fileChange(
        id: String,
        fileName: String,
        additions: Int? = nil,
        deletions: Int? = nil
    ) -> OrchestrationV2TurnItem {
        var extra: [String: JSONValue] = ["fileName": .string(fileName)]
        if let additions { extra["additions"] = .number(Double(additions)) }
        if let deletions { extra["deletions"] = .number(Double(deletions)) }
        return V2Fixture.turnItem(id: id, type: "file_change", extra: extra)
    }

    private func file(
        _ path: String,
        kind: String = "modified",
        additions: Int = 0,
        deletions: Int = 0
    ) -> OrchestrationV2CheckpointFileSummary {
        OrchestrationV2CheckpointFileSummary(
            path: path, kind: kind, additions: additions, deletions: deletions
        )
    }

    // MARK: - Row identity and status

    func testRowIDIncludesVisibilityAndSourceSoInheritedRowsStayDistinct() {
        let item = command(id: "cmd-1", input: "vp check")
        let local = ThreadWorkLogRow.make(projected(item))
        let inherited = ThreadWorkLogRow.make(
            OrchestrationV2ProjectedTurnItem(
                position: 0,
                visibility: .inherited,
                sourceThreadId: "thread-parent",
                sourceItemId: item.id,
                item: item
            )
        )
        XCTAssertEqual(local.id, "local:thread-v2:cmd-1")
        XCTAssertNotEqual(local.id, inherited.id)
    }

    /// Success is the default outcome — only deviations earn a glyph.
    func testToolRowStatusFollowsTheItemStatus() {
        XCTAssertEqual(row(command(id: "a", input: "ls")).status, .success)
        XCTAssertEqual(row(command(id: "b", input: "ls", status: "failed")).status, .failure)
        XCTAssertEqual(row(command(id: "c", input: "ls", status: "running")).status, .neutral)
        // Orchestration bookkeeping is not a tool call and carries no status.
        XCTAssertNil(
            row(
                V2Fixture.turnItem(
                    id: "d", type: "compaction", extra: ["driver": .string("codex")]
                )
            ).status
        )
    }

    /// Tool-like activities with a neutral status carry no signal worth a row.
    func testNeutralToolRowsAreDroppedFromTheLog() {
        let rows = [
            row(command(id: "a", input: "ls", status: "running")),
            row(command(id: "b", input: "ls")),
            row(
                V2Fixture.turnItem(
                    id: "c", type: "compaction", status: "running",
                    extra: ["driver": .string("codex")]
                )
            ),
        ]
        XCTAssertEqual(ThreadWorkLogRow.visible(rows).map(\.id), [
            "local:thread-v2:b", "local:thread-v2:c",
        ])
    }

    func testInFlightRowsShimmerAndTerminalOnesDoNot() {
        XCTAssertTrue(row(command(id: "a", input: "ls", status: "running")).inProgress)
        XCTAssertTrue(row(command(id: "b", input: "ls", status: "waiting")).inProgress)
        XCTAssertFalse(row(command(id: "c", input: "ls")).inProgress)
        XCTAssertFalse(row(command(id: "d", input: "ls", status: "cancelled")).inProgress)
    }

    // MARK: - Summary and preview

    /// A command that outlives its turn needs to say so: on a phone the turn
    /// footer is often the only thing on screen.
    func testBackgroundCommandsAnnounceThemselvesInTheSummary() {
        XCTAssertEqual(row(command(id: "a", input: "ls")).summary, "Command")
        XCTAssertEqual(
            row(command(id: "b", input: "pnpm dev", status: "running", background: true)).summary,
            "Background command"
        )
        XCTAssertEqual(
            row(
                command(
                    id: "c", input: "wait", status: "running",
                    background: true, waitKind: "monitor"
                )
            ).summary,
            "Waiting for a condition"
        )
    }

    /// While a background command runs, what it is printing beats what it was
    /// asked to do — the command text is already in the summary line.
    func testALiveBackgroundCommandPreviewsItsLastOutputLine() {
        let live = row(
            command(
                id: "a", input: "pnpm dev", output: "ready\nlistening on 3000\n\n",
                status: "running", background: true
            )
        )
        XCTAssertEqual(live.detail, "listening on 3000")

        let settled = row(
            command(
                id: "b", input: "pnpm dev", output: "ready\nlistening on 3000",
                status: "completed", background: true
            )
        )
        XCTAssertEqual(settled.detail, "pnpm dev")
    }

    func testABackgroundCommandWithNoOutputYetFallsBackToItsInput() {
        let live = row(
            command(id: "a", input: "pnpm dev", output: "  \n \n", status: "running", background: true)
        )
        XCTAssertEqual(live.detail, "pnpm dev")
    }

    func testAnItemTitleWinsOverTheGenericSummary() {
        let item = V2Fixture.turnItem(
            id: "a", type: "file_search",
            extra: ["title": .string("grep for the leak"), "pattern": .string("leak")]
        )
        XCTAssertEqual(row(item).summary, "Grep for the leak")
    }

    /// Read-style tool calls (a file/notebook path argument) present as reads,
    /// and surface the path inline rather than hiding it in the inspector.
    func testDynamicToolRowsPreviewTheirReadStyleArguments() {
        let read = V2Fixture.turnItem(
            id: "a", type: "dynamic_tool",
            extra: [
                "toolName": .string("Read"),
                "input": .object(["file_path": .string("  apps/web/src/app.tsx  ")]),
            ]
        )
        XCTAssertEqual(row(read).icon, .eye)
        XCTAssertEqual(row(read).detail, "apps/web/src/app.tsx")

        let grep = V2Fixture.turnItem(
            id: "b", type: "dynamic_tool",
            extra: [
                "toolName": .string("Grep"),
                "input": .object(["pattern": .string("TODO")]),
            ]
        )
        XCTAssertEqual(row(grep).icon, .wrench)
        XCTAssertEqual(row(grep).detail, "TODO")

        let opaque = V2Fixture.turnItem(
            id: "c", type: "dynamic_tool",
            extra: ["toolName": .string("Bash"), "input": .object(["command": .string("ls")])]
        )
        XCTAssertNil(row(opaque).detail)
    }

    /// Without the MCP table a delegated-task row reads as
    /// `mcp__t3-code__delegate_task`.
    func testT3McpToolNamesResolveToTheirDisplayNames() {
        let item = V2Fixture.turnItem(
            id: "a", type: "dynamic_tool",
            extra: ["toolName": .string("mcp__t3-code__delegate_task")]
        )
        XCTAssertEqual(row(item).summary, "Delegate a child task")

        XCTAssertEqual(
            T3McpToolPresentation.displayName(for: "mcp__t3_code__task_status"),
            "Get delegated task status"
        )
        XCTAssertEqual(
            T3McpToolPresentation.displayName(for: "t3-code:preview_open"),
            "Open a page in the preview browser"
        )
        // Providers append a completion word once the call settles.
        XCTAssertEqual(
            T3McpToolPresentation.displayName(for: "mcp__t3-code__task_cancel completed"),
            "Cancel delegated task"
        )
        XCTAssertNil(T3McpToolPresentation.displayName(for: "mcp__other__delegate_task"))
        XCTAssertNil(T3McpToolPresentation.displayName(for: "Bash"))
    }

    /// Provider failures arrive wrapped in adapter names and run ids; the row
    /// shows the operational next step instead.
    func testProviderErrorsPresentTheNextStep() {
        XCTAssertEqual(
            ProviderErrorPresentation.present(
                "codex provider protocol error: stream closed unexpectedly."
            ),
            "Codex couldn't complete the request: stream closed unexpectedly. Check the provider connection in Settings → Providers, then try again."
        )
        XCTAssertEqual(
            ProviderErrorPresentation.present(
                "hermes provider protocol error: Attachments are disabled for this Hermes instance"
            ),
            "Hermes attachments are turned off. Enable Attachments in Settings → Providers, then try again."
        )
        XCTAssertEqual(
            ProviderErrorPresentation.present(
                "Failed to start run run-1 on claude provider thread pt-1."
            ),
            "Claude couldn't start this message. Check the provider connection in Settings → Providers, then try again."
        )
        // Anything unrecognised is passed through rather than mangled.
        XCTAssertEqual(ProviderErrorPresentation.present("  boom  "), "boom")
    }

    // MARK: - Detail compaction

    func testShellWrappersAreStrippedAndWhitespaceCollapsed() {
        XCTAssertEqual(
            ThreadWorkLogPresentation.compactDetail("/bin/zsh -lc 'pnpm test\n  --filter web'"),
            "pnpm test --filter web"
        )
        XCTAssertEqual(
            ThreadWorkLogPresentation.compactDetail("/bin/zsh -lc \"echo hi\""),
            "echo hi"
        )
        XCTAssertEqual(ThreadWorkLogPresentation.compactDetail("  a\t b \n"), "a b")
        XCTAssertNil(ThreadWorkLogPresentation.compactDetail("   \n "))
        XCTAssertNil(ThreadWorkLogPresentation.compactDetail(nil))
    }

    // MARK: - Diff stats

    func testFileChangeRowsCarryTheirOwnDiffstat() {
        let stat = row(fileChange(id: "a", fileName: "a.ts", additions: 3, deletions: 1)).diffStat
        XCTAssertEqual(stat?.additions, 3)
        XCTAssertEqual(stat?.deletions, 1)
        // A change with no counted lines shows no diffstat at all.
        XCTAssertNil(row(fileChange(id: "b", fileName: "b.ts")).diffStat)
        XCTAssertNil(row(command(id: "c", input: "ls")).diffStat)
    }

    func testHiddenRowDiffstatsAreTotalled() {
        let totals = ThreadWorkLogRow.totalDiffStat([
            row(fileChange(id: "a", fileName: "a.ts", additions: 3, deletions: 1)),
            row(fileChange(id: "b", fileName: "b.ts", additions: 4, deletions: 0)),
            row(command(id: "c", input: "ls")),
        ])
        XCTAssertEqual(totals.additions, 7)
        XCTAssertEqual(totals.deletions, 1)
    }

    // MARK: - Grouping

    /// A group is the unit that folds, so it must not straddle runs.
    func testWorkGroupsDoNotStraddleRuns() {
        let nextRun = V2Fixture.turnItem(
            id: "c", type: "command_execution",
            extra: ["input": .string("cat"), "runId": .string("run-2")]
        )
        let groups = ThreadWorkLogRow.groups([
            row(command(id: "a", input: "ls")),
            row(command(id: "b", input: "grep")),
            row(nextRun),
        ])
        XCTAssertEqual(groups.map(\.count), [2, 1])
    }

    /// A prominent row opens a related thread; folding it away behind a count
    /// would hide the only way to reach that thread.
    func testProminentRowsStandAlone() {
        let subagent = V2Fixture.turnItem(
            id: "sub-1", type: "subagent",
            extra: [
                "subagentId": .string("sub-1"), "origin": .string("delegated_task"),
                "driver": .string("claude"), "providerInstanceId": .string("claude"),
                "prompt": .string("go"),
            ]
        )
        let groups = ThreadWorkLogRow.groups([
            row(command(id: "a", input: "ls")),
            row(subagent),
            row(command(id: "b", input: "grep")),
        ])
        XCTAssertEqual(groups.map(\.count), [1, 1, 1])
    }

    // MARK: - Collapsing

    /// A background command is usually launched early in a turn, so keeping
    /// only the last row would collapse away the one row still reporting.
    func testCollapsingPinsLiveBackgroundCommands() {
        let rows = [
            row(command(id: "a", input: "pnpm dev", status: "running", background: true)),
            row(command(id: "b", input: "ls")),
            row(command(id: "c", input: "cat")),
        ]
        XCTAssertEqual(
            ThreadWorkLogPresentation.collapsed(rows).map(\.id),
            ["local:thread-v2:a", "local:thread-v2:c"]
        )
    }

    func testCollapsingKeepsTheLastRowWhenNothingIsLive() {
        let rows = [
            row(command(id: "a", input: "ls")),
            row(command(id: "b", input: "cat")),
        ]
        XCTAssertEqual(ThreadWorkLogPresentation.collapsed(rows).map(\.id), ["local:thread-v2:b"])
    }

    /// A settled background command is no longer reporting, so it folds away
    /// like any other finished row.
    func testASettledBackgroundCommandIsNotPinned() {
        let rows = [
            row(command(id: "a", input: "pnpm dev", background: true)),
            row(command(id: "b", input: "ls")),
        ]
        XCTAssertEqual(ThreadWorkLogPresentation.collapsed(rows).map(\.id), ["local:thread-v2:b"])
    }

    func testOverflowNounFollowsTheKindAndCountOfHiddenRows() {
        XCTAssertEqual(
            ThreadWorkLogRow.overflowNoun(onlyToolRows: true, count: 1), "tool call"
        )
        XCTAssertEqual(
            ThreadWorkLogRow.overflowNoun(onlyToolRows: true, count: 3), "tool calls"
        )
        XCTAssertEqual(
            ThreadWorkLogRow.overflowNoun(onlyToolRows: false, count: 1), "log entry"
        )
        XCTAssertEqual(
            ThreadWorkLogRow.overflowNoun(onlyToolRows: false, count: 2), "log entries"
        )
    }

    // MARK: - Paths

    /// Trailing directories stay muted while the file name carries full
    /// foreground weight; only the last two directories are shown.
    func testDisplayPathKeepsTheFileNameAndTwoTrailingDirectories() {
        let deep = ThreadWorkspaceFilePath.displayComponents(
            "apps/swift-ios/Features/Chat/ThreadWorkLog.swift", workspaceRoot: nil
        )
        XCTAssertEqual(deep.prefix, "…/Features/Chat/")
        XCTAssertEqual(deep.name, "ThreadWorkLog.swift")

        let shallow = ThreadWorkspaceFilePath.displayComponents("README.md", workspaceRoot: nil)
        XCTAssertEqual(shallow.prefix, "")
        XCTAssertEqual(shallow.name, "README.md")
    }

    func testAbsolutePathsAreShownRelativeToTheWorkspace() {
        XCTAssertEqual(
            ThreadWorkspaceFilePath.relative(
                workspaceRoot: "/Users/me/code/t3/", target: "/Users/me/code/t3/apps/web/app.tsx"
            ),
            "apps/web/app.tsx"
        )
        // Outside the workspace there is no route to open.
        XCTAssertNil(
            ThreadWorkspaceFilePath.relative(
                workspaceRoot: "/Users/me/code/t3", target: "/etc/hosts"
            )
        )
        XCTAssertNil(
            ThreadWorkspaceFilePath.relative(workspaceRoot: nil, target: "/etc/hosts")
        )
        XCTAssertNil(
            ThreadWorkspaceFilePath.relative(workspaceRoot: "/root", target: "~/notes.md")
        )
        XCTAssertEqual(
            ThreadWorkspaceFilePath.relative(workspaceRoot: nil, target: "./apps//web/app.tsx"),
            "apps/web/app.tsx"
        )
        // A relative path that escapes the workspace resolves to nothing.
        XCTAssertNil(
            ThreadWorkspaceFilePath.relative(workspaceRoot: "/root", target: "../outside.txt")
        )
    }

    // MARK: - Changed files preview

    func testScopeSummaryHeadlinesTheBusiestTopLevelDirectories() {
        let scopes = ChangedFilesPreview.summarizeScopes([
            file("apps/web/a.ts"),
            file("apps/web/b.ts"),
            file("packages/shared/c.ts"),
            file("README.md"),
        ])
        XCTAssertEqual(
            scopes.map(\.label), ["apps", "packages", "root"]
        )
        XCTAssertEqual(scopes.first?.fileCount, 2)
    }

    func testScopeSummaryIsCappedAndTiesKeepFirstAppearanceOrder() {
        let scopes = ChangedFilesPreview.summarizeScopes([
            file("e/1.ts"), file("d/1.ts"), file("c/1.ts"), file("b/1.ts"), file("a/1.ts"),
        ])
        XCTAssertEqual(scopes.map(\.label), ["e", "d", "c", "b"])
    }

    /// The preview shows the breadth of the change: one file per scope first,
    /// so three files from one folder never stand in for the whole turn.
    func testFilePreviewSpreadsAcrossScopesBeforeFillingUp() {
        let preview = ChangedFilesPreview.preview([
            file("apps/web/a.ts"),
            file("apps/web/b.ts"),
            file("packages/shared/c.ts"),
            file("docs/d.md"),
        ])
        XCTAssertEqual(
            preview.map(\.path),
            ["apps/web/a.ts", "packages/shared/c.ts", "docs/d.md"]
        )
    }

    func testFilePreviewFallsBackToRemainingFilesWhenScopesRunOut() {
        let preview = ChangedFilesPreview.preview([
            file("apps/a.ts"), file("apps/b.ts"), file("apps/c.ts"), file("apps/d.ts"),
        ])
        XCTAssertEqual(preview.map(\.path), ["apps/a.ts", "apps/b.ts", "apps/c.ts"])
    }

    func testChangedFileNameTakesTheLastSegmentOfEitherSeparator() {
        XCTAssertEqual(ChangedFilesPreview.fileName("apps/web/app.tsx"), "app.tsx")
        XCTAssertEqual(ChangedFilesPreview.fileName("apps\\web\\app.tsx"), "app.tsx")
        XCTAssertEqual(ChangedFilesPreview.fileName("app.tsx"), "app.tsx")
    }

    // MARK: - Checkpoints

    /// Checkpoints stay in the work log rather than becoming dividers, and the
    /// row that carries them is the changed-files card.
    func testCheckpointRowsSummariseTheirChangedFiles() {
        let item = V2Fixture.turnItem(
            id: "checkpoint-1", type: "checkpoint",
            extra: [
                "checkpointId": .string("cp-1"),
                "scopeId": .string("scope-1"),
                "files": .array([
                    .object([
                        "path": .string("apps/web/a.ts"), "kind": .string("modified"),
                        "additions": .number(3), "deletions": .number(1),
                    ]),
                    .object([
                        "path": .string("apps/web/b.ts"), "kind": .string("added"),
                        "additions": .number(9), "deletions": .number(0),
                    ]),
                ]),
            ]
        )
        let checkpoint = row(item)
        XCTAssertEqual(checkpoint.summary, "Checkpoint captured")
        XCTAssertEqual(checkpoint.detail, "2 changed files")
        XCTAssertFalse(ThreadLifecycle.isLifecycleTimelineItem(item))
    }
}
