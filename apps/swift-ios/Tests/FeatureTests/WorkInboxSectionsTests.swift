import XCTest

@testable import T3Code

/// Ports the work-section half of
/// apps/mobile/src/features/threads/threadListV2.test.ts
/// (`withWorkSectionHeaders` via `buildThreadListV2ListItems`).
final class WorkInboxSectionsTests: XCTestCase {
    private func thread(
        id: String,
        state: FeatureThreadState = .idle
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: "project-1",
            environmentID: "environment:local",
            title: id,
            state: state,
            providerID: "hermes",
            modelID: "default"
        )
    }

    func testInboxOrderPutsMainFirstAndBlockedWorkAheadOfOrdinaryWork() {
        XCTAssertEqual(
            WorkInboxSections.ordered.map(\.section),
            [.main, .needsYou, .active]
        )
        XCTAssertEqual(
            WorkInboxSections.ordered.map(\.label),
            ["Main", "Needs You", "Active"]
        )
    }

    func testOnlyBlockedWorkDrawsInTheAttentionTone() {
        // Three loud labels would mark nothing, so exactly one earns colour.
        XCTAssertEqual(
            WorkInboxSections.ordered.filter { $0.tone == .attention }.map(\.section),
            [.needsYou]
        )
    }

    func testSectionKeysMatchTheReactNativeListSoLayoutsCorrespond() {
        XCTAssertEqual(
            WorkInboxSections.ordered.map(\.id),
            [
                "v2-work-section:main",
                "v2-work-section:needs-you",
                "v2-work-section:active",
            ]
        )
    }

    func testGroupsTheActiveBlockAndKeepsEachSectionsIncomingOrder() {
        let rows = [
            thread(id: "active-first"),
            thread(id: "approval", state: .waitingForApproval),
            thread(id: "main"),
            thread(id: "input", state: .waitingForInput),
            thread(id: "active-second"),
        ]

        let groups = WorkInboxSections.groups(
            active: rows,
            workInboxRole: { thread in thread.id == "main" ? "main" : nil }
        )

        XCTAssertEqual(groups.map(\.header.section), [.main, .needsYou, .active])
        XCTAssertEqual(groups.map { $0.rows.map(\.id) }, [
            ["main"],
            ["approval", "input"],
            ["active-first", "active-second"],
        ])
    }

    func testSectionsWithNoRowsAreOmittedEntirelySoAnEmptyInboxStaysQuiet() {
        let groups = WorkInboxSections.groups(active: [thread(id: "only-active")])

        XCTAssertEqual(groups.map(\.header.section), [.active])
    }

    func testAnEmptyActiveBlockProducesNoHeadersAtAll() {
        XCTAssertTrue(WorkInboxSections.groups(active: [FeatureThread]()).isEmpty)
    }

    func testMainOutranksBlockedWorkSoThePinnedThreadNeverLeavesTheTop() {
        // The always-pinned Work thread is the inbox's anchor; letting an
        // approval move it would make the list's first row unpredictable.
        XCTAssertEqual(
            WorkInboxSections.section(
                of: thread(id: "main", state: .waitingForApproval),
                workInboxRole: "main"
            ),
            .main
        )
        XCTAssertEqual(
            WorkInboxSections.section(of: thread(id: "blocked", state: .waitingForInput)),
            .needsYou
        )
        XCTAssertEqual(
            WorkInboxSections.section(of: thread(id: "working", state: .working)),
            .active
        )
    }
}

/// The Working section beta (upstream 8d846660ce + 1302ccacbd): busy threads
/// fold out of the inbox until they need the user, and the section holds its
/// order while agents finish and wake.
final class WorkingSectionTests: XCTestCase {
    private let environmentID = "environment:local"
    private let origin = Date(timeIntervalSince1970: 1_000_000)

    private func at(_ minutes: Double) -> Date { origin.addingTimeInterval(minutes * 60) }

