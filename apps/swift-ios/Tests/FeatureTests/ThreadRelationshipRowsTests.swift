import XCTest

@testable import T3Code

/// Ports packages/client-runtime/src/state/threadRelationships.test.ts and the
/// decay behaviour of apps/mobile/src/features/threads/useThreadRelationshipRows.ts.
/// Both clients render the same lineage, so they have to derive it identically.
final class ThreadRelationshipRowsTests: XCTestCase {
    private func shell(
        _ id: String,
        title: String? = nil,
        status: String = "completed",
        parent: String? = nil,
        relationship: String? = nil,
        forkedFromRun: String? = nil,
        archivedAt: String? = nil,
        deletedAt: String? = nil
    ) -> ThreadRelationshipShell {
        ThreadRelationshipShell(
            id: id,
            title: title ?? id,
            status: status,
            parentThreadID: parent,
            relationshipToParent: relationship,
            forkedFromRunThreadID: forkedFromRun,
            archivedAt: archivedAt,
            deletedAt: deletedAt
        )
    }

    // MARK: Graph

    func testKeepsMissingParentsAndCyclesNavigableWithoutRecursiveTraversal() {
        let graph = ThreadRelationships.deriveGraph(
            threads: [
                shell(
                    "thread-root", title: "Root", parent: "thread-child",
                    relationship: "fork", forkedFromRun: "thread-child"
                ),
                shell(
                    "thread-child", title: "Child", parent: "thread-missing",
                    relationship: "fork", forkedFromRun: "thread-missing"
                ),
            ],
            ownerThreadID: nil
        )

        XCTAssertEqual(graph.node("thread-missing")?.missing, true)
        XCTAssertEqual(
            ThreadRelationships.immediateRelationships(graph: graph, threadID: "thread-root")
                .map(\.threadID),
            ["thread-child"]
        )
        XCTAssertEqual(
            ThreadRelationships.walk(graph: graph, threadID: "thread-root")
                .map { [$0.threadID, String($0.depth)] },
            [["thread-child", "1"], ["thread-missing", "2"]]
        )
    }

    func testCombinesSubagentAndTransferEdgesWithArchivedShellState() {
        let graph = ThreadRelationships.deriveGraph(
            threads: [
                shell("thread-parent", title: "Parent"),
                shell(
                    "thread-child", title: "Subagent", parent: "thread-parent",
                    relationship: "subagent", archivedAt: "2026-06-24T00:00:00.000Z"
                ),
            ],
            ownerThreadID: "thread-parent",
            subagents: [
                ThreadRelationshipSubagentLink(
                    id: "subagent-1", childThreadID: "thread-child", status: "completed"
                )
            ],
            transfers: [
                ThreadRelationshipTransferLink(
                    id: "transfer-1",
                    sourceThreadID: "thread-child",
                    targetThreadID: "thread-transfer",
                    status: "completed"
                )
            ]
        )

        XCTAssertNotNil(graph.node("thread-child")?.thread?.archivedAt)
        XCTAssertEqual(graph.node("thread-transfer")?.missing, true)
        XCTAssertTrue(
            graph.edges.contains {
                $0.sourceThreadID == "thread-parent" && $0.targetThreadID == "thread-child"
                    && $0.kind == .subagent
            }
        )
        XCTAssertTrue(
            graph.edges.contains {
                $0.sourceThreadID == "thread-child" && $0.targetThreadID == "thread-transfer"
                    && $0.kind == .transfer
            }
        )
    }

    func testKeepsTheLiveShellWhenAnArchivedSnapshotContainsTheSameThreadID() {
        let live = shell(
            "thread-child", title: "Live child", status: "running",
            parent: "thread-parent", relationship: "fork", forkedFromRun: "thread-parent"
        )
        let staleArchived = shell(
            "thread-child", title: "Stale archived child",
            parent: "thread-stale-parent", relationship: "fork",
            forkedFromRun: "thread-stale-parent", archivedAt: "2026-06-24T00:00:00.000Z"
        )

        let graph = ThreadRelationships.deriveGraph(
            threads: [live, staleArchived], ownerThreadID: nil
        )

        XCTAssertEqual(graph.node("thread-child")?.thread?.title, "Live child")
        XCTAssertNil(graph.node("thread-child")?.thread?.archivedAt)
        XCTAssertEqual(graph.edges.count, 1)
        XCTAssertEqual(graph.edges.first?.sourceThreadID, "thread-parent")
        XCTAssertNil(graph.node("thread-stale-parent"))
    }

