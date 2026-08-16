import XCTest

@testable import T3Code

/// Ports apps/mobile/src/features/threads/details/ — the sheet's Workspace,
/// Ports, Background Tasks, Automations and Lineage sections — together with
/// packages/shared/src/backgroundProcess.test.ts, whose folding rule the
/// Background Tasks section has to match exactly or the sidebar's "still
/// running" dot and this list disagree about what a thread is waiting on.
final class ThreadDetailsSectionsTests: XCTestCase {
    // MARK: - Connection notice

    func testAnUnprobedEnvironmentIsNotReportedAsBroken() {
        XCTAssertFalse(ThreadDetailsConnection.hasIssue(nil))
        XCTAssertFalse(ThreadDetailsConnection.hasIssue(.connected))
        XCTAssertTrue(ThreadDetailsConnection.hasIssue(.disconnected))
        XCTAssertTrue(ThreadDetailsConnection.hasIssue(.reconnecting))
    }

    func testAReconnectButtonNamesTheAttemptWhileOneIsInFlight() {
        XCTAssertEqual(ThreadDetailsConnection.reconnectLabel(.connecting), "Reconnecting…")
        XCTAssertEqual(ThreadDetailsConnection.reconnectLabel(.reconnecting), "Reconnecting…")
        XCTAssertEqual(ThreadDetailsConnection.reconnectLabel(.disconnected), "Reconnect")
    }

    // MARK: - Workspace

    func testBasenameMatchesTheReactNativeEdgeCases() {
        XCTAssertEqual(ThreadDetailsWorkspace.basename("/a/b/c"), "c")
        XCTAssertEqual(ThreadDetailsWorkspace.basename("/a/b/c/"), "c")
        XCTAssertEqual(ThreadDetailsWorkspace.basename("/a/b/c///"), "c")
        // A path that is nothing but separators is the root, not an empty name.
        XCTAssertEqual(ThreadDetailsWorkspace.basename("/"), "/")
        XCTAssertEqual(ThreadDetailsWorkspace.basename("relative"), "relative")
        XCTAssertNil(ThreadDetailsWorkspace.basename(nil))
        XCTAssertNil(ThreadDetailsWorkspace.basename(""))
    }

    func testTheWorkspaceLabelPrefersTheWorktreeThenTheProjectThenItsRoot() {
        XCTAssertEqual(
            ThreadDetailsWorkspace.label(
                worktreePath: "/w/t3code-4ea0b8cb",
                projectTitle: "T3 Code",
                workspaceRoot: "/repos/t3code"
            ),
            "t3code-4ea0b8cb"
        )
        XCTAssertEqual(
            ThreadDetailsWorkspace.label(
                worktreePath: nil, projectTitle: "T3 Code", workspaceRoot: "/repos/t3code"
            ),
            "T3 Code"
        )
        XCTAssertEqual(
            ThreadDetailsWorkspace.label(
                worktreePath: nil, projectTitle: nil, workspaceRoot: "/repos/t3code"
            ),
            "t3code"
        )
        XCTAssertEqual(
            ThreadDetailsWorkspace.label(
                worktreePath: nil, projectTitle: nil, workspaceRoot: nil
            ),
            "Workspace"
        )
    }

    func testAWorktreeIsNamedAndIconedAsSomethingOtherThanTheProjectFolder() {
        XCTAssertEqual(ThreadDetailsWorkspace.icon(worktreePath: "/w/x"), "arrow.triangle.branch")
        XCTAssertEqual(ThreadDetailsWorkspace.kindLabel(worktreePath: "/w/x"), "Worktree")
        XCTAssertEqual(ThreadDetailsWorkspace.icon(worktreePath: nil), "folder")
        XCTAssertEqual(ThreadDetailsWorkspace.kindLabel(worktreePath: nil), "Project folder")
    }

