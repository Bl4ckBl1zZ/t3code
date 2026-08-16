import XCTest

@testable import T3Code

/// The transcript's row split, ported from `buildThreadFeed` in
/// apps/mobile/src/lib/threadActivity.ts. Both clients read the same projection,
/// so a turn item has to land in the same kind of row on both.
final class ThreadTimelineFeedTests: XCTestCase {
    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// `V2Fixture.timestamp` as a `Date`, so a message entry lands on the same
    /// calendar day as the fixture items around it and no test picks up a day
    /// divider it did not ask for.
    private static let day = Date(timeIntervalSince1970: 1_785_499_200)
    private static let nextDay = day.addingTimeInterval(86_400)

    private func projected(
        _ item: OrchestrationV2TurnItem,
        position: Int = 0,
        sourceThreadID: String = "thread-v2"
    ) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: position,
            visibility: .local,
            sourceThreadId: sourceThreadID,
            sourceItemId: item.id,
            item: item
        )
    }

    private func command(_ id: String, at startedAt: String = V2Fixture.timestamp) -> OrchestrationV2ProjectedTurnItem {
        projected(
            V2Fixture.turnItem(
                id: id,
                type: "command_execution",
                extra: ["input": .string("ls"), "startedAt": .string(startedAt)]
            )
        )
    }

    private func subagentItem(
        _ id: String,
        childThreadID: String? = nil
    ) -> OrchestrationV2ProjectedTurnItem {
        var extra: [String: JSONValue] = [
            "subagentId": .string(id),
            "origin": .string("delegated_task"),
            "driver": .string("claude"),
            "providerInstanceId": .string("claude"),
            "prompt": .string("do the thing"),
        ]
        if let childThreadID { extra["childThreadId"] = .string(childThreadID) }
        return projected(V2Fixture.turnItem(id: id, type: "subagent", extra: extra))
    }

    private func compaction(_ id: String) -> OrchestrationV2ProjectedTurnItem {
        projected(V2Fixture.turnItem(id: id, type: "compaction", extra: ["driver": .null]))
    }

    private func assistant(
        _ id: String,
        text: String = "hello",
        at createdAt: Date = ThreadTimelineFeedTests.day
    ) -> (OrchestrationV2ProjectedTurnItem, FeatureMessage) {
        let item = V2Fixture.assistantMessage(id: id, text: text, streaming: false)
        return (
            projected(item),
            FeatureMessage(id: item.id, role: .assistant, text: text, createdAt: createdAt)
        )
    }

    private func entries(
        _ items: [OrchestrationV2ProjectedTurnItem],
        messages: [FeatureMessage] = [],
        subagentChildThreadIDs: [String: String] = [:]
    ) -> [ThreadTimelineEntry] {
        ThreadTimelineFeed.entries(
            timelineItems: items,
            messages: messages,
            subagentChildThreadIDs: subagentChildThreadIDs,
            calendar: Self.utc
        )
    }

    // MARK: - Classification

    func testContiguousNonMessageItemsCollapseIntoOneWorkLogEntry() {
        let rows = entries([command("a"), command("b"), command("c")])

        XCTAssertEqual(rows.count, 1)
        guard case let .workLog(workLog) = rows[0] else {
            return XCTFail("expected a work-log entry, got \(rows[0])")
        }
        XCTAssertEqual(workLog.rows.map(\.item.id), ["a", "b", "c"])
    }

    /// A group is the unit that folds, so it must not straddle a message: the
    /// two commands below belong to different sides of the conversation.
    func testAMessageSplitsTheWorkLogGroupsAroundIt() {
        let (item, message) = assistant("m1")
        let rows = entries([command("a"), item, command("b")], messages: [message])

        XCTAssertEqual(rows.count, 3)
        guard case .workLog = rows[0], case .message = rows[1], case .workLog = rows[2] else {
            return XCTFail("expected work log, message, work log, got \(rows.map(\.id))")
        }
    }

    func testLifecycleItemsBecomeLifecycleRowsRatherThanWorkLogEntries() {
        let rows = entries([compaction("c1")])

        XCTAssertEqual(rows.count, 1)
        guard case let .lifecycle(lifecycle) = rows[0] else {
            return XCTFail("expected a lifecycle entry, got \(rows[0])")
        }
        XCTAssertEqual(lifecycle.rows.map(\.item.id), ["c1"])
    }

    // MARK: - Grouping

    func testAdjacentRelatedThreadCardsMergeIntoOneEntry() {
        let rows = entries([subagentItem("s1"), subagentItem("s2"), subagentItem("s3")])

        XCTAssertEqual(rows.count, 1)
        guard case let .lifecycle(lifecycle) = rows[0] else {
            return XCTFail("expected a lifecycle entry, got \(rows[0])")
        }
        XCTAssertEqual(lifecycle.rows.map(\.item.id), ["s1", "s2", "s3"])
        // Anchored on the first card, so the id survives a fourth agent joining.
        XCTAssertTrue(lifecycle.id.hasSuffix("thread-v2/s1"))
    }

    func testADividerBetweenTwoCardsKeepsThemApart() {
        let rows = entries([subagentItem("s1"), compaction("c1"), subagentItem("s2")])

        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(
            rows.compactMap { entry -> [String]? in
                guard case let .lifecycle(lifecycle) = entry else { return nil }
                return lifecycle.rows.map(\.item.id)
            },
            [["s1"], ["c1"], ["s2"]]
        )
    }

    /// A subagent's child thread is only routable once it has been scoped to an
    /// environment, which is the one thing the row cannot derive itself.
    func testSubagentCardsCarryTheFeatureScopedChildThreadID() {
        let rows = entries(
            [subagentItem("s1", childThreadID: "wire-child")],
            subagentChildThreadIDs: ["s1": "env-1:wire-child"]
        )

        guard case let .lifecycle(lifecycle) = rows.first else {
            return XCTFail("expected a lifecycle entry, got \(String(describing: rows.first))")
        }
        XCTAssertEqual(
            lifecycle.childThreadIDs[lifecycle.rows[0].id],
            "env-1:wire-child"
        )
    }

    // MARK: - Messages

    /// An optimistic send has no projected item until the server answers, and
    /// dropping it would make the bubble vanish the moment it was typed.
    func testMessagesWithNoProjectedItemStillRender() {
        let (item, message) = assistant("m1")
        let pending = FeatureMessage(
            id: "pending-1",
            role: .user,
            text: "queued",
            createdAt: message.createdAt,
            state: .queued
        )

        let rows = entries([item], messages: [message, pending])

        XCTAssertEqual(rows.map(\.id), ["message:m1", "message:pending-1"])
    }

    /// A client with no projection at all — an older server, a test double —
    /// still renders its transcript as plain messages.
    func testAMessageOnlyDetailStillRendersEveryMessage() {
        let first = FeatureMessage(id: "a", role: .user, text: "hi", createdAt: Self.day)
        let second = FeatureMessage(
            id: "b", role: .assistant, text: "hello", createdAt: Self.day
        )

        XCTAssertEqual(
            entries([], messages: [first, second]).map(\.id),
            ["message:a", "message:b"]
        )
    }

    /// An assistant row before its first token has nothing to draw, and hiding
    /// it must not split the work group it sits inside.
    func testAnEmptyBubbleIsSkippedWithoutSplittingTheWorkGroup() {
        let (item, message) = assistant("m1", text: "")
        let rows = entries([command("a"), item, command("b")], messages: [message])

        XCTAssertEqual(rows.count, 1)
        guard case let .workLog(workLog) = rows[0] else {
            return XCTFail("expected one work-log entry, got \(rows.map(\.id))")
        }
        XCTAssertEqual(workLog.rows.map(\.item.id), ["a", "b"])
    }

    // MARK: - Day dividers

    func testDayDividersSeparateEntriesByLocalDay() {
        let (firstItem, firstMessage) = assistant("m1", at: Self.day)
        let (secondItem, secondMessage) = assistant("m2", at: Self.nextDay)

        let rows = entries(
            [firstItem, secondItem],
            messages: [firstMessage, secondMessage]
        )

        XCTAssertEqual(
            rows.map(\.id),
            ["message:m1", "day-divider:message:m2", "message:m2"]
        )
    }

    func testTheFirstEntryNeverGetsADayDivider() {
        let (item, message) = assistant("m1")

        XCTAssertEqual(entries([item], messages: [message]).map(\.id), ["message:m1"])
    }

    // MARK: - Identity

    /// A duplicate identifier is fatal to the diffable data source behind the
    /// transcript, so the feed has to guarantee uniqueness itself.
    func testEntryIdentifiersAreUnique() {
        let (item, message) = assistant("m1")
        let rows = entries(
            [command("a"), item, subagentItem("s1"), command("b")],
            messages: [message, message]
        )

        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
    }
}
