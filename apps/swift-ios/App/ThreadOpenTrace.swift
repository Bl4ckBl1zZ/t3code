import Foundation
import os

/// Times one thread open so first paint and time-to-live can be measured on a
/// device. Each milestone logs one `[conn] thread-open` line with the
/// milliseconds since the open began; `Scripts/connection-log-tally.sh`
/// captures them and summarizes each milestone. The open is also a
/// "thread-open" signpost interval, ending when the stream is live, for
/// Instruments.
struct ThreadOpenTrace {
    enum Milestone: String {
        /// Painted from the on-disk or in-memory cache; the stream resumes.
        case cacheHit = "cache-hit"
        /// Painted from a launch reply; the stream opens on a snapshot.
        case seeded
        /// Nothing cached; waiting on the HTTP snapshot.
        case cacheMiss = "cache-miss"
        /// Reopened while its stream was still kept alive.
        case keptAlive = "kept-alive"
        case firstPaint = "first-paint"
        /// The stream finished catching up.
        case live
    }

    private static let signposter = OSSignposter(logger: ConnectionLog.logger)

    let threadID: String
    private let start: ContinuousClock.Instant
    private let interval: OSSignpostIntervalState
    private var isLive = false

    init(threadID: String) {
        self.threadID = threadID
        start = .now
        interval = Self.signposter.beginInterval("thread-open")
    }

    func mark(_ milestone: Milestone) {
        let elapsed = ContinuousClock.now - start
        let milliseconds = elapsed.components.seconds * 1000
            + elapsed.components.attoseconds / 1_000_000_000_000_000
        ConnectionLog.logger.info(
            """
            [conn] thread-open \(milestone.rawValue, privacy: .public) \
            thread=\(threadID, privacy: .public) ms=\(milliseconds)
            """
        )
        Self.signposter.emitEvent("thread-open", "\(milestone.rawValue, privacy: .public)")
    }

    /// Logs `live` once and closes the signpost interval.
    mutating func markLive() {
        guard !isLive else { return }
        isLive = true
        mark(.live)
        Self.signposter.endInterval("thread-open", interval)
    }
}