    func testTransferEdgeBetweenAThreadAndItselfIsDropped() {
        let graph = ThreadRelationships.deriveGraph(
            threads: [shell("thread-a")],
            ownerThreadID: "thread-a",
            transfers: [
                ThreadRelationshipTransferLink(
                    id: "transfer-self",
                    sourceThreadID: "thread-a",
                    targetThreadID: "thread-a",
                    status: "resolved_native"
                )
            ]
        )
        XCTAssertTrue(graph.edges.isEmpty)
    }

    func testSubagentEdgesAreOnlyDerivedForTheOwningThread() {
        // Subagent rows come from the open projection, so without an owner
        // there is nothing to hang the edge off.
        let graph = ThreadRelationships.deriveGraph(
            threads: [shell("thread-a")],
            ownerThreadID: nil,
            subagents: [
                ThreadRelationshipSubagentLink(
                    id: "subagent-1", childThreadID: "thread-child", status: "running"
                )
            ]
        )
        XCTAssertTrue(graph.edges.isEmpty)
    }

    // MARK: Merge-back target

    func testResolvesMergeBackOnlyForForksAndPrefersTheRecordedForkSource() {
        XCTAssertEqual(
            ThreadRelationships.mergeBackTargetThreadID(
                shell(
                    "thread-fork", parent: "thread-parent", relationship: "fork",
                    forkedFromRun: "thread-source"
                )
            ),
            "thread-source"
        )
        XCTAssertEqual(
            ThreadRelationships.mergeBackTargetThreadID(
                shell("thread-fork", parent: "thread-parent", relationship: "fork")
            ),
            "thread-parent"
        )
        XCTAssertNil(
            ThreadRelationships.mergeBackTargetThreadID(
                shell("thread-child", parent: "thread-parent", relationship: "subagent")
            )
        )
        XCTAssertNil(ThreadRelationships.mergeBackTargetThreadID(nil))
    }

    // MARK: Presentation

    func testLabelsReadFromThePerspectiveOfTheOpenThread() {
        func label(_ kind: ThreadRelationshipKind, outgoing: Bool) -> String {
            ThreadRelationships.label(
                ThreadRelationshipEdge(
                    sourceThreadID: outgoing ? "me" : "them",
                    targetThreadID: outgoing ? "them" : "me",
                    kind: kind,
                    status: nil
                ),
                currentThreadID: "me"
            )
        }
        XCTAssertEqual(label(.transfer, outgoing: true), "Context sent to")
        XCTAssertEqual(label(.transfer, outgoing: false), "Context received from")
        XCTAssertEqual(label(.subagent, outgoing: true), "Subagent")
        XCTAssertEqual(label(.subagent, outgoing: false), "Parent agent")
        XCTAssertEqual(label(.fork, outgoing: true), "Fork")
        XCTAssertEqual(label(.fork, outgoing: false), "Forked from")
    }

    func testTransferEdgesGetTheirOwnSymbol() {
        let transfer = ThreadRelationshipEdge(
            sourceThreadID: "a", targetThreadID: "b", kind: .transfer, status: nil
        )
        let fork = ThreadRelationshipEdge(
            sourceThreadID: "a", targetThreadID: "b", kind: .fork, status: nil
        )
        XCTAssertEqual(ThreadRelationships.symbol(transfer), "arrow.left.arrow.right")
        XCTAssertEqual(ThreadRelationships.symbol(fork), "arrow.triangle.branch")
    }

