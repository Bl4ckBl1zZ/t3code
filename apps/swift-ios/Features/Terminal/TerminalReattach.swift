import Foundation

/// What the terminal does when its attach stream ends without being cancelled.
///
/// The server never ends an attach on its own; the client does, when the
/// environment reconnects under a new generation or the thread's route is gone
/// for a moment. Stopping there left the view looking live while no output
/// arrived, so the view attaches again. Attaches that end right away back off,
/// so a missing route never becomes a busy loop.
enum TerminalReattach: Equatable {
    /// Leave the terminal detached; the error bar offers Retry.
    case stay
    case reattach(after: Duration)

    /// An attach that stayed up at least this long was healthy, and the next
    /// drop starts the backoff over.
    static let healthyAttachDuration: Duration = .seconds(10)
    static let maximumDelay: Duration = .seconds(15)

    /// - Parameters:
    ///   - state: The terminal's state when the stream ended.
    ///   - attempt: Reattaches in a row since the last healthy attach.
    static func decision(state: FeatureTerminalState?, attempt: Int) -> Self {
        // A failed attach already says why and offers Retry; trying again on
        // a timer would keep replacing that message with the same failure.
        if state == .failed { return .stay }
        return .reattach(after: delay(attempt: attempt))
    }

    /// Half a second, then doubling up to `maximumDelay`.
    static func delay(attempt: Int) -> Duration {
        let milliseconds = 500 * (1 << min(max(attempt, 0), 5))
        return min(.milliseconds(milliseconds), maximumDelay)
    }

    /// The attempt count for the next reattach, given how long the stream that
    /// just ended stayed attached.
    static func nextAttempt(after attempt: Int, attachedFor duration: Duration) -> Int {
        duration >= healthyAttachDuration ? 0 : attempt + 1
    }
}
