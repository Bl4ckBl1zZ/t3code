import Foundation

// Read state and the pinned run's order. Every entry point (row menu, swipe,
// batch bar, chat menu, the open thread) goes through these, so the local row
// and the visit bookkeeping stay in step.
extension FeatureRootModel {
    /// Records the thread as seen up to `watermark`. The row clears at once;
    /// a failure is silent, like web's, and leaves the watermark free to be
    /// sent again once the thread moves or reconnects.
    @discardableResult
    func visitThread(_ id: String, watermark: Date, now: Date = .now) async -> Bool {
        threadVisits.recordDispatch(threadID: id, watermark: watermark, at: now)
        mutateThread(id: id) { thread in
            thread.lastVisitedAt = max(thread.lastVisitedAt ?? watermark, watermark)
        }
        do {
            try await client.visitThread(id: id, visitedAt: watermark)
            return true
        } catch {
            threadVisits.recordFailure(threadID: id, watermark: watermark)
            return false
        }
    }

    /// Mark Read: the same visit opening the thread would send.
    @discardableResult
    func markThreadRead(_ id: String) async -> Bool {
        guard let thread = snapshot.threads.first(where: { $0.id == id }) else { return false }
        let now = Date.now
        guard thread.canMarkRead(at: now) else { return false }
        return await visitThread(id, watermark: thread.visitWatermark(at: now), now: now)
    }

    /// Mark Unread. Opening the thread again reads it; while it stays open
    /// it stays unread until something new happens in it, as on web.
    @discardableResult
    func markThreadUnread(_ id: String) async -> Bool {
        guard let thread = snapshot.threads.first(where: { $0.id == id }),
              thread.canMarkUnread,
              let completedAt = thread.latestTurnCompletedAt else { return false }
        threadVisits.suppress(threadID: id, watermark: thread.visitWatermark(at: .now))
        let environment = currentEnvironmentIdentity
        return await perform(failureTitle: "Couldn't Mark Thread Unread") {
            try await client.markThreadUnread(id: id)
            guard currentEnvironmentIdentity == environment else { return }
            // The server's rewind lands on the shell stream; this is the same
            // place web's local fallback puts it, so the row flips on the tap.
            mutateThread(id: id) { $0.lastVisitedAt = completedAt.addingTimeInterval(-0.001) }
        }
    }

    /// Moves a pinned thread within the run.
    @discardableResult
    func setPinOrder(_ id: String, key: String) async -> Bool {
        let environment = currentEnvironmentIdentity
        return await perform(failureTitle: "Couldn't Reorder Threads") {
            try await client.setPinOrder(id: id, key: key)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.pinOrderKey = key }
        }
    }

    /// A fresh pin without a slot of its own lands on top of the run.
    func freshPinOrderKey(_ id: String, pinned: Bool) -> String? {
        guard pinned, let thread = snapshot.threads.first(where: { $0.id == id }) else { return nil }
        return PinnedThreadOrder.topKey(for: thread, among: snapshot.threads)
    }
}