    func testASetupScriptSaysSoAndEveryIconKindMaps() {
        XCTAssertEqual(
            ThreadDetailsWorkspace.scriptLabel(script(name: "Install", runOnWorktreeCreate: true)),
            "Install (setup)"
        )
        XCTAssertEqual(ThreadDetailsWorkspace.scriptLabel(script(name: "Dev")), "Dev")

        let expected = [
            "test": "flask",
            "lint": "checklist",
            "configure": "wrench.and.screwdriver",
            "build": "hammer",
            "debug": "ladybug",
            "run": "play",
            "something-new": "play",
        ]
        for (icon, symbol) in expected {
            XCTAssertEqual(ThreadDetailsWorkspace.scriptIcon(icon), symbol, "icon \(icon)")
        }
    }

    func testARunningScriptTurnsItsOwnRowIntoTheStopButton() {
        let dev = script(name: "Dev", icon: "run")
        XCTAssertEqual(ThreadDetailsWorkspace.scriptRowIcon(dev, isActive: false), "play")
        XCTAssertEqual(ThreadDetailsWorkspace.scriptRowIcon(dev, isActive: true), "stop.fill")
        XCTAssertEqual(ThreadDetailsWorkspace.scriptRowTitle(dev, isActive: true), "Stop Dev")
        XCTAssertEqual(ThreadDetailsWorkspace.scriptRowTitle(dev, isActive: false), "Dev")
    }

    // MARK: - Ports

    func testThePortsSectionStopsAtFourRowsAndCountsTheRest() {
        let endpoints = (1...7).map { endpoint(key: "\($0)", port: 5170 + $0) }
        XCTAssertEqual(ThreadDetailsPortsSection.visible(endpoints).count, 4)
        XCTAssertEqual(ThreadDetailsPortsSection.overflowFooter(endpoints), "+3 more")
        XCTAssertNil(ThreadDetailsPortsSection.overflowFooter(Array(endpoints.prefix(4))))
    }

    func testAnUnreachablePortRefusesToOpenAndSaysWhy() {
        let unreachable = endpoint(
            reachability: .unreachable(reason: "Only reachable from the machine running it"),
            displayAddress: nil
        )
        XCTAssertEqual(
            ThreadDetailsPortsSection.openRefusal(for: unreachable)?.message,
            "Only reachable from the machine running it"
        )
        XCTAssertNil(ThreadDetailsPortsSection.openURL(for: unreachable))
    }

    func testAStalePortExplainsThatTheServerStoppedRatherThanFailingToConnect() {
        let stale = endpoint(status: .stale)
        XCTAssertEqual(
            ThreadDetailsPortsSection.openRefusal(for: stale)?.title,
            "Port no longer responding"
        )
        XCTAssertNil(ThreadDetailsPortsSection.openURL(for: stale))
    }

    func testALivePortOpensItsResolvedAddressNotTheAnnouncedLoopback() {
        let live = endpoint()
        XCTAssertNil(ThreadDetailsPortsSection.openRefusal(for: live))
        XCTAssertEqual(
            ThreadDetailsPortsSection.openURL(for: live), "http://192.168.1.24:5173/"
        )
        // On a phone the announced `localhost:5173` names the handset, so it is
        // never what a row opens or shows.
        XCTAssertNotEqual(ThreadDetailsPortsSection.openURL(for: live), live.url)
        XCTAssertFalse(ThreadPortsMenu.subtitle(for: live).contains("localhost"))
    }

    func testCopyingFallsBackToTheAnnouncedURLWhenThereIsNoReachableForm() {
        XCTAssertEqual(
            ThreadDetailsPortsSection.copyURL(for: endpoint()), "http://192.168.1.24:5173/"
        )
        XCTAssertEqual(
            ThreadDetailsPortsSection.copyURL(
                for: endpoint(
                    reachability: .unreachable(reason: "no route"), displayAddress: nil
                )
            ),
            "http://localhost:5173/"
        )
    }

    // MARK: - Background tasks

    func testAMonitorFoldsIntoTheCommandItWatches() {
        let command = backgroundCommand(id: "cmd", taskID: "byggcdigy")
        let monitor = backgroundCommand(
            id: "mon", taskID: "b8zv6rtg9", waitKind: "monitor", waitingOnTaskID: "byggcdigy"
        )
        let processes = ThreadDetailsBackgroundTasks.liveProcesses([command, monitor])
        XCTAssertEqual(processes.count, 1)
        XCTAssertEqual(processes.first?.command.id, "cmd")
        XCTAssertEqual(processes.first?.monitor?.id, "mon")
    }

