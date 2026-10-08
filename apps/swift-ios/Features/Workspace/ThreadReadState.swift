import Foundation

// Read state, ported from the web sidebar (`hasUnseenCompletion` in
// Sidebar.logic.ts, the Woke pill in Sidebar.tsx, `threadWokeAt` in
// packages/client-runtime/src/state/threadSettled.ts) and the visit write path
// in ChatView.tsx. The watermark is server state (`lastVisitedAt`), so Done and
// Woke clear on every device at once.

extension FeatureThread {
    /// A finished run the user has not looked at since. Never-visited threads
    /// count as read, so a fresh environment does not light up its whole
    /// history, and servers without visited tracking never report unread.
    var hasUnseenCompletion: Bool {
        guard let latestTurnCompletedAt, let lastVisitedAt else { return false }
        return latestTurnCompletedAt > lastVisitedAt
    }

    /// The watermark positively covers the latest completion. Stricter than
    /// `!hasUnseenCompletion`: a never-visited thread is neither.
    var hasSeenLatestCompletion: Bool {
        guard let latestTurnCompletedAt, let lastVisitedAt else { return false }
        return lastVisitedAt >= latestTurnCompletedAt
    }

    /// The failed run stopped on a usage limit: Limited, not Failed.
    var isUsageLimited: Bool {
        state == .failed && isUsageLimitFailureClass(lastErrorClass)
    }

    /// When a snoozed thread woke, or nil while it still sleeps or never
    /// snoozed. A timer wake reports the wake time; an early wake (the thread
    /// asked for something) reports what woke it, so a visit made before that
    /// does not hide it. An explicit unsnooze clears `snoozedUntil`, so only
    /// wakes the user did not ask for count.
    func wokeAt(now: Date) -> Date? {
        guard let snoozedUntil else { return nil }
        if state == .waitingForApproval || state == .waitingForInput {
            return updatedAt
        }
        if let snoozedAt, let latestTurnCompletedAt, latestTurnCompletedAt > snoozedAt {
            return latestTurnCompletedAt
        }
        if state == .failed, let snoozedAt, let attentionAt, attentionAt > snoozedAt {
            return attentionAt
        }
        return snoozedUntil <= now ? snoozedUntil : nil
    }

    /// Woke and not visited since. Unlike Done, a never-visited thread still
    /// shows it: snoozing was an explicit act. Needs visited tracking, since
    /// only a visit clears it.
    func isWoke(at now: Date) -> Bool {
        guard supportsVisitedTracking == true, let wokeAt = wokeAt(now: now) else { return false }
        guard let lastVisitedAt else { return true }
        return lastVisitedAt < wokeAt
    }

    /// What a visit records as seen: the thread's own state, and a wake that
    /// fired with no server event behind it. Without the wake, visiting a
    /// timer-woken thread would leave it Woke.
    func visitWatermark(at now: Date) -> Date {
        [latestTurnCompletedAt, wokeAt(now: now)]
            .compactMap { $0 }
            .reduce(updatedAt, max)
    }

    var canMarkUnread: Bool {
        supportsVisitedTracking == true
            && !isArchived
            && latestTurnCompletedAt != nil
            && !hasUnseenCompletion
    }

    func canMarkRead(at now: Date) -> Bool {
        supportsVisitedTracking == true
            && !isArchived
            && (hasUnseenCompletion || isWoke(at: now))
    }

    /// Web's `shouldRecede`: rows with nothing new for the user (read, or busy
    /// on work that is not theirs yet) quiet down so the ones that need them
    /// stand out.
    func homeRecedes(at now: Date) -> Bool {
        switch homeStatus(at: now) {
        case .ready, .working, .background, .approval: true
        case .input, .failed, .limited, .woke, .done: false
        }
    }
}

/// When to send `thread.visit` for the thread on screen. Mirrors web's
/// ChatView: an unseen completion or wake is published at once, ordinary
/// activity while a turn streams rides a trailing throttle, and one watermark
/// is never sent twice.
enum ThreadVisitPolicy {
    static let throttle: TimeInterval = 10

    enum Decision: Equatable {
        case skip
        case now(Date)
        case after(TimeInterval, Date)
    }

    static func decide(
        thread: FeatureThread,
        now: Date,
        lastDispatchedWatermark: Date?,
        lastDispatchAt: Date?
    ) -> Decision {
        guard thread.supportsVisitedTracking == true, !thread.isArchived else { return .skip }
        let watermark = thread.visitWatermark(at: now)
        if let lastVisitedAt = thread.lastVisitedAt, lastVisitedAt >= watermark { return .skip }
        // Dedupe per watermark. This is also what keeps a mark-unread on the
        // open thread sticky: the rewind leaves updatedAt alone, so nothing is
        // sent until new activity lands or the thread is opened again.
        if lastDispatchedWatermark == watermark { return .skip }
        let elapsed = lastDispatchAt.map { now.timeIntervalSince($0) } ?? .infinity
        if thread.hasUnseenCompletion || thread.isWoke(at: now) || elapsed >= throttle {
            return .now(watermark)
        }
        return .after(throttle - elapsed, watermark)
    }
}

/// Per-thread visit bookkeeping for ``ThreadVisitPolicy``, kept on the root
/// model so a mark-unread from any surface (row, batch, chat menu) silences
/// the open thread's next visit.
@MainActor
final class ThreadVisitTracker {
    private var dispatchedWatermarks: [String: Date] = [:]
    private var dispatchTimes: [String: Date] = [:]

    func decide(_ thread: FeatureThread, now: Date) -> ThreadVisitPolicy.Decision {
        ThreadVisitPolicy.decide(
            thread: thread,
            now: now,
            lastDispatchedWatermark: dispatchedWatermarks[thread.id],
            lastDispatchAt: dispatchTimes[thread.id]
        )
    }

    func recordDispatch(threadID: String, watermark: Date, at now: Date) {
        dispatchedWatermarks[threadID] = watermark
        dispatchTimes[threadID] = now
    }

    /// A visit that did not land (offline, refused) must not block the retry.
    func recordFailure(threadID: String, watermark: Date) {
        guard dispatchedWatermarks[threadID] == watermark else { return }
        dispatchedWatermarks[threadID] = nil
    }

    /// Marks the current watermark as already handled, so the thread stays
    /// unread while it sits open.
    func suppress(threadID: String, watermark: Date) {
        dispatchedWatermarks[threadID] = watermark
    }

    /// Leaving the thread ends the stickiness: opening it again reads it.
    func forget(threadID: String) {
        dispatchedWatermarks[threadID] = nil
        dispatchTimes[threadID] = nil
    }
}
