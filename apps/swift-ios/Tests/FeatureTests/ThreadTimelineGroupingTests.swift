import XCTest

@testable import T3Code

/// Ports the grouping and day-bucketing halves of
/// apps/mobile/src/lib/threadActivity.ts and the day label from
/// packages/shared/src/orchestrationV2Timeline.ts. Both clients read the same
/// projection, so they have to divide the transcript identically.
final class ThreadTimelineGroupingTests: XCTestCase {
    private func projected(
        _ item: OrchestrationV2TurnItem,
        sourceThreadID: String = "thread-v2"
    ) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: 0,
            visibility: .local,
            sourceThreadId: sourceThreadID,
            sourceItemId: item.id,
            item: item
        )
    }

    private func subagent(_ id: String) -> OrchestrationV2ProjectedTurnItem {
        projected(
            V2Fixture.turnItem(
                id: id,
                type: "subagent",
                extra: [
                    "subagentId": .string(id),
                    "origin": .string("delegated_task"),
                    "driver": .string("claude"),
                    "providerInstanceId": .string("claude"),
                    "prompt": .string("do the thing"),
                ]
            )
        )
    }

    private func assistantMessage(_ id: String) -> OrchestrationV2ProjectedTurnItem {
        projected(V2Fixture.assistantMessage(id: id, text: "hello", streaming: false))
    }

    private func userMessage(
        _ id: String,
        createdBy: String
    ) -> OrchestrationV2ProjectedTurnItem {
        projected(
            V2Fixture.turnItem(
                id: id,
                type: "user_message",
                extra: [
                    "messageId": .string("message-\(id)"),
                    "inputIntent": .string("turn_start"),
                    "text": .string("wake"),
                    "createdBy": .string(createdBy),
                    "creationSource": .string("mobile"),
                ]
            )
        )
    }

    // MARK: - Pending provider switch

    /// A cross-provider switch is recorded server-side as a context handoff but
    /// never echoed as a `handoff` turn item, so the client synthesizes one to
    /// explain the wait. It has to render through the same lifecycle path as a
    /// server-sent handoff, spinner and endpoint labels included.
    func testSynthesizedHandoffRendersAsAPreparingLifecycleDivider() {
        let base = OrchestrationV2TurnItemBase(
            id: "__t3-pending-handoff__",
            threadId: "thread-v2",
            ordinal: Int.max,
            status: .running,
            updatedAt: "2026-08-08T12:00:00.000Z"
        )
        let item = OrchestrationV2TurnItem(
            type: "handoff",
            base: base,
            payload: .handoff(
                contextHandoffID: base.id,
                fromProviderInstanceIDs: ["anthropic"],
                fromModelSelections: [ModelSelection(instanceId: "anthropic", model: "opus")],
                toProviderThreadID: "",
                toProviderInstanceID: "openai",
                toModel: "gpt-5",
                strategy: "full_thread_summary",
                summary: nil
            )
        )

        XCTAssertTrue(
            ThreadLifecycle.isLifecycleTimelineItem(item),
            "must fold into the lifecycle path, not the work log"
        )

        guard case let .divider(divider) = ThreadLifecycle.resolvePresentation(item) else {
            return XCTFail("expected a divider")
        }
        XCTAssertEqual(divider.label, "Preparing context handoff")
        XCTAssertTrue(divider.busy, "the wait is the whole point of the row")
        // `endpointLabel` prefers the model over the instance id.
        XCTAssertEqual(divider.detail, "opus → gpt-5")
    }

    // MARK: - Optimistic send reconciliation

    /// The client keeps a just-sent bubble on screen by appending an optimistic
    /// `FeatureMessage` keyed on the message id it generated, while the server
    /// echoes a turn item keyed on the id *it* assigned. Deduping on the item id
    /// alone printed the bubble twice the moment the echo arrived, and the
    /// duplicate survived until a reload dropped the optimistic copy.
    func testEchoedUserMessageReplacesItsOptimisticRowRatherThanDoublingIt() {
        let projectedItem = userMessage("item-1", createdBy: "user")
        let serverBacked = FeatureMessage(id: "item-1", role: .user, text: "Do it again")
        let optimistic = FeatureMessage(id: "message-item-1", role: .user, text: "Do it again")

        let entries = ThreadTimelineFeed.entries(
            timelineItems: [projectedItem],
            messages: [serverBacked, optimistic]
        )

        let bubbles = entries.compactMap { entry -> FeatureMessage? in
            guard case let .message(message) = entry else { return nil }
            return message
        }
        XCTAssertEqual(bubbles.map(\.id), ["item-1"], "the optimistic twin must not survive its echo")
    }

    /// The other half of the contract: before the echo lands there is no
    /// projected item, and dropping the optimistic row would blank the bubble
    /// the user just sent.
    func testOptimisticRowStillRendersBeforeItsEchoArrives() {
        let optimistic = FeatureMessage(id: "message-pending", role: .user, text: "Do it again")

        let entries = ThreadTimelineFeed.entries(timelineItems: [], messages: [optimistic])

        let bubbles = entries.compactMap { entry -> FeatureMessage? in
            guard case let .message(message) = entry else { return nil }
            return message
        }
        XCTAssertEqual(bubbles.map(\.id), ["message-pending"])
    }

    // MARK: - Related-thread card runs

    func testAdjacentRelatedThreadCardsCollapseIntoOneGroup() {
        let groups = ThreadTimelineGrouping.mergeRelatedThreadCardRuns([
            assistantMessage("assistant-1"),
            subagent("sub-1"),
            subagent("sub-2"),
            subagent("sub-3"),
            assistantMessage("assistant-2"),
        ])

        XCTAssertEqual(groups.map(\.id), [
            "thread-v2/assistant-1",
            "lifecycle-group:thread-v2/sub-1",
            "thread-v2/assistant-2",
        ])
        XCTAssertEqual(groups[1].elements.count, 3)
        XCTAssertTrue(groups[1].isGrouped)
        XCTAssertFalse(groups[0].isGrouped)
    }

    /// A lone card keeps its ordinary standalone presentation, and its id stays
    /// the row id so nothing remounts when a second card later joins it.
    func testASingleRelatedThreadCardIsNotGrouped() {
        let groups = ThreadTimelineGrouping.mergeRelatedThreadCardRuns([
            subagent("sub-1"),
            assistantMessage("assistant-1"),
        ])

        XCTAssertEqual(groups.map(\.id), ["thread-v2/sub-1", "thread-v2/assistant-1"])
        XCTAssertFalse(groups[0].isGrouped)
    }

    /// The group id is anchored to the first card so appending a fourth agent
    /// does not change the identity of the container already on screen.
    func testGroupIDIsAnchoredToTheFirstMember() {
        let two = ThreadTimelineGrouping.mergeRelatedThreadCardRuns([
            subagent("sub-1"), subagent("sub-2"),
        ])
        let three = ThreadTimelineGrouping.mergeRelatedThreadCardRuns([
            subagent("sub-1"), subagent("sub-2"), subagent("sub-3"),
        ])
        XCTAssertEqual(two[0].id, three[0].id)
    }

    /// Dividers and interrupt lines are not cards and must never join a group,
    /// or a fan-out card would swallow the boundary that separates it.
    func testDividerLifecycleItemsNeverJoinACardGroup() {
        let compaction = projected(
            V2Fixture.turnItem(
                id: "compaction-1",
                type: "compaction",
                extra: ["driver": .string("codex")]
            )
        )
        let groups = ThreadTimelineGrouping.mergeRelatedThreadCardRuns([
            subagent("sub-1"), compaction, subagent("sub-2"),
        ])
        XCTAssertEqual(groups.count, 3)
        XCTAssertTrue(groups.allSatisfy { !$0.isGrouped })
    }

    // MARK: - Agent update runs

    func testConsecutiveAgentAuthoredPromptsCollapse() {
        let groups = ThreadTimelineGrouping.mergeAgentUpdateRuns([
            userMessage("human-1", createdBy: "user"),
            userMessage("wake-1", createdBy: "agent"),
            userMessage("wake-2", createdBy: "agent"),
            assistantMessage("assistant-1"),
        ])

        XCTAssertEqual(groups.map(\.id), [
            "thread-v2/human-1",
            "agent-updates:thread-v2/wake-1",
            "thread-v2/assistant-1",
        ])
        XCTAssertEqual(groups[1].elements.count, 2)
    }

    func testASingleAgentUpdateKeepsItsOrdinaryMessagePresentation() {
        let groups = ThreadTimelineGrouping.mergeAgentUpdateRuns([
            userMessage("wake-1", createdBy: "agent"),
            userMessage("human-1", createdBy: "user"),
        ])
        XCTAssertEqual(groups.map(\.id), ["thread-v2/wake-1", "thread-v2/human-1"])
        XCTAssertFalse(groups[0].isGrouped)
    }

    /// An assistant message authored by the agent is not a user-facing prompt;
    /// only `user_message` rows collapse.
    func testOnlyUserMessagesCountAsAgentUpdates() {
        XCTAssertFalse(
            ThreadTimelineGrouping.isAgentUpdate(
                V2Fixture.assistantMessage(id: "assistant-1", text: "hi", streaming: false)
            )
        )
    }

    func testMergingAnEmptyTimelineProducesNothing() {
        XCTAssertTrue(ThreadTimelineGrouping.mergeRelatedThreadCardRuns([]).isEmpty)
        XCTAssertTrue(ThreadTimelineGrouping.mergeAgentUpdateRuns([]).isEmpty)
    }

    // MARK: - Day bucketing

    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        calendar.locale = Locale(identifier: "en_US")
        return calendar
    }()

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12) -> Date {
        calendar.date(
            from: DateComponents(year: year, month: month, day: day, hour: hour, minute: 0)
        )!
    }

    /// Local rather than UTC: a message sent at 23:30 belongs to the day the
    /// reader remembers sending it, not the day UTC happened to be on.
    func testDayKeyUsesTheReadersLocalCalendarDay() {
        XCTAssertEqual(
            ThreadTimelineDay.key(for: date(2026, 3, 19, 23), calendar: calendar),
            "2026-03-19"
        )
        XCTAssertEqual(
            ThreadTimelineDay.key(for: date(2026, 3, 19, 9), calendar: calendar),
            "2026-03-19"
        )
        XCTAssertEqual(
            ThreadTimelineDay.key(for: date(2026, 3, 20, 1), calendar: calendar),
            "2026-03-20"
        )
    }

    func testDayLabelNamesTheDaysAReaderStillHoldsInTheirHead() {
        let now = date(2026, 3, 19, 10)
        XCTAssertEqual(
            ThreadTimelineDay.label(for: now, now: now, calendar: calendar),
            "Today"
        )
        XCTAssertEqual(
            ThreadTimelineDay.label(for: date(2026, 3, 18, 22), now: now, calendar: calendar),
            "Yesterday"
        )
    }

    /// The year only appears once it isn't the current one.
    func testDatedLabelsAddTheYearOnlyWhenItDiffers() {
        let now = date(2026, 3, 19, 10)
        let sameYear = ThreadTimelineDay.label(
            for: date(2026, 1, 5), now: now, calendar: calendar,
            locale: Locale(identifier: "en_US")
        )
        let otherYear = ThreadTimelineDay.label(
            for: date(2025, 1, 5), now: now, calendar: calendar,
            locale: Locale(identifier: "en_US")
        )
        XCTAssertFalse(sameYear.contains("2026"))
        XCTAssertTrue(otherYear.contains("2025"))
        XCTAssertTrue(sameYear.contains("Jan"))
    }

    /// Only between days: the first entry carries no divider, because there is
    /// nothing above it to separate from.
    func testDayDividersOnlyAppearBetweenDays() {
        let entries = [
            date(2026, 3, 18, 9),
            date(2026, 3, 18, 23),
            date(2026, 3, 19, 1),
            date(2026, 3, 19, 20),
            date(2026, 3, 21, 8),
        ]
        XCTAssertEqual(
            ThreadTimelineDay.dividerIndexes(entries, calendar: calendar) { $0 },
            [2, 4]
        )
    }

    /// Turn items carry fractional seconds on the wire, but the plain form
    /// still appears; both have to bucket, and neither may throw.
    func testWireTimestampsParseWithAndWithoutFractionalSeconds() {
        XCTAssertEqual(
            ThreadTimelineDay.date(fromISO8601: "2026-07-31T12:00:00.000Z"),
            ThreadTimelineDay.date(fromISO8601: "2026-07-31T12:00:00Z")
        )
        XCTAssertNotNil(ThreadTimelineDay.date(fromISO8601: "2026-07-31T12:00:00.123Z"))
        XCTAssertNil(ThreadTimelineDay.date(fromISO8601: "not a date"))
    }

    func testUndatedEntriesNeitherBreakNorContinueADayRun() {
        let entries: [Date?] = [date(2026, 3, 18), nil, date(2026, 3, 18), date(2026, 3, 19)]
        XCTAssertEqual(
            ThreadTimelineDay.dividerIndexes(entries, calendar: calendar) { $0 },
            [3]
        )
    }
}