    func testAMonitorWatchingSomethingItCannotNameStillGetsARow() {
        let monitor = backgroundCommand(id: "mon", taskID: nil, waitKind: "monitor")
        let processes = ThreadDetailsBackgroundTasks.liveProcesses([monitor])
        XCTAssertEqual(processes.count, 1)
        XCTAssertNil(processes.first?.monitor)
    }

    func testTwoAbsentHandlesAreNotAMatch() {
        let command = backgroundCommand(id: "cmd", taskID: nil)
        let monitor = backgroundCommand(id: "mon", taskID: nil, waitKind: "monitor")
        let processes = ThreadDetailsBackgroundTasks.liveProcesses([command, monitor])
        XCTAssertEqual(processes.count, 2)
        XCTAssertNil(processes.first?.monitor)
    }

    func testSettledAndForegroundCommandsAreNotBackgroundTasks() {
        let settled = backgroundCommand(id: "done", status: "completed")
        let foreground = backgroundCommand(id: "fg", status: "running", background: nil)
        XCTAssertTrue(
            ThreadDetailsBackgroundTasks.liveProcesses([settled, foreground]).isEmpty
        )
    }

    func testTheSectionStopsAtFourTasksAndCountsTheRest() {
        let commands = (1...6).map { backgroundCommand(id: "cmd-\($0)", taskID: "task-\($0)") }
        let processes = ThreadDetailsBackgroundTasks.liveProcesses(commands)
        XCTAssertEqual(ThreadDetailsBackgroundTasks.visible(processes).count, 4)
        XCTAssertEqual(ThreadDetailsBackgroundTasks.overflowFooter(processes), "+2 more")
    }

    func testOutputBeatsADeadlineAndAMonitorBeatsBoth() {
        let printing = view(backgroundCommand(id: "a", output: "step 1\nstep 2\n"))
        XCTAssertEqual(printing.variant, .tail)

        let deadline = view(backgroundCommand(id: "b", timeoutMs: 30_000))
        XCTAssertEqual(deadline.variant, .deadline)

        let streaming = view(
            backgroundCommand(id: "c", hasOutputStream: true, timeoutMs: 30_000)
        )
        XCTAssertEqual(streaming.variant, .tail)

        let monitor = view(
            backgroundCommand(id: "d", timeoutMs: 30_000, waitKind: "monitor")
        )
        XCTAssertEqual(monitor.variant, .monitor)
    }