    func testOnlyRunningSubagentsGetALiveOrb() {
        XCTAssertEqual(ThreadRelationships.subagentOrbState("failed"), .failed)
        XCTAssertEqual(ThreadRelationships.subagentOrbState("running"), .active)
        XCTAssertEqual(ThreadRelationships.subagentOrbState("completed"), .done)
        // Parked, not working: pending and waiting must not animate.
        XCTAssertEqual(ThreadRelationships.subagentOrbState("pending"), .done)
        XCTAssertEqual(ThreadRelationships.subagentOrbState("waiting"), .done)
        XCTAssertEqual(ThreadRelationships.subagentOrbState(nil), .done)
    }

    func testAvailabilityPrefersTheMostFinalReason() {
        XCTAssertEqual(
            ThreadRelationships.availability(thread: nil, missing: true), "Unavailable"
        )
        XCTAssertEqual(
            ThreadRelationships.availability(
                thread: shell("a", archivedAt: "t", deletedAt: "t"), missing: false
            ),
            "Deleted"
        )
        XCTAssertEqual(
            ThreadRelationships.availability(
                thread: shell("a", archivedAt: "t"), missing: false
            ),
            "Archived"
        )
        XCTAssertNil(ThreadRelationships.availability(thread: shell("a"), missing: false))
    }

    // MARK: Subagent links

    func testSubagentLinkRecoversTheChildThreadFromATurnItem() {
        let item = V2Fixture.turnItem(
            id: "item-subagent",
            type: "subagent",
            status: "running",
            extra: [
                "subagentId": .string("subagent-1"),
                "origin": .string("app_owned"),
                "driver": .string("claude"),
                "providerInstanceId": .string("claude"),
                "childThreadId": .string("thread-child"),
                "prompt": .string("go"),
            ]
        )
        let link = ThreadRelationshipSubagentLink(turnItem: item)
        XCTAssertEqual(link?.childThreadID, "thread-child")
        XCTAssertEqual(link?.status, "running")
        // Child thread first: the relationship surfaces only know thread ids,
        // so this is what keeps one agent the same colour everywhere.
        XCTAssertEqual(link?.orbSeed, "thread-child")

        let orphan = ThreadRelationshipSubagentLink(
            id: "subagent-2", childThreadID: nil, status: "pending"
        )
        XCTAssertEqual(orphan.orbSeed, "subagent-2")
        XCTAssertNil(
            ThreadRelationshipSubagentLink(
                turnItem: V2Fixture.assistantMessage(id: "item-1", text: "hi")
            )
        )
    }

    // MARK: Decay

    private func subagentRow(_ threadID: String, status: String) -> ThreadRelationshipRow {
        ThreadRelationshipRow(
            threadID: threadID,
            fromThreadID: "thread-parent",
            depth: 1,
            edge: ThreadRelationshipEdge(
                sourceThreadID: "thread-parent",
                targetThreadID: threadID,
                kind: .subagent,
                status: status
            )
        )
    }

    func testSubagentsAlreadyFinishedOnFirstObservationCollapseImmediately() {
        var decay = ThreadRelationshipDecay()
        let split = decay.split(
            rows: [subagentRow("thread-done", status: "completed")], now: Date()
        )
        XCTAssertTrue(split.visible.isEmpty)
        XCTAssertEqual(split.archived.map(\.threadID), ["thread-done"])
        XCTAssertNil(split.nextRefresh)
    }

    func testASubagentThatFinishesWhileWatchingLingersForTheDecayWindow() {
        var decay = ThreadRelationshipDecay()
        let start = Date()
        _ = decay.split(rows: [subagentRow("thread-a", status: "running")], now: start)

        let justFinished = decay.split(
            rows: [subagentRow("thread-a", status: "completed")], now: start
        )
        XCTAssertEqual(justFinished.visible.map(\.threadID), ["thread-a"])
        XCTAssertEqual(
            justFinished.nextRefresh?.timeIntervalSince(start) ?? 0,
            ThreadRelationshipDecay.window,
            accuracy: 0.001
        )

        let stillWarm = decay.split(
            rows: [subagentRow("thread-a", status: "completed")],
            now: start.addingTimeInterval(ThreadRelationshipDecay.window - 1)
        )
        XCTAssertEqual(stillWarm.visible.map(\.threadID), ["thread-a"])

        let collapsed = decay.split(
            rows: [subagentRow("thread-a", status: "completed")],
            now: start.addingTimeInterval(ThreadRelationshipDecay.window + 1)
        )
        XCTAssertEqual(collapsed.archived.map(\.threadID), ["thread-a"])
        XCTAssertNil(collapsed.nextRefresh)
    }

