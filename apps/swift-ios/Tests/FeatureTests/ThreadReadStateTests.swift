import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Thread read state")
struct ThreadReadStateTests {
    private let now = Date(timeIntervalSince1970: 10_000)

    private func thread(
        _ id: String = "thread",
        state: FeatureThreadState = .completed,
        completedAt: Date? = nil,
        visitedAt: Date? = nil,
        tracksVisits: Bool? = true
    ) -> FeatureThread {
        var thread = FeatureThread(
            id: id,
            projectID: "project",
            title: "Task",
            updatedAt: completedAt ?? Date(timeIntervalSince1970: 9_000),
            state: state
        )
        thread.latestTurnCompletedAt = completedAt
        thread.lastVisitedAt = visitedAt
        thread.supportsVisitedTracking = tracksVisits
        return thread
    }

    @Test
    func doneLastsOnlyUntilTheCompletionIsSeen() {
        let unseen = thread(completedAt: now, visitedAt: now.addingTimeInterval(-60))
        #expect(unseen.hasUnseenCompletion)
        #expect(unseen.homeStatus(at: now) == .done)
        #expect(unseen.workInboxBadge == .done)
        #expect(!unseen.homeRecedes(at: now))

        let seen = thread(completedAt: now, visitedAt: now)
        #expect(!seen.hasUnseenCompletion)
        #expect(seen.homeStatus(at: now) == .ready)
        #expect(seen.workInboxBadge == nil)
        #expect(seen.homeRecedes(at: now))

        // A never-visited thread (fresh environment, older server) reads as read.
        let neverVisited = thread(completedAt: now)
        #expect(!neverVisited.hasUnseenCompletion)
        #expect(neverVisited.homeStatus(at: now) == .ready)
    }

    @Test
    func usageLimitFailuresReadAsLimitedNotFailed() {
        var limited = thread(state: .failed)
        limited.lastErrorClass = "usage_limit"
        #expect(limited.homeStatus(at: now) == .limited)
        #expect(limited.homeStatusLabel == "Limited")
        #expect(limited.workInboxBadge == .limited)

        var broken = thread(state: .failed)
        broken.lastErrorClass = "provider_error"
        #expect(broken.homeStatus(at: now) == .failed)

        // Older servers send no class: every failure stays Failed.
        #expect(thread(state: .failed).homeStatus(at: now) == .failed)
    }

    @Test
    func aSnoozeThatRanOutReadsAsWokeUntilVisited() {
        var woke = thread(state: .idle)
        woke.snoozedAt = now.addingTimeInterval(-3_600)
        woke.snoozedUntil = now.addingTimeInterval(-60)
        #expect(woke.isWoke(at: now))
        #expect(woke.homeStatus(at: now) == .woke)
        #expect(woke.homeStatusLabel == "Woke")

        // Still asleep.
        #expect(!woke.isWoke(at: now.addingTimeInterval(-120)))

        // A visit covering the wake clears it, and the visit's watermark is
        // what makes that true.
        let watermark = woke.visitWatermark(at: now)
        #expect(watermark == woke.snoozedUntil)
        woke.lastVisitedAt = watermark
        #expect(!woke.isWoke(at: now))
        #expect(woke.homeStatus(at: now) == .ready)

        // No visited tracking, no Woke: nothing could clear it.
        var untracked = thread(state: .idle, tracksVisits: nil)
        untracked.snoozedUntil = now.addingTimeInterval(-60)
        #expect(!untracked.isWoke(at: now))
    }

    @Test
    func aRunFinishingDuringTheSnoozeWakesAtItsCompletion() {
        var woke = thread(completedAt: now.addingTimeInterval(-30), visitedAt: now.addingTimeInterval(-600))
        woke.snoozedAt = now.addingTimeInterval(-300)
        woke.snoozedUntil = now.addingTimeInterval(3_600)
        #expect(woke.wokeAt(now: now) == now.addingTimeInterval(-30))
        // Woke outranks the plain Done it also is.
        #expect(woke.homeStatus(at: now) == .woke)
        #expect(woke.workInboxBadge == .done)
    }