    func testPausedTimeIsExcludedFromElapsed() {
        let paused = view(backgroundCommand(id: "a", paused: true, pausedMs: 20_000))
        XCTAssertTrue(paused.paused)
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.elapsedMilliseconds(
                paused, nowMilliseconds: Self.startedAtMilliseconds + 72_000
            ),
            52_000
        )
    }

    func testASettledCommandStopsTheClockInsteadOfCountingForever() {
        let settled = view(
            backgroundCommand(id: "a", status: "completed", completedAt: Self.completedTimestamp)
        )
        XCTAssertFalse(settled.live)
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.elapsedMilliseconds(
                settled, nowMilliseconds: Self.startedAtMilliseconds + 10 * 60_000
            ),
            30_000
        )
    }

    func testTheTailIsTheLastLineWithAnythingOnIt() {
        XCTAssertEqual(ThreadDetailsBackgroundTasks.tail("a\nb\n\n  \n"), "b")
        XCTAssertNil(ThreadDetailsBackgroundTasks.tail(nil))
        XCTAssertNil(ThreadDetailsBackgroundTasks.tail("   "))
        // Only the right-hand side is trimmed, so indentation survives.
        XCTAssertEqual(ThreadDetailsBackgroundTasks.tail("  indented   "), "  indented")
    }

    func testElapsedKeepsSecondsWhereTheyMatterAndDropsThemWhereTheyDoNot() {
        XCTAssertEqual(ThreadDetailsBackgroundTasks.formatElapsed(12_000), "12s")
        XCTAssertEqual(ThreadDetailsBackgroundTasks.formatElapsed(72_000), "1m 12s")
        XCTAssertEqual(ThreadDetailsBackgroundTasks.formatElapsed(14 * 60_000), "14m")
        XCTAssertEqual(ThreadDetailsBackgroundTasks.formatElapsed(95 * 60_000), "1h 35m")
        XCTAssertEqual(ThreadDetailsBackgroundTasks.formatElapsed(-5), "0s")
    }

    func testTheTickSlowsOnceSecondsStopBeingShown() {
        XCTAssertEqual(ThreadDetailsBackgroundTasks.elapsedTickSeconds(30_000), 1)
        XCTAssertEqual(ThreadDetailsBackgroundTasks.elapsedTickSeconds(20 * 60_000), 30)
    }

    func testACommandRowNamesTheCommandAndAMonitorRowNamesTheWait() {
        let command = view(backgroundCommand(id: "a", output: "compiling…\n"))
        XCTAssertEqual(ThreadDetailsBackgroundTasks.title(command), "pnpm vitest run apps/web")
        XCTAssertTrue(ThreadDetailsBackgroundTasks.titleIsMonospaced(command))

        let monitor = view(backgroundCommand(id: "b", waitKind: "monitor"))
        XCTAssertEqual(ThreadDetailsBackgroundTasks.title(monitor), "Waiting on a condition")
        XCTAssertFalse(ThreadDetailsBackgroundTasks.titleIsMonospaced(monitor))
    }

    func testASubtitleReportsOutputTruncationAndWhetherTheAgentIsAsleepOnIt() {
        let quiet = view(backgroundCommand(id: "a"))
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.subtitle(quiet, hasMonitor: false), "no output yet"
        )

        let capped = view(
            backgroundCommand(id: "b", output: "line one\nline two\n", outputTruncated: true)
        )
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.subtitle(capped, hasMonitor: true),
            "line two · output capped · the agent is waiting on it"
        )

        let monitor = view(backgroundCommand(id: "c", waitKind: "monitor"))
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.subtitle(monitor, hasMonitor: false),
            "the agent is asleep until this passes"
        )
    }

    func testAMonitorCountsDownToItsDeadlineWhileACommandCountsUp() {
        let monitor = view(backgroundCommand(id: "a", timeoutMs: 120_000, waitKind: "monitor"))
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.detailLabel(
                monitor, nowMilliseconds: Self.startedAtMilliseconds + 30_000
            ),
            "1m 30s left"
        )

        let command = view(backgroundCommand(id: "b"))
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.detailLabel(
                command, nowMilliseconds: Self.startedAtMilliseconds + 30_000
            ),
            "30s"
        )
    }

    // MARK: - Background capsule

    func testOneTaskReportsTimeAndSeveralReportACount() {
        let solo = summary([backgroundCommand(id: "a", taskID: "t1")], after: 30_000)
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleLabel(
                solo, nowMilliseconds: Self.startedAtMilliseconds + 30_000
            ),
            "30s"
        )

        let several = summary(
            (1...3).map { backgroundCommand(id: "c-\($0)", taskID: "t-\($0)") }, after: 30_000
        )
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleLabel(
                several, nowMilliseconds: Self.startedAtMilliseconds + 30_000
            ),
            "3"
        )
    }

    func testASingleDeadlineCountsDownAndFillsItsRing() {
        let capsule = summary([backgroundCommand(id: "a", timeoutMs: 120_000)], after: 30_000)
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleLabel(
                capsule, nowMilliseconds: Self.startedAtMilliseconds + 30_000
            ),
            "1m 30s"
        )
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleGlyph(
                capsule, nowMilliseconds: Self.startedAtMilliseconds + 30_000
            ),
            .deadline(0.25)
        )
    }

    func testAPrintingCommandOutranksAParkedMonitorForTheGlyph() {
        let capsule = summary(
            [
                backgroundCommand(id: "sleeping", taskID: "t1", waitKind: "monitor"),
                backgroundCommand(id: "printing", taskID: "t2", output: "step 1\n"),
            ],
            after: 5_000
        )
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleGlyph(
                capsule, nowMilliseconds: Self.startedAtMilliseconds + 5_000
            ),
            .command
        )
    }

    func testAFailureLingersThenClears() {
        let failed = backgroundCommand(
            id: "a", status: "failed", completedAt: Self.startedTimestamp, exitCode: 1
        )
        let commands = ThreadDetailsBackgroundTasks.backgroundCommands([failed])

        let lingering = ThreadDetailsBackgroundTasks.summary(
            commands: commands, nowMilliseconds: Self.startedAtMilliseconds + 2_000
        )
        XCTAssertTrue(lingering.reportsOutcome)
        XCTAssertEqual(lingering.outcome?.tone, .danger)
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleLabel(
                lingering, nowMilliseconds: Self.startedAtMilliseconds + 2_000
            ),
            "exit 1"
        )
        // The row behind the capsule is the command that failed, so the tap has
        // somewhere to land.
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleProcesses(
                commands: commands, nowMilliseconds: Self.startedAtMilliseconds + 2_000
            ).first?.command.id,
            "a"
        )

        let expired = ThreadDetailsBackgroundTasks.summary(
            commands: commands, nowMilliseconds: Self.startedAtMilliseconds + 10_000
        )
        XCTAssertTrue(expired.isEmpty)
    }

    func testACleanExitNeverLingers() {
        let done = backgroundCommand(
            id: "a", status: "completed", completedAt: Self.startedTimestamp, exitCode: 0
        )
        let capsule = summary([done], after: 1_000)
        XCTAssertTrue(capsule.isEmpty)
    }

    /// A command that was killed reads as a failure in a status field and means
    /// the opposite thing, so it is toned as a warning and named for what
    /// happened to it.
    func testWorkThatNeverGotToFinishIsNotReportedAsAFailure() {
        let killed = backgroundCommand(
            id: "a",
            status: "failed",
            completedAt: Self.startedTimestamp,
            exitCode: 137,
            exitReason: "killed"
        )
        let capsule = summary([killed], after: 1_000)
        XCTAssertEqual(capsule.outcome?.tone, .warning)
        XCTAssertEqual(capsule.outcome?.label, "stopped")
    }

    func testLiveWorkOutranksAFailureThatHasAlreadyBeenSuperseded() {
        let failed = backgroundCommand(
            id: "old", status: "failed", completedAt: Self.startedTimestamp, exitCode: 1
        )
        let running = backgroundCommand(id: "new", taskID: "t2")
        let capsule = summary([failed, running], after: 2_000)
        XCTAssertFalse(capsule.reportsOutcome)
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleLabel(
                capsule, nowMilliseconds: Self.startedAtMilliseconds + 2_000
            ),
            "2s"
        )
    }

    func testTheCapsuleTicksForALingeringFailureAndCoarsensForOldWork() {
        let failed = backgroundCommand(
            id: "a", status: "failed", completedAt: Self.startedTimestamp, exitCode: 1
        )
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleTickSeconds(
                summary([failed], after: 1_000),
                nowMilliseconds: Self.startedAtMilliseconds + 1_000
            ),
            1
        )

        let old = summary([backgroundCommand(id: "b", taskID: "t1")], after: 20 * 60_000)
        XCTAssertEqual(
            ThreadDetailsBackgroundTasks.capsuleTickSeconds(
                old, nowMilliseconds: Self.startedAtMilliseconds + 20 * 60_000
            ),
            30
        )
    }

    // MARK: - Automations

    func testOnlyAutomationsBoundToThisThreadAreListed() {
        let tasks = [
            automation(id: "a", threadID: "thread-v2"),
            automation(id: "b", threadID: "other"),
            automation(id: "c", threadID: nil),
        ]
        XCTAssertEqual(
            ThreadDetailsAutomationsSection.boundTasks(tasks, threadID: "thread-v2").map(\.id),
            ["a"]
        )
    }

    func testTheAutomationsSectionHidesWhenEmptyButNotWhenItFailedToLoad() {
        XCTAssertFalse(
            ThreadDetailsAutomationsSection.isVisible(
                tasks: [automation(id: "a", threadID: "other")],
                threadID: "thread-v2",
                hasError: false
            )
        )
        // A load error must not look like "no automations": tasks may exist
        // whose controls would silently vanish.
        XCTAssertTrue(
            ThreadDetailsAutomationsSection.isVisible(
                tasks: [], threadID: "thread-v2", hasError: true
            )
        )
        XCTAssertTrue(
            ThreadDetailsAutomationsSection.isVisible(
                tasks: [automation(id: "a", threadID: "thread-v2")],
                threadID: "thread-v2",
                hasError: false
            )
        )
    }

    func testAnAutomationRowReadsItsScheduleAndRunState() {
        let now = Date(timeIntervalSince1970: 1_754_308_800)
        let task = automation(id: "a", threadID: "thread-v2", enabled: false)
        XCTAssertEqual(
            ThreadDetailsAutomationsSection.subtitle(for: task, now: now),
            "Every 15 min · paused"
        )
        XCTAssertEqual(ThreadDetailsAutomationsSection.statusTone(for: task), .dormant)
    }

    // MARK: - Lineage framing

    func testTheSectionIsCalledSubagentsUntilSomethingElseIsListed() {
        let subagentOnly = [
            relationshipRow(threadID: "child", kind: .subagent, source: "thread-v2")
        ]
        XCTAssertEqual(ThreadDetailsLineageSection.title(rows: subagentOnly), "Subagents")

        let mixed =
            subagentOnly + [relationshipRow(threadID: "parent", kind: .fork, source: "parent")]
        XCTAssertEqual(ThreadDetailsLineageSection.title(rows: mixed), "Lineage")
        XCTAssertEqual(ThreadDetailsLineageSection.title(rows: []), "Subagents")
    }

    func testAnArchivedRelatedThreadStaysTappableWhileADeletedOneDoesNot() {
        XCTAssertFalse(ThreadDetailsLineageSection.isDisabled(availability: "Archived"))
        XCTAssertTrue(ThreadDetailsLineageSection.isArchived(availability: "Archived"))
        XCTAssertTrue(ThreadDetailsLineageSection.isDisabled(availability: "Deleted"))
        XCTAssertTrue(ThreadDetailsLineageSection.isDisabled(availability: "Unavailable"))
        XCTAssertFalse(ThreadDetailsLineageSection.isDisabled(availability: nil))
    }

    func testTheDoneGroupPluralisesItsCount() {
        XCTAssertEqual(ThreadDetailsLineageSection.doneGroupLabel(count: 3), "Done · 3")
        XCTAssertEqual(
            ThreadDetailsLineageSection.doneGroupAccessibilityLabel(count: 1),
            "1 finished subagent"
        )
        XCTAssertEqual(
            ThreadDetailsLineageSection.doneGroupAccessibilityLabel(count: 4),
            "4 finished subagents"
        )
    }

    // MARK: - Fixtures

    private static let startedTimestamp = "2026-08-04T12:00:00.000Z"
    private static let completedTimestamp = "2026-08-04T12:00:30.000Z"
    private static let startedAtMilliseconds = 1_785_844_800_000

    private func script(
        id: String = "script-1",
        name: String,
        icon: String = "run",
        runOnWorktreeCreate: Bool = false
    ) -> ProjectScript {
        ProjectScript(
            id: id,
            name: name,
            command: "pnpm \(name.lowercased())",
            icon: icon,
            runOnWorktreeCreate: runOnWorktreeCreate,
            previewUrl: nil,
            autoOpenPreview: nil
        )
    }

    private func endpoint(
        key: String = "5173",
        port: Int = 5173,
        status: ThreadEndpointStatus = .live,
        reachability: EndpointReachability = .reachable(
            url: "http://192.168.1.24:5173/", via: .privateNetwork
        ),
        displayAddress: String? = "192.168.1.24:5173"
    ) -> ThreadEndpoint {
        ThreadEndpoint(
            key: key,
            url: "http://localhost:\(port)/",
            host: "localhost",
            port: port,
            status: status,
            source: .stdout,
            terminalID: "term-1",
            scriptID: nil,
            processName: nil,
            pinned: false,
            local: true,
            firstSeenAtMs: 0,
            reachability: reachability,
            displayAddress: displayAddress
        )
    }

    private func backgroundCommand(
        id: String,
        status: String = "waiting",
        background: Bool? = true,
        taskID: String? = "bs891h9i0",
        output: String? = nil,
        hasOutputStream: Bool? = nil,
        outputTruncated: Bool? = nil,
        timeoutMs: Int? = nil,
        paused: Bool? = nil,
        pausedMs: Int? = nil,
        waitKind: String? = nil,
        waitingOnTaskID: String? = nil,
        completedAt: String? = nil,
        exitCode: Int? = nil,
        exitReason: String? = nil
    ) -> OrchestrationV2TurnItem {
        var extra: [String: JSONValue] = [
            "input": .string("pnpm vitest run apps/web"),
            "startedAt": .string(Self.startedTimestamp),
            "completedAt": completedAt.map(JSONValue.string) ?? .null,
        ]
        if let background { extra["background"] = .bool(background) }
        if let taskID { extra["taskId"] = .string(taskID) }
        if let output { extra["output"] = .string(output) }
        if let hasOutputStream { extra["hasOutputStream"] = .bool(hasOutputStream) }
        if let outputTruncated { extra["outputTruncated"] = .bool(outputTruncated) }
        if let timeoutMs { extra["timeoutMs"] = .number(Double(timeoutMs)) }
        if let paused { extra["paused"] = .bool(paused) }
        if let pausedMs { extra["pausedMs"] = .number(Double(pausedMs)) }
        if let waitKind { extra["waitKind"] = .string(waitKind) }
        if let waitingOnTaskID { extra["waitingOnTaskId"] = .string(waitingOnTaskID) }
        if let exitCode { extra["exitCode"] = .number(Double(exitCode)) }
        if let exitReason { extra["exitReason"] = .string(exitReason) }
        return V2Fixture.turnItem(
            id: id, type: "command_execution", status: status, extra: extra
        )
    }

    private func summary(
        _ items: [OrchestrationV2TurnItem],
        after offsetMilliseconds: Int
    ) -> ThreadBackgroundSummary {
        ThreadDetailsBackgroundTasks.summary(
            commands: ThreadDetailsBackgroundTasks.backgroundCommands(items),
            nowMilliseconds: Self.startedAtMilliseconds + offsetMilliseconds
        )
    }

    private func view(_ item: OrchestrationV2TurnItem) -> ThreadDetailsBackgroundView {
        guard let command = ThreadDetailsBackgroundCommand(item) else {
            XCTFail("expected a command execution item")
            fatalError("unreachable")
        }
        return ThreadDetailsBackgroundTasks.resolveView(
            command, nowMilliseconds: Self.startedAtMilliseconds
        )
    }

    private func automation(
        id: String,
        threadID: String?,
        enabled: Bool = true
    ) -> FeatureScheduledTask {
        FeatureScheduledTask(
            id: id,
            title: "Nightly sweep",
            prompt: "Check the queue",
            enabled: enabled,
            schedule: .interval(everyMs: 15 * 60_000),
            projectID: "project-1",
            threadID: threadID,
            launch: .mobileDefault(
                modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
            )
        )
    }

    private func relationshipRow(
        threadID: String,
        kind: ThreadRelationshipKind,
        source: String
    ) -> ThreadRelationshipRow {
        ThreadRelationshipRow(
            threadID: threadID,
            fromThreadID: "thread-v2",
            depth: 1,
            edge: ThreadRelationshipEdge(
                sourceThreadID: source,
                targetThreadID: threadID,
                kind: kind,
                status: "running"
            )
        )
    }
}