    func testFailedSubagentsNeverAutoCollapse() {
        var decay = ThreadRelationshipDecay()
        let start = Date()
        _ = decay.split(rows: [subagentRow("thread-a", status: "running")], now: start)
        let split = decay.split(
            rows: [subagentRow("thread-a", status: "failed")],
            now: start.addingTimeInterval(ThreadRelationshipDecay.window * 10)
        )
        XCTAssertEqual(split.visible.map(\.threadID), ["thread-a"])
        XCTAssertTrue(split.archived.isEmpty)
    }

    func testARestartedSubagentReturnsToTheVisibleGroup() {
        var decay = ThreadRelationshipDecay()
        let start = Date()
        _ = decay.split(rows: [subagentRow("thread-a", status: "completed")], now: start)
        let resumed = decay.split(
            rows: [subagentRow("thread-a", status: "running")], now: start
        )
        XCTAssertEqual(resumed.visible.map(\.threadID), ["thread-a"])
        XCTAssertTrue(resumed.archived.isEmpty)
    }

    func testForksAndTransfersNeverDecay() {
        var decay = ThreadRelationshipDecay()
        let fork = ThreadRelationshipRow(
            threadID: "thread-fork",
            fromThreadID: "thread-parent",
            depth: 1,
            edge: ThreadRelationshipEdge(
                sourceThreadID: "thread-parent",
                targetThreadID: "thread-fork",
                kind: .fork,
                status: "completed"
            )
        )
        let split = decay.split(rows: [fork], now: Date())
        XCTAssertEqual(split.visible.map(\.threadID), ["thread-fork"])
        XCTAssertTrue(split.archived.isEmpty)
    }

    // MARK: Banner model

    func testMergeTargetSortsFirstAndKeepsGraphOrderBehindIt() {
        let currentThread = shell(
            "thread-fork", parent: "thread-source", relationship: "fork",
            forkedFromRun: "thread-source"
        )
        let model = ThreadRelationships.build(
            currentThreadID: "thread-fork",
            currentThread: currentThread,
            threads: [
                shell("thread-child-a", parent: "thread-fork", relationship: "subagent"),
                shell("thread-child-b", parent: "thread-fork", relationship: "subagent"),
                currentThread,
                shell("thread-source"),
            ],
            runs: [ThreadWorkflowRun(id: "run-1", ordinal: 1, status: "completed")]
        )

        XCTAssertEqual(
            model.rows.map(\.threadID),
            ["thread-source", "thread-child-a", "thread-child-b"]
        )
        XCTAssertEqual(model.mergeTargetThreadID, "thread-source")
        XCTAssertEqual(model.latestMergeBackRunID, "run-1")
        XCTAssertTrue(model.canMerge)
    }

    func testSummaryPrefersAnIncomingEdgeSoTheBannerNamesTheParent() {
        let currentThread = shell(
            "thread-child", parent: "thread-parent", relationship: "subagent"
        )
        let model = ThreadRelationships.build(
            currentThreadID: "thread-child",
            currentThread: currentThread,
            threads: [
                shell("thread-grandchild", parent: "thread-child", relationship: "subagent"),
                currentThread,
                shell("thread-parent", title: "Parent thread"),
            ]
        )
        XCTAssertEqual(model.primaryRow?.threadID, "thread-parent")
        XCTAssertEqual(model.summary, "Parent agent: Parent thread")
    }

