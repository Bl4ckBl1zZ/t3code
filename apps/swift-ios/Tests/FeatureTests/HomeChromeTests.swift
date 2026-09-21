import Foundation
import XCTest

@testable import T3Code

/// The Home shell's decisions: what the connection banner and subtitle say,
/// when placeholders stand in for the list, what an empty list offers, how row
/// dates and branches read, and which batch actions a selection allows.
final class HomeChromeTests: XCTestCase {
    private func environment(
        _ id: String,
        name: String,
        isActive: Bool = false,
        state: FeatureConnection.State?
    ) -> FeatureEnvironment {
        FeatureEnvironment(id: id, name: name, endpoint: "http://\(id)", isActive: isActive, connectionState: state)
    }

    private func thread(
        _ id: String,
        state: FeatureThreadState = .idle,
        isArchived: Bool = false,
        pinnedAt: Date? = nil,
        supportsSettlement: Bool? = true,
        supportsSnooze: Bool? = true,
        workInboxRole: String? = nil,
        archiveBlockedByLiveRun: Bool? = nil
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: "project",
            title: id,
            state: state,
            isArchived: isArchived,
            pinnedAt: pinnedAt,
            supportsSettlement: supportsSettlement,
            supportsSnooze: supportsSnooze,
            workInboxRole: workInboxRole,
            archiveBlockedByLiveRun: archiveBlockedByLiveRun
        )
    }

    // MARK: - Connection banner

    func testAConnectedEnvironmentHasNoBanner() {
        let snapshot = FeatureSnapshot(
            connection: FeatureConnection(state: .connected),
            environments: [environment("mac", name: "Mac", isActive: true, state: .connected)]
        )
        XCTAssertNil(HomeConnectionBanner.resolve(snapshot: snapshot, isReconnecting: false))
    }

    func testOneUnreachableEnvironmentOffersReconnect() {
        let snapshot = FeatureSnapshot(
            connection: FeatureConnection(state: .connected),
            environments: [
                environment("mac", name: "Mac", isActive: true, state: .connected),
                environment("studio", name: "Studio", state: .disconnected),
            ]
        )
        let banner = HomeConnectionBanner.resolve(snapshot: snapshot, isReconnecting: false)
        XCTAssertEqual(banner?.tone, .error)
        XCTAssertEqual(banner?.title, "Studio unreachable")
        XCTAssertEqual(banner?.offersReconnect, true)
        XCTAssertEqual(banner?.opensConnections, false)
    }

    /// A Reconnect in flight turns the error into a wait, so the button the
    /// user just pressed does not look ignored.
    func testReconnectInFlightReadsAsWaiting() {
        let snapshot = FeatureSnapshot(
            environments: [environment("studio", name: "Studio", state: .disconnected)]
        )
        let banner = HomeConnectionBanner.resolve(snapshot: snapshot, isReconnecting: true)
        XCTAssertEqual(banner?.tone, .warning)
        XCTAssertEqual(banner?.title, "Reconnecting to Studio…")
        XCTAssertEqual(banner?.offersReconnect, false)
    }

    func testSeveralUnreachableEnvironmentsOpenConnections() {
        let snapshot = FeatureSnapshot(
            environments: [
                environment("studio", name: "Studio", state: .disconnected),
                environment("pi", name: "Pi", state: .disconnected),
            ]
        )
        let banner = HomeConnectionBanner.resolve(snapshot: snapshot, isReconnecting: false)
        XCTAssertEqual(banner?.title, "2 environments unreachable")
        XCTAssertEqual(banner?.opensConnections, true)
        XCTAssertEqual(banner?.offersReconnect, false)
    }

    func testAReconnectingEnvironmentSaysChangesAreQueued() {
        let snapshot = FeatureSnapshot(
            connection: FeatureConnection(state: .connected),
            environments: [environment("mac", name: "Mac", isActive: true, state: .reconnecting)]
        )
        let banner = HomeConnectionBanner.resolve(snapshot: snapshot, isReconnecting: false)
        XCTAssertEqual(banner?.tone, .warning)
        XCTAssertEqual(banner?.title, "Reconnecting to Mac…")
        XCTAssertEqual(banner?.message, "Changes you make are queued.")
    }

    // MARK: - Subtitle

    func testCodeSubtitleCountsWorkingAndWaitingThreads() {
        let text = HomeListSubtitle.text(
            workspace: .code,
            projectName: nil,
            threads: [
                thread("a", state: .working),
                thread("b", state: .working),
                thread("c", state: .waitingForApproval),
                thread("d"),
            ],
            connection: FeatureConnection(state: .connected),
            environmentName: "Mac"
        )
        XCTAssertEqual(text, "All projects · 2 working · 1 needs you")
    }

    func testSubtitleNamesTheFilteredProjectAndPluralises() {
        let text = HomeListSubtitle.text(
            workspace: .code,
            projectName: "t3code",
            threads: [thread("a", state: .waitingForInput), thread("b", state: .waitingForApproval)],
            connection: FeatureConnection(state: .connected),
            environmentName: "Mac"
        )
        XCTAssertEqual(text, "t3code · 2 need you")
    }

    func testChatSubtitleIsEmptyWhenNothingIsHappening() {
        XCTAssertNil(HomeListSubtitle.text(
            workspace: .chat,
            projectName: nil,
            threads: [thread("a")],
            connection: FeatureConnection(state: .connected),
            environmentName: "Mac"
        ))
    }

    func testFirstConnectShowsInTheSubtitle() {
        XCTAssertEqual(
            HomeListSubtitle.text(
                workspace: .code,
                projectName: nil,
                threads: [],
                connection: FeatureConnection(state: .connecting),
                environmentName: "Mac"
            ),
            "Connecting to Mac…"
        )
    }

    // MARK: - Placeholders and empty states

    /// A cold connect used to claim "No active tasks" before anything arrived.
    func testPlaceholdersOnlyStandInForAnEmptySnapshotThatIsStillLoading() {
        let empty = FeatureSnapshot(connection: FeatureConnection(state: .connected))
        XCTAssertTrue(HomeLoadingState.showsPlaceholders(isLoading: true, snapshot: empty))
        XCTAssertFalse(HomeLoadingState.showsPlaceholders(isLoading: false, snapshot: empty))

        let connecting = FeatureSnapshot(connection: FeatureConnection(state: .connecting))
        XCTAssertTrue(HomeLoadingState.showsPlaceholders(isLoading: false, snapshot: connecting))

        let cached = FeatureSnapshot(connection: FeatureConnection(state: .connecting), threads: [thread("a")])
        XCTAssertFalse(HomeLoadingState.showsPlaceholders(isLoading: true, snapshot: cached))
    }

    func testEmptyStatesOfferTheOneNextStep() {
        XCTAssertEqual(
            HomeEmptyState.resolve(workspace: .code, hasCreationProjects: false, filteredProjectName: nil, hermesReady: true).action,
            .addProject
        )
        let filtered = HomeEmptyState.resolve(workspace: .code, hasCreationProjects: true, filteredProjectName: "t3code", hermesReady: true)
        XCTAssertEqual(filtered.title, "No Tasks in t3code")
        XCTAssertEqual(filtered.action, .showAllProjects)
        XCTAssertEqual(
            HomeEmptyState.resolve(workspace: .code, hasCreationProjects: true, filteredProjectName: nil, hermesReady: true).action,
            .newItem
        )
        XCTAssertEqual(
            HomeEmptyState.resolve(workspace: .work, hasCreationProjects: true, filteredProjectName: nil, hermesReady: false).action,
            .setUpHermes
        )
        let chat = HomeEmptyState.resolve(workspace: .chat, hasCreationProjects: true, filteredProjectName: nil, hermesReady: true)
        XCTAssertEqual(chat.title, "No Conversations")
        XCTAssertEqual(chat.actionTitle, "New Conversation")
    }

    // MARK: - Row text

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US")
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func date(_ day: Int, _ hour: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 9, day: day, hour: hour))!
    }

    func testWakeDatesReadAsTimeWeekdayOrDate() {
        let now = date(21, 9) // Monday
        XCTAssertEqual(HomeRowDate.wake(date(21, 18), now: now, calendar: calendar), date(21, 18).formatted(
            Date.FormatStyle(locale: calendar.locale!, calendar: calendar, timeZone: calendar.timeZone).hour().minute()
        ))
        XCTAssertTrue(HomeRowDate.wake(date(23, 9), now: now, calendar: calendar).hasPrefix("Wed"))
        XCTAssertEqual(HomeRowDate.wake(date(30, 9), now: now, calendar: calendar), "Sep 30")
    }

    func testConversationDatesFollowMessages() {
        let now = date(21, 9)
        XCTAssertEqual(HomeRowDate.conversation(date(20, 9), now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(HomeRowDate.conversation(date(17, 9), now: now, calendar: calendar), "Thursday")
        XCTAssertEqual(HomeRowDate.conversation(date(1, 9), now: now, calendar: calendar), "Sep 1")
    }

    func testGeneratedWorktreeBranchesReadAsWorktree() {
        XCTAssertEqual(HomeBranchLabel.display(branch: "t3code/ffeef775", worktreePath: nil), "Worktree")
        XCTAssertEqual(HomeBranchLabel.display(branch: "feature/tabs", worktreePath: nil), "feature/tabs")
        XCTAssertEqual(HomeBranchLabel.display(branch: "fix/DEADBEEF", worktreePath: nil), "fix/DEADBEEF")
        XCTAssertEqual(HomeBranchLabel.display(branch: nil, worktreePath: "/tmp/worktrees/1a2b3c4d"), "Worktree")
        XCTAssertEqual(HomeBranchLabel.display(branch: nil, worktreePath: "/tmp/worktrees/tabs"), "tabs")
    }

    // MARK: - Batch actions

    func testBatchActionsApplyWhenAnySelectedThreadAllowsThem() {
        let availability = HomeBatchAvailability.resolve(
            [
                thread("asking", state: .waitingForApproval),
                thread("pinned", pinnedAt: .now),
            ],
            workspace: .code,
            now: .now,
            changeRequests: [:]
        )
        XCTAssertTrue(availability.canSnooze, "The pinned idle thread can snooze")
        XCTAssertTrue(availability.canSettle)
        XCTAssertTrue(availability.canArchive)
        XCTAssertTrue(availability.canPin)
        XCTAssertTrue(availability.canUnpin)
    }

    func testRunningAndAskingThreadsLimitTheSelection() {
        let availability = HomeBatchAvailability.resolve(
            [thread("asking", state: .waitingForInput, pinnedAt: .now, archiveBlockedByLiveRun: true)],
            workspace: .code,
            now: .now,
            changeRequests: [:]
        )
        XCTAssertFalse(availability.canSnooze, "A thread asking for something never hides")
        XCTAssertFalse(availability.canArchive, "A live run must not be detached")
        XCTAssertFalse(availability.canPin)
        XCTAssertTrue(availability.canUnpin)
    }

    func testChatHasNoParkingShelves() {
        let availability = HomeBatchAvailability.resolve(
            [thread("chat", workInboxRole: "chat")],
            workspace: .chat,
            now: .now,
            changeRequests: [:]
        )
        XCTAssertFalse(availability.canSnooze)
        XCTAssertFalse(availability.canSettle)
        XCTAssertTrue(availability.canArchive)
    }

    func testWorkMainThreadNeverParks() {
        let main = thread("main", workInboxRole: "main")
        XCTAssertFalse(HomeBatchAvailability.canSnooze(main, in: .work))
        XCTAssertFalse(HomeBatchAvailability.canSettle(main, in: .work, now: .now, changeRequest: nil))
    }

    // MARK: - Row accessibility

    func testWorkRowsReadTheirStatusAndPreviewInsteadOfConstants() {
        var row = thread("Deploy", state: .waitingForApproval)
        row.preview = "Run the migration?"
        let value = FeatureThreadRow.accessibilityValue(
            thread: row,
            context: .fallback,
            style: .inbox,
            now: .now
        )
        XCTAssertTrue(value.hasPrefix("Approval. Run the migration?"), value)
        XCTAssertFalse(value.contains("Project"))
        XCTAssertEqual(FeatureThreadRow.accessibilityHint(for: .inbox), "Opens conversation")
        XCTAssertEqual(FeatureThreadRow.accessibilityHint(for: .rich), "Opens task")
    }

    func testCodeRowsReadProjectAndBranch() {
        var row = thread("Fix tabs")
        row.branch = "feature/tabs"
        let value = FeatureThreadRow.accessibilityValue(
            thread: row,
            context: .fallback,
            style: .rich,
            now: .now
        )
        XCTAssertTrue(value.hasPrefix("Ready. Project Project. Branch feature/tabs"), value)
    }

    func testStaleRowsSayTheirStateIsLastKnown() {
        let context = HomeThreadRowContext(
            projectName: "Project",
            projectEnvironmentID: nil,
            projectWorkspaceRoot: nil,
            projectFaviconPath: nil,
            environmentLabel: "Studio",
            providerID: "claude",
            providerDriver: "claude",
            providerName: "Claude",
            connectionState: .disconnected
        )
        let value = FeatureThreadRow.accessibilityValue(
            thread: thread("Old"),
            context: context,
            style: .conversation,
            now: .now
        )
        XCTAssertTrue(value.hasSuffix("Studio unreachable, last known state"), value)
    }
}
