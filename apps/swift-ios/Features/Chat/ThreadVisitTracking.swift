import SwiftUI

extension View {
    /// Sends `thread.visit` while `thread` is on screen and the app is in the
    /// foreground: on open, when a run finishes or a snooze wakes in view, and
    /// on return from the background. ``ThreadVisitPolicy`` decides when.
    func threadVisitTracking(_ thread: FeatureThread, model: FeatureRootModel) -> some View {
        modifier(ThreadVisitTrackingModifier(thread: thread, model: model))
    }
}

private struct ThreadVisitTrackingModifier: ViewModifier {
    let thread: FeatureThread
    let model: FeatureRootModel

    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false

    /// Only what can change the decision. Nil while hidden or backgrounded,
    /// which cancels a pending trailing visit.
    private struct Trigger: Equatable {
        let threadID: String
        let updatedAt: Date
        let lastVisitedAt: Date?
        let latestTurnCompletedAt: Date?
        let snoozedUntil: Date?
        let state: FeatureThreadState
        let supportsVisitedTracking: Bool?
    }

    private var trigger: Trigger? {
        guard isVisible, scenePhase == .active, thread.supportsVisitedTracking == true else { return nil }
        return Trigger(
            threadID: thread.id,
            updatedAt: thread.updatedAt,
            lastVisitedAt: thread.lastVisitedAt,
            latestTurnCompletedAt: thread.latestTurnCompletedAt,
            snoozedUntil: thread.snoozedUntil,
            state: thread.state,
            supportsVisitedTracking: thread.supportsVisitedTracking
        )
    }

    func body(content: Content) -> some View {
        content
            // A pushed thread hides this one without destroying it.
            .onAppear { isVisible = true }
            .onDisappear {
                isVisible = false
                model.threadVisits.forget(threadID: thread.id)
            }
            .task(id: trigger) {
                guard let trigger else { return }
                await visitWhileOnScreen(threadID: trigger.threadID)
            }
    }

    /// A new trigger cancels this and starts over, which is what swaps a
    /// trailing visit for one carrying the newer watermark.
    @MainActor
    private func visitWhileOnScreen(threadID: String) async {
        while !Task.isCancelled {
            guard let current = model.snapshot.threads.first(where: { $0.id == threadID }) else { return }
            let now = Date.now
            switch model.threadVisits.decide(current, now: now) {
            case let .now(watermark):
                await model.visitThread(threadID, watermark: watermark, now: now)
                return
            case let .after(delay, _):
                try? await Task.sleep(for: .seconds(delay))
            case .skip:
                // A snooze running out while the thread is open wakes it with
                // no server event; wait for that rather than leave it Woke.
                guard let wake = current.snoozedUntil, wake > now else { return }
                try? await Task.sleep(for: .seconds(wake.timeIntervalSince(now) + 0.5))
            }
        }
    }
}