    @Test
    func markReadAndUnreadAreEachOthersWayBack() {
        let read = thread(completedAt: now, visitedAt: now)
        #expect(read.canMarkUnread)
        #expect(!read.canMarkRead(at: now))

        let unread = thread(completedAt: now, visitedAt: now.addingTimeInterval(-1))
        #expect(!unread.canMarkUnread)
        #expect(unread.canMarkRead(at: now))

        // Nothing finished yet, nothing to mark.
        #expect(!thread(state: .working).canMarkUnread)
        // Archived rows and untracked servers offer neither.
        var archived = read
        archived.isArchived = true
        #expect(!archived.canMarkUnread)
        #expect(!thread(completedAt: now, visitedAt: now, tracksVisits: nil).canMarkUnread)
    }

    @Test
    func rowMenuOffersOneReadStateEntry() {
        let unreadIDs = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(canMarkRead: true),
            now: now
        ).map(\.id)
        #expect(unreadIDs.contains(ThreadRowMenuActions.markReadActionID))
        #expect(!unreadIDs.contains(ThreadRowMenuActions.markUnreadActionID))

        let readIDs = ThreadRowMenuActions.homeRowActions(
            ThreadRowMenuContext(canMarkUnread: true),
            now: now
        ).map(\.id)
        #expect(readIDs.contains(ThreadRowMenuActions.markUnreadActionID))

        let archived = ThreadRowMenuContext(isArchived: true, canMarkUnread: true)
        #expect(ThreadRowMenuActions.readStateAction(archived) == nil)
    }

    @Test
    func visitsGoOutAtOnceForUnseenWorkAndThrottleOrdinaryActivity() {
        let unseen = thread(completedAt: now, visitedAt: now.addingTimeInterval(-60))
        #expect(
            ThreadVisitPolicy.decide(
                thread: unseen, now: now, lastDispatchedWatermark: nil,
                lastDispatchAt: now.addingTimeInterval(-1)
            ) == .now(now)
        )
        // The same watermark is never sent twice.
        #expect(
            ThreadVisitPolicy.decide(
                thread: unseen, now: now, lastDispatchedWatermark: now, lastDispatchAt: nil
            ) == .skip
        )

        // A streaming turn moves updatedAt with nothing new to read yet.
        var streaming = thread(state: .working, visitedAt: now.addingTimeInterval(-20))
        streaming.updatedAt = now.addingTimeInterval(-5)
        let watermark = streaming.updatedAt
        #expect(
            ThreadVisitPolicy.decide(
                thread: streaming, now: now, lastDispatchedWatermark: nil,
                lastDispatchAt: now.addingTimeInterval(-4)
            ) == .after(ThreadVisitPolicy.throttle - 4, watermark)
        )
        #expect(
            ThreadVisitPolicy.decide(
                thread: streaming, now: now, lastDispatchedWatermark: nil, lastDispatchAt: nil
            ) == .now(watermark)
        )

        // Already covered, untracked, or archived: nothing to send.
        let seen = thread(completedAt: now, visitedAt: now)
        #expect(ThreadVisitPolicy.decide(thread: seen, now: now, lastDispatchedWatermark: nil, lastDispatchAt: nil) == .skip)
        let untracked = thread(completedAt: now, tracksVisits: nil)
        #expect(ThreadVisitPolicy.decide(thread: untracked, now: now, lastDispatchedWatermark: nil, lastDispatchAt: nil) == .skip)
    }

    @Test
    func trackerRetriesFailuresAndKeepsAMarkUnreadSticky() {
        let tracker = ThreadVisitTracker()
        let unseen = thread(completedAt: now, visitedAt: now.addingTimeInterval(-60))

        tracker.recordDispatch(threadID: unseen.id, watermark: now, at: now)
        #expect(tracker.decide(unseen, now: now) == .skip)
        tracker.recordFailure(threadID: unseen.id, watermark: now)
        #expect(tracker.decide(unseen, now: now) == .now(now))

        // Mark Unread on the open thread: it stays unread while open...
        tracker.suppress(threadID: unseen.id, watermark: unseen.visitWatermark(at: now))
        #expect(tracker.decide(unseen, now: now) == .skip)
        // ...and reads again once the thread is left and reopened.
        tracker.forget(threadID: unseen.id)
        #expect(tracker.decide(unseen, now: now) == .now(now))
    }

    @Test
    func visitCommandsMatchTheContract() {
        let visitedAt = Date(timeIntervalSince1970: 1_780_000_000.1234)
        #expect(
            OrchestrationCommands.visit(threadID: "t", visitedAt: visitedAt, commandID: "c")
                == .object([
                    "type": .string("thread.visit"),
                    "commandId": .string("c"),
                    "threadId": .string("t"),
                    "visitedAt": .string("2026-05-28T20:26:40.123Z"),
                ])
        )
        #expect(
            OrchestrationCommands.markUnread(threadID: "t", commandID: "c")
                == .object([
                    "type": .string("thread.mark-unread"),
                    "commandId": .string("c"),
                    "threadId": .string("t"),
                ])
        )
        // Rounded, not truncated, so a parsed server timestamp echoes exactly.
        let justUnder = Date(timeIntervalSince1970: 1_780_000_000.9996)
        #expect(OrchestrationCommands.millisecondTimestamp(justUnder) == "2026-05-28T20:26:41.000Z")
    }
}