    func testSummaryFallsBackWhenTheRelatedThreadIsNotSyncedYet() {
        let currentThread = shell(
            "thread-child", parent: "thread-missing", relationship: "fork"
        )
        let model = ThreadRelationships.build(
            currentThreadID: "thread-child",
            currentThread: currentThread,
            threads: [currentThread]
        )
        XCTAssertEqual(model.summary, "Forked from: related thread")
        XCTAssertEqual(model.availability(for: "thread-missing"), "Unavailable")
        XCTAssertEqual(model.title(for: "thread-missing"), "thread-missing")
    }

    func testABareThreadWithNoSessionRendersNothing() {
        let currentThread = shell("thread-solo")
        let model = ThreadRelationships.build(
            currentThreadID: "thread-solo",
            currentThread: currentThread,
            threads: [currentThread]
        )
        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(model.summary, "Agent session connected")
        XCTAssertFalse(model.canMerge)
        XCTAssertFalse(model.canDetach)
    }

    func testALiveSessionKeepsTheBannerAroundForTheDisconnectAction() {
        let currentThread = shell("thread-solo")
        let model = ThreadRelationships.build(
            currentThreadID: "thread-solo",
            currentThread: currentThread,
            threads: [currentThread],
            providerSession: ThreadWorkflowSession(id: "session-1", status: "running")
        )
        XCTAssertFalse(model.isEmpty)
        XCTAssertTrue(model.canDetach)
    }

    func testWorkflowAnnotationsAreIndexedByChildThreadRatherThanSubagentID() {
        let currentThread = shell("thread-parent")
        let subagent = ThreadRelationshipSubagentLink(
            id: "subagent-1",
            childThreadID: "thread-child",
            status: "running",
            workflow: AgentWorkflowProgress(
                phases: [AgentWorkflowPhase(index: 0, title: "Scan")],
                currentPhase: "Scan"
            ),
            usage: AgentTaskUsage(totalTokens: 1234)
        )
        let model = ThreadRelationships.build(
            currentThreadID: "thread-parent",
            currentThread: currentThread,
            threads: [currentThread],
            subagents: [subagent]
        )
        XCTAssertEqual(model.rows.map(\.threadID), ["thread-child"])
        XCTAssertEqual(model.subagent(for: "thread-child")?.usage?.totalTokens, 1234)
        XCTAssertNil(model.subagent(for: "subagent-1"))
    }

    func testMergeIsBlockedWhileANewerRunIsStillWorking() {
        let currentThread = shell(
            "thread-fork", parent: "thread-source", relationship: "fork"
        )
        let model = ThreadRelationships.build(
            currentThreadID: "thread-fork",
            currentThread: currentThread,
            threads: [currentThread, shell("thread-source")],
            runs: [
                ThreadWorkflowRun(id: "older", ordinal: 1, status: "completed"),
                ThreadWorkflowRun(id: "newer", ordinal: 2, status: "running"),
            ]
        )
        XCTAssertEqual(model.mergeTargetThreadID, "thread-source")
        XCTAssertNil(model.latestMergeBackRunID)
        XCTAssertFalse(model.canMerge)
    }

    func testShellAdapterReadsLineageAndForkSourceFromTheWireType() {
        let wire = V2Fixture.threadShell(id: "thread-child", title: "Child", status: "running")
        let adapted = ThreadRelationshipShell(wire)
        XCTAssertEqual(adapted.id, "thread-child")
        XCTAssertEqual(adapted.title, "Child")
        XCTAssertEqual(adapted.status, "running")
        XCTAssertNil(adapted.parentThreadID)
        XCTAssertNil(adapted.forkedFromRunThreadID)

        let projectionThread = ThreadRelationshipShell(
            V2Fixture.appThread(id: "thread-open", title: "Open"), status: "waiting"
        )
        XCTAssertEqual(projectionThread.status, "waiting")
        XCTAssertEqual(projectionThread.title, "Open")
    }