    private func thread(
        _ id: String,
        state: FeatureThreadState = .idle,
        providerID: String = "claude",
        created: Double = 0,
        authored: Double? = nil,
        userActivity: Double? = nil,
        turnCompleted: Double? = nil,
        background: Int? = nil,
        pinned: Bool = false,
        workInboxRole: String? = nil,
        planReady: Bool = false
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: "project-1",
            environmentID: environmentID,
            title: id,
            createdAt: at(created),
            state: state,
            providerID: providerID,
            modelID: "default",
            latestUserActivityAt: userActivity.map(at),
            latestUserAuthoredMessageAt: authored.map(at),
            hasActionableProposedPlan: planReady,
            pinnedAt: pinned ? at(0) : nil,
            workInboxRole: workInboxRole,
            latestTurnCompletedAt: turnCompleted.map(at),
            backgroundWorkCount: background,
            interactionMode: planReady ? .plan : .standard
        )
    }

    private func snapshot(_ threads: [FeatureThread]) -> FeatureSnapshot {
        FeatureSnapshot(
            environments: [
                FeatureEnvironment(id: environmentID, name: "Local", endpoint: "http://localhost", isActive: true),
            ],
            projects: [
                FeatureProject(id: "project-1", environmentID: environmentID, name: "Project", path: "/tmp/project"),
            ],
            threads: threads,
            providers: [
                FeatureProvider(id: "hermes", name: "Hermes", driver: "hermes"),
                FeatureProvider(id: "claude", name: "Claude", driver: "claude"),
            ]
        )
    }

    private func presentation(
        _ threads: [FeatureThread],
        workspace: MobileWorkspace = .code,
        enabled: Bool = true,
        query: String = ""
    ) -> HomePresentation {
        HomePresentation(
            snapshot: snapshot(threads),
            workspace: workspace,
            query: query,
            projectID: nil,
            now: at(60),
            workingSectionEnabled: enabled
        )
    }

    private func items(
        _ presentation: HomePresentation,
        expanded: Bool,
        selected: String? = nil
    ) -> [HomeCollectionItem.ID] {
        HomeThreadCollectionView(
            presentation: presentation,
            changeRequests: [:],
            workspace: .code,
            query: "",
            selectedThreadID: selected,
            forceRichRows: false,
            isWorkingExpanded: expanded,
            isSnoozedExpanded: false,
            isSettledExpanded: false,
            isArchiveExpanded: false,
            settledLimit: 12,
            confirmThreadUnpin: false,
            onOpen: { _ in },
            onToggleSnoozed: {},
            onToggleSettled: {},
            onToggleArchive: {},
            onShowMoreSettled: {},
            onRename: { _ in },
            onArchive: { _, _ in },
            onSettle: { _, _ in },
            onSnooze: { _, _ in },
            onPin: { _, _ in },
            onDelete: { _ in },
            onCopyHandoffScript: { _ in },
            onCopy: { _, _ in },
            onRegenerateTitle: { _ in }
        ).collectionItems.map(\.id)
    }

    func testOnlyBusyWorkThatDoesNotNeedTheUserFoldsAway() {
        let threads = [
            thread("running", state: .working),
            thread("queued", state: .queued),
            thread("background", background: 2),
            thread("approval", state: .waitingForApproval),
            thread("input", state: .waitingForInput),
            thread("failed", state: .failed),
            thread("done-unseen", state: .completed),
            thread("idle"),
            thread("plan-ready", background: 1, planReady: true),
            thread("pinned-running", state: .working, pinned: true),
        ]
        let result = presentation(threads)

        XCTAssertEqual(Set(result.working.map(\.id)), ["running", "queued", "background"])
        XCTAssertEqual(
            Set(result.active.map(\.id)),
            ["approval", "input", "failed", "done-unseen", "idle", "plan-ready"]
        )
        XCTAssertEqual(result.pinned.map(\.id), ["pinned-running"], "a pin keeps its place")
    }

    func testOffByDefaultNothingFoldsAway() {
        let result = presentation([thread("running", state: .working)], enabled: false)
        XCTAssertTrue(result.working.isEmpty)
        XCTAssertEqual(result.active.map(\.id), ["running"])
    }

    func testWorksMainThreadAndChatNeverFold() {
        let work = presentation(
            [
                thread("main", state: .working, providerID: "hermes", workInboxRole: "main"),
                thread("errand", state: .working, providerID: "hermes"),
            ],
            workspace: .work
        )
        XCTAssertEqual(work.working.map(\.id), ["errand"])
        XCTAssertEqual(work.active.map(\.id), ["main"])

        // Chat has no shelves: a busy conversation just stays in the list.
        let chat = presentation(
            [thread("conversation", state: .working, providerID: "hermes", workInboxRole: "chat")],
            workspace: .chat
        )
        XCTAssertTrue(chat.working.isEmpty)
        XCTAssertEqual(chat.active.map(\.id), ["conversation"])
    }

    /// Newest send first; a wake moves the thread's user activity but not
    /// what the user wrote, so the section does not reshuffle under them.
    func testWorkingOrdersByLastAuthoredSendAndIgnoresWakes() {
        let threads = [
            thread("older-send", state: .working, authored: 10, userActivity: 50),
            thread("newer-send", state: .working, authored: 20, userActivity: 20),
            thread("legacy-new", state: .working, created: 40),
            thread("legacy-old", state: .working, created: 5),
        ]
        XCTAssertEqual(
            presentation(threads).working.map(\.id),
            // Rows without the stamp follow, in the active list's own order.
            ["newer-send", "older-send", "legacy-new", "legacy-old"]
        )
    }

    /// A thread that leaves the Working section lands on top of the inbox.
    func testTheInboxOrdersByWhenEachThreadCameBack() {
        let threads = [
            thread("created-late", created: 30),
            thread("just-finished", state: .completed, created: 1, userActivity: 5, turnCompleted: 45),
            thread("needs-you", state: .waitingForInput, created: 2, userActivity: 35),
        ]
        XCTAssertEqual(
            presentation(threads).active.map(\.id),
            ["just-finished", "needs-you", "created-late"]
        )
        // Off, the saved static order applies: newest anchor first.
        XCTAssertEqual(
            presentation(threads, enabled: false).active.map(\.id),
            ["created-late", "needs-you", "just-finished"]
        )
    }

    func testTheShelfSitsUnderTheInboxAndKeepsTheOpenThreadWhenCollapsed() {
        let result = presentation([
            thread("inbox"),
            thread("busy-a", state: .working, authored: 2),
            thread("busy-b", state: .working, authored: 1),
        ])

        XCTAssertEqual(
            items(result, expanded: false),
            [.thread("inbox"), .shelfHeader(.working)]
        )
        XCTAssertEqual(
            items(result, expanded: false, selected: "busy-b"),
            [.thread("inbox"), .shelfHeader(.working), .thread("busy-b")]
        )
        XCTAssertEqual(
            items(result, expanded: true),
            [.thread("inbox"), .shelfHeader(.working), .thread("busy-a"), .thread("busy-b")]
        )
    }

    func testSearchStillFindsWorkingThreads() {
        let result = presentation([thread("busy-search-target", state: .working)], query: "search-target")
        XCTAssertEqual(result.searchTitleResults.map(\.id), ["busy-search-target"])
    }
}