@Suite("Pinned thread order")
struct PinnedThreadOrderTests {
    private func pinned(_ id: String, key: String?, updatedAt: TimeInterval = 0) -> FeatureThread {
        var thread = FeatureThread(
            id: id,
            projectID: "project",
            title: id,
            updatedAt: Date(timeIntervalSince1970: updatedAt)
        )
        thread.pinnedAt = Date(timeIntervalSince1970: 1)
        thread.pinOrderKey = key
        thread.supportsPinReorder = true
        return thread
    }

    @Test
    func arrangedPinsSortByKeyAndKeylessOnesFollow() {
        let threads = [
            pinned("keyless-old", key: nil, updatedAt: 10),
            pinned("b", key: "m"),
            pinned("keyless-new", key: nil, updatedAt: 20),
            pinned("a-tie", key: "f"),
            pinned("z-tie", key: "f"),
        ]
        let ordered = threads.sorted(by: DailyUXSidebarIndex.pinnedOrder).map(\.id)
        #expect(ordered == ["a-tie", "z-tie", "b", "keyless-new", "keyless-old"])
    }

    @Test
    func aFreshPinLandsAboveTheArrangedRun() throws {
        let run = [pinned("a", key: "c"), pinned("b", key: "m")]
        var fresh = FeatureThread(id: "fresh", projectID: "project", title: "Fresh")
        fresh.supportsPinReorder = true
        let key = try #require(PinnedThreadOrder.topKey(for: fresh, among: run + [fresh]))
        #expect(key < "c")

        // A server without pin ordering gets a bare pin.
        fresh.supportsPinReorder = nil
        #expect(PinnedThreadOrder.topKey(for: fresh, among: run) == nil)
    }

    @Test
    func movingAPinBetweenArrangedNeighboursWritesOneKey() throws {
        let a = pinned("a", key: "c")
        let b = pinned("b", key: "m")
        let moved = pinned("moved", key: "t")
        let writes = PinnedThreadOrder.assignments(
            ordered: [a, moved, b],
            movedID: "moved",
            snapshot: [a, b, moved]
        )
        let write = try #require(writes.first)
        #expect(writes.count == 1)
        #expect(write.0 == "moved")
        #expect(write.1 > "c" && write.1 < "m")
    }
}