    /// The projection's subagent row is the authoritative link: it carries the
    /// child thread that makes a row openable, the driver's own title, and the
    /// observability annotations no transcript item reports.
    func testSubagentAdapterReadsTheProjectionRow() {
        let subagent = Self.decode(
            OrchestrationV2Subagent.self,
            """
            {
              "id": "sub-1",
              "threadId": "thread-parent",
              "childThreadId": "thread-child",
              "title": "Audit the router",
              "origin": "delegated_task",
              "status": "running",
              "progress": null,
              "result": null,
              "workflow": {
                "name": "review",
                "phases": [{ "index": 0, "title": "scan" }, { "index": 1, "title": "report" }],
                "currentPhase": "report",
                "spawnedCount": 2
              },
              "usage": { "totalTokens": 1200, "toolUses": 7 }
            }
            """
        )

        let link = ThreadRelationshipSubagentLink(subagent)
        XCTAssertEqual(link.id, "sub-1")
        XCTAssertEqual(link.childThreadID, "thread-child")
        XCTAssertEqual(link.title, "Audit the router")
        XCTAssertEqual(link.status, "running")
        // The child thread doubles as the orb seed, which is what keeps one
        // agent the same colour on the timeline and in the banner.
        XCTAssertEqual(link.orbSeed, "thread-child")
        XCTAssertEqual(link.workflow?.name, "review")
        XCTAssertEqual(link.workflow?.phases.map(\.title), ["scan", "report"])
        XCTAssertEqual(
            WorkflowObservability.phaseProgress(link.workflow),
            WorkflowPhaseProgress(current: 2, total: 2)
        )
        XCTAssertEqual(link.usage?.totalTokens, 1200)
        XCTAssertEqual(link.usage?.toolUses, 7)
    }

    /// A driver that runs subagents without addressable threads still produces
    /// a row; it just cannot be opened.
    func testSubagentAdapterKeepsAnUnaddressableAgentButSeedsItFromItsOwnID() {
        let subagent = Self.decode(
            OrchestrationV2Subagent.self,
            """
            {
              "id": "sub-2", "threadId": "thread-parent", "childThreadId": null,
              "title": null, "origin": "provider_native", "status": "completed",
              "progress": null, "result": null, "workflow": null, "usage": null
            }
            """
        )

        let link = ThreadRelationshipSubagentLink(subagent)
        XCTAssertNil(link.childThreadID)
        XCTAssertEqual(link.orbSeed, "sub-2")
        XCTAssertNil(link.workflow)
    }

    /// Both ends of a transfer are non-null on the wire, so a transfer always
    /// draws a complete edge rather than a dangling one.
    func testTransferAdapterDrawsBothEndsOfTheEdge() {
        let transfer = Self.decode(
            OrchestrationV2ContextTransfer.self,
            """
            {
              "id": "transfer-1", "type": "handoff",
              "sourceThreadId": "thread-a", "targetThreadId": "thread-b",
              "status": "completed", "resolution": null
            }
            """
        )

        let link = ThreadRelationshipTransferLink(transfer)
        let graph = ThreadRelationships.deriveGraph(
            threads: [],
            ownerThreadID: "thread-a",
            transfers: [link]
        )
        XCTAssertEqual(graph.edges.count, 1)
        XCTAssertEqual(graph.edges[0].kind, .transfer)
        XCTAssertEqual(graph.edges[0].sourceThreadID, "thread-a")
        XCTAssertEqual(graph.edges[0].targetThreadID, "thread-b")
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
        try! JSONDecoder.t3.decode(type, from: Data(json.utf8))
    }
    // MARK: Active-agent summary

    private func summary(_ statuses: [String]) -> ThreadSubagentSummary {
        let children = statuses.enumerated().map { index, status in
            shell("child-\(index)", status: status)
        }
        let model = ThreadRelationships.build(
            currentThreadID: "thread-root",
            currentThread: shell("thread-root", status: "running"),
            threads: [shell("thread-root", status: "running")] + children,
            subagents: statuses.enumerated().map { index, status in
                ThreadRelationshipSubagentLink(
                    id: "subagent-\(index)", childThreadID: "child-\(index)", status: status
                )
            }
        )
        return model.subagentSummary
    }

