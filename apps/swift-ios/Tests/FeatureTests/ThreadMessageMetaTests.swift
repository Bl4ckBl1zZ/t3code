import Foundation
import Testing
@testable import T3Code

@Suite("Per-message meta: time, status, restore and fork")
struct ThreadMessageMetaTests {
    private func projected(_ item: OrchestrationV2TurnItem, source: String = "thread-v2") -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(position: 0, visibility: .local, sourceThreadId: source, sourceItemId: item.id, item: item)
    }

    private func user(_ id: String, run: String, intent: String = "turn_start", status: String = "completed") -> OrchestrationV2ProjectedTurnItem {
        projected(V2Fixture.turnItem(id: id, type: "user_message", status: status, extra: [
            "runId": .string(run), "messageId": .string("m-\(id)"), "inputIntent": .string(intent), "text": .string("hi"),
        ]))
    }

    private func assistant(_ id: String, run: String?, status: String = "completed") -> OrchestrationV2ProjectedTurnItem {
        projected(V2Fixture.turnItem(id: id, type: "assistant_message", status: status, extra: [
            "runId": run.map(JSONValue.string) ?? .null, "messageId": .string("m-\(id)"), "text": .string("done"), "streaming": .bool(false),
        ]))
    }

    private func checkpointItem(_ id: String, run: String, files: [(String, Int, Int)]) -> OrchestrationV2ProjectedTurnItem {
        projected(V2Fixture.turnItem(id: "item-\(id)", type: "checkpoint", extra: [
            "runId": .string(run), "checkpointId": .string(id), "scopeId": .string("scope-1"),
            "files": .array(files.map { .object(["path": .string($0.0), "kind": .string("modified"), "additions": .number(Double($0.1)), "deletions": .number(Double($0.2))]) }),
        ]))
    }

    private func checkpoint(_ id: String, run: String?, ordinal: Int?, within: Int, status: String = "ready") -> OrchestrationV2Checkpoint {
        OrchestrationV2Checkpoint(id: id, scopeId: "scope-1", status: status, files: [], runId: run, ordinalWithinScope: within, appRunOrdinal: ordinal)
    }

    private let checkpoints = [
        OrchestrationV2Checkpoint(id: "base", scopeId: "scope-1", status: "ready", files: [], runId: nil, ordinalWithinScope: 0, appRunOrdinal: nil),
        OrchestrationV2Checkpoint(id: "c1", scopeId: "scope-1", status: "ready", files: [], runId: "run-1", ordinalWithinScope: 1, appRunOrdinal: 1),
        OrchestrationV2Checkpoint(id: "c2", scopeId: "scope-1", status: "ready", files: [], runId: "run-2", ordinalWithinScope: 2, appRunOrdinal: 2),
    ]

    private func resolve(
        _ items: [OrchestrationV2ProjectedTurnItem],
        checkpoints: [OrchestrationV2Checkpoint] = [],
        support: [String: ThreadActivityItemSupport] = [:],
        activeRunID: String? = nil,
        latestRunID: String? = "run-2",
        isWorking: Bool = false
    ) -> [String: ThreadMessageMeta] {
        ThreadMessageMetaResolver.resolve(
            timelineItems: items,
            checkpoints: checkpoints,
            itemSupport: support,
            threadID: "environment:e/thread:thread-v2",
            activeRunID: activeRunID,
            latestRunID: latestRunID,
            isWorking: isWorking
        )
    }

    // MARK: Restore

    @Test func restoresToTheCheckpointBeforeTheMessagesTurn() {
        let metas = resolve([user("u1", run: "run-1"), user("u2", run: "run-2", intent: "queued_turn")], checkpoints: checkpoints)
        #expect(metas["u1"]?.restore?.target.checkpointID == "base")
        #expect(metas["u1"]?.restore?.targetOrdinal == 0)
        #expect(metas["u2"]?.restore?.target.checkpointID == "c1")
        #expect(metas["u2"]?.restore?.target.threadID == "environment:e/thread:thread-v2")
    }

    @Test func offersNoRestoreForSteersOrWithoutReadyCheckpoints() {
        #expect(resolve([user("u1", run: "run-2", intent: "steer")], checkpoints: checkpoints)["u1"]?.restore == nil)
        // The message's own run never captured one.
        #expect(resolve([user("u1", run: "run-9")], checkpoints: checkpoints)["u1"]?.restore == nil)
        // The point to go back to is not usable.
        let stale = [checkpoints[0], checkpoint("c1", run: "run-1", ordinal: 1, within: 1, status: "stale"), checkpoints[2]]
        #expect(resolve([user("u2", run: "run-2")], checkpoints: stale)["u2"]?.restore == nil)
    }

    @Test func previewsWhatRestoringBeforeAMessageUndoes() {
        let items = [
            user("u1", run: "run-1"), checkpointItem("c1", run: "run-1", files: [("a.swift", 1, 0)]),
            user("u2", run: "run-2"), checkpointItem("c2", run: "run-2", files: [("a.swift", 2, 1), ("b.swift", 5, 0)]),
            user("u3", run: "run-3"),
        ]
        let three = checkpoints + [checkpoint("c3", run: "run-3", ordinal: 3, within: 3)]
        let point = resolve(items, checkpoints: three)["u2"]!.restore!
        let request = CheckpointRestoreRequest.beforeMessage(point, timelineItems: items, checkpoints: three)
        #expect(request.target.checkpointID == "c1")
        #expect(request.exchangesAfter == 2)
        #expect(request.files.map(\.path) == ["a.swift", "b.swift"])
        #expect(request.files.first?.additions == 2)
        #expect(request.newerRestorePoints == 2)
    }

    // MARK: Replies

    @Test func onlyTheLastReplyOfASettledRunGetsTimeAndFork() {
        let items = [user("u1", run: "run-1"), assistant("a1", run: "run-1"), assistant("a2", run: "run-1"), user("u2", run: "run-2"), assistant("a3", run: "run-2", status: "running")]
        let metas = resolve(items, activeRunID: "run-2")
        #expect(metas["a1"] == nil)
        #expect(metas["a2"]?.timestamp != nil)
        #expect(metas["a2"]?.fork == ThreadMessageForkPoint(messageID: "a2", sourceThreadID: "thread-v2", runID: "run-1", latestOnly: false))
        // Still running: provisionally last, so nothing yet.
        #expect(metas["a3"] == nil)
    }

    @Test func runlessRepliesSettleWithTheThread() {
        let items = [user("u1", run: "run-1"), assistant("a1", run: nil)]
        #expect(resolve(items, isWorking: true)["a1"] == nil)
        let settled = resolve(items)["a1"]
        #expect(settled?.timestamp != nil)
        #expect(settled?.fork == nil)
    }

    @Test func forkFollowsTheSessionsCapabilities() {
        let items = [user("u1", run: "run-1"), assistant("a1", run: "run-1")]
        func support(_ fork: ThreadForkCapabilities) -> [String: ThreadActivityItemSupport] {
            [items[1].id: ThreadActivityItemSupport(providerSession: .init(status: "ready", model: nil, cwd: "", fork: fork))]
        }
        let none = ThreadForkCapabilities(canForkThread: false, canForkFromTurn: false, hasStrongNativeThreadIDs: true, supportsFullThreadHandoff: false)
        #expect(resolve(items, support: support(none))["a1"]?.fork == nil)

        let headOnly = ThreadForkCapabilities(canForkThread: true, canForkFromTurn: false, hasStrongNativeThreadIDs: true, supportsFullThreadHandoff: false)
        #expect(resolve(items, support: support(headOnly), latestRunID: "run-1")["a1"]?.fork?.latestOnly == true)
        #expect(resolve(items, support: support(headOnly), latestRunID: "run-2")["a1"]?.fork == nil)

        let handoff = ThreadForkCapabilities(canForkThread: false, canForkFromTurn: false, hasStrongNativeThreadIDs: false, supportsFullThreadHandoff: true)
        #expect(resolve(items, support: support(handoff))["a1"]?.fork?.latestOnly == false)
    }

    @Test func forkCapabilitiesNeedEveryGroupToCountAsEvidence() {
        #expect(ThreadForkCapabilities(nil) == nil)
        #expect(ThreadForkCapabilities(OrchestrationV2ProviderCapabilities(threads: .init(canForkThread: true))) == nil)
        let full = ThreadForkCapabilities(OrchestrationV2ProviderCapabilities(
            threads: .init(canForkThread: true, canForkFromTurn: true),
            identity: .init(nativeThreadIds: "strong"),
            context: .init()
        ))
        #expect(full?.allowsFork(isLatestRun: false) == true)
    }

    @Test func decodesTheForkGroupsTolerantly() throws {
        let json = #"{"turns":{},"threads":{"canForkThread":true},"identity":{"nativeThreadIds":"weak"},"context":{"supportsFullThreadHandoff":true,"maxRecommendedHandoffChars":null}}"#
        let decoded = try JSONDecoder().decode(OrchestrationV2ProviderCapabilities.self, from: Data(json.utf8))
        #expect(decoded.threads == .init(canForkThread: true, canForkFromTurn: false))
        #expect(decoded.identity?.nativeThreadIds == "weak")
        #expect(decoded.context?.supportsFullThreadHandoff == true)
        let checkpoint = try JSONDecoder().decode(
            OrchestrationV2Checkpoint.self,
            from: Data(#"{"id":"c","scopeId":"s","status":"ready","files":[],"runId":null,"ordinalWithinScope":0,"appRunOrdinal":null}"#.utf8)
        )
        #expect(checkpoint.ordinalWithinScope == 0)
        #expect(checkpoint.appRunOrdinal == nil)
    }

    // MARK: Status and time

    @Test func showsAPillOnlyForSettledFailures() {
        let items = [user("u1", run: "run-1", status: "failed"), assistant("a1", run: "run-1", status: "interrupted"), user("u2", run: "run-2", status: "pending")]
        let metas = resolve(items)
        #expect(metas["u1"]?.status == ThreadMessageStatusPill(label: "Failed", tone: .danger))
        #expect(metas["a1"]?.status == ThreadMessageStatusPill(label: "Interrupted", tone: .neutral))
        #expect(metas["a1"]?.fork == nil)
        #expect(metas["u2"]?.status == nil)
    }

    @Test func timeLabelsAddTheDayOnlyOnceItIsNotToday() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 8, hour: 15)))
        let today = ThreadMessageTimestamp(date: now.addingTimeInterval(-3600), now: now, calendar: calendar)
        #expect(today.fullLabel.hasPrefix("Today at "))
        #expect(!today.label.contains("Today"))
        let yesterday = ThreadMessageTimestamp(date: now.addingTimeInterval(-86_400), now: now, calendar: calendar)
        #expect(yesterday.label.hasPrefix("Yesterday at "))
        let lastYear = ThreadMessageTimestamp(date: now.addingTimeInterval(-400 * 86_400), now: now, calendar: calendar)
        #expect(lastYear.label.contains("2025"))
    }
}
