import Foundation

// Ported from apps/mobile/src/features/threads/threadForkNavigation.ts.
//
// Forking returns as soon as the server accepts the command, but the new thread
// is only navigable once its shell has reached this client's projection.
// Navigating on acceptance alone opens a thread the app holds nothing for, so
// the caller waits for the shell and, when it never arrives, stays put and says
// the fork exists but did not reach the device — a recoverable message beats an
// empty screen.

public enum ThreadForkNavigation {
    public static let defaultTimeout: Duration = .seconds(2)
    /// Short enough that the common case — the shell landing on the next
    /// snapshot push — costs one tick rather than a visible pause.
    public static let defaultPollInterval: Duration = .milliseconds(40)

    /// Polls `isReady` until it holds or the timeout elapses, reporting whether
    /// the shell arrived.
    ///
    /// `now` and `sleep` are injectable so tests drive a virtual clock instead
    /// of waiting out real time.
    public static func waitForThreadShellReady(
        timeout: Duration = defaultTimeout,
        pollInterval: Duration = defaultPollInterval,
        now: () -> ContinuousClock.Instant = { ContinuousClock().now },
        sleep: (Duration) async -> Void = { duration in
            _ = try? await Task.sleep(for: duration)
        },
        isReady: () -> Bool
    ) async -> Bool {
        let deadline = now().advanced(by: timeout)

        while !isReady(), now() < deadline {
            // A cancelled sleep returns immediately, which would turn the
            // remaining wait into a busy loop on the clock.
            if Task.isCancelled { break }
            // Clamped to what is left: the last poll lands exactly on the
            // deadline rather than overshooting it by most of an interval.
            await sleep(min(pollInterval, now().duration(to: deadline)))
        }

        return isReady()
    }
}