    func testSubagentSummaryLeadsWithWorkAndKeepsFailuresVisible() {
        let mixed = summary(["running", "failed", "completed", "completed"])
        XCTAssertEqual(mixed.workingCount, 1)
        XCTAssertEqual(mixed.failedCount, 1)
        XCTAssertEqual(mixed.primaryLabel, "1 working")
        // Both states present, so the failure count rides alongside rather than
        // replacing the headline.
        XCTAssertEqual(mixed.secondaryFailedLabel, "1 failed")
        // The two completed agents are not counted, not shown, and not spoken.
        XCTAssertEqual(mixed.orbRows.count, 2)
        XCTAssertFalse(mixed.isEmpty)
    }

    func testSubagentSummaryHidesItselfOnceEveryAgentIsDone() {
        let settled = summary(["completed", "completed", "completed", "completed"])
        XCTAssertTrue(settled.isEmpty, "a finished run has nothing to report")
        XCTAssertTrue(settled.orbRows.isEmpty)
        XCTAssertEqual(settled.workingCount, 0)

        // A failure still holds the banner open: it is the one finished state
        // the reader has to do something about.
        let failed = summary(["completed", "failed"])
        XCTAssertFalse(failed.isEmpty)
        XCTAssertEqual(failed.primaryLabel, "1 failed")
        XCTAssertNil(failed.secondaryFailedLabel)
    }

    func testSubagentSummaryCountsParkedAgentsAsWorking() {
        // Looser than `subagentOrbState`, which will not animate a parked
        // agent: the count answers whether anyone is still outstanding.
        let parked = summary(["pending", "waiting"])
        XCTAssertEqual(parked.workingCount, 2)
        XCTAssertEqual(parked.primaryLabel, "2 working")
        XCTAssertEqual(
            ThreadRelationships.subagentOrbState("pending"),
            .done,
            "orb state and the working count deliberately disagree here"
        )
    }

    func testSubagentSummaryCollapsesDuplicateFailureCounts() {
        let failedOnly = summary(["failed", "error"])
        XCTAssertEqual(failedOnly.failedCount, 2)
        XCTAssertEqual(failedOnly.primaryLabel, "2 failed")
        XCTAssertNil(failedOnly.secondaryFailedLabel)
    }

    func testSubagentSummaryOrdersOrbsByUrgencyAndCapsTheStack() {
        let many = summary([
            "completed", "running", "failed", "running", "running", "failed", "running",
        ])
        XCTAssertEqual(many.orbRows.count, 4, "the stack caps at four")
        // Working first, then failed -- regardless of graph order.
        XCTAssertEqual(
            many.orbRows.map(\.threadID), ["child-1", "child-3", "child-4", "child-6"]
        )
    }

    func testSubagentSummaryExcludesIncomingLineageButCountsOutgoing() {
        // This thread is itself a subagent of thread-parent, and runs one of
        // its own. Only the outgoing edge is an agent it is waiting on.
        let currentThread = shell(
            "thread-child", parent: "thread-parent", relationship: "subagent"
        )
        let model = ThreadRelationships.build(
            currentThreadID: "thread-child",
            currentThread: currentThread,
            threads: [
                currentThread,
                shell("thread-parent", title: "Parent thread"),
                shell(
                    "thread-grandchild",
                    status: "running",
                    parent: "thread-child",
                    relationship: "subagent"
                ),
            ]
        )
        XCTAssertEqual(model.primaryRow?.threadID, "thread-parent")
        let summary = model.subagentSummary
        XCTAssertEqual(summary.workingCount, 1)
        XCTAssertEqual(summary.orbRows.map(\.threadID), ["thread-grandchild"])
    }

    func testSubagentSummaryIsEmptyForALeafSubagent() {
        let currentThread = shell(
            "thread-child", parent: "thread-parent", relationship: "subagent"
        )
        let model = ThreadRelationships.build(
            currentThreadID: "thread-child",
            currentThread: currentThread,
            threads: [currentThread, shell("thread-parent", title: "Parent thread")]
        )
        // There is a relationship to show, so the banner still appears -- it
        // just falls back to the lineage row rather than an agent count.
        XCTAssertFalse(model.rows.isEmpty)
        XCTAssertTrue(model.subagentSummary.isEmpty)
    }

}
