import Foundation

// `thread.visit` and `thread.mark-unread` from packages/contracts
// orchestrationV2.ts. Only sent to servers reporting `threadVisitedTracking`.
extension OrchestrationCommands {
    /// Records that the viewer has seen the thread up to `visitedAt`. The
    /// server keeps the later of the stored and supplied watermark, so a stale
    /// or replayed visit cannot rewind it.
    public static func visit(
        threadID: String,
        visitedAt: Date,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("thread.visit"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
            "visitedAt": .string(millisecondTimestamp(visitedAt)),
        ])
    }

    /// Rewinds the visited watermark so the latest completion reads as unseen
    /// again on every device. The server refuses it on a thread with no
    /// completed run.
    public static func markUnread(
        threadID: String,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        .object([
            "type": .string("thread.mark-unread"),
            "commandId": .string(commandID),
            "threadId": .string(threadID),
        ])
    }

    /// ISO 8601 with milliseconds, rounded rather than truncated. A watermark
    /// echoes a server timestamp, and a `Date` parsed from "…00.123Z" can sit a
    /// hair under .123: truncating would land a millisecond before the state
    /// it marks as seen, leaving that completion unread.
    public static func millisecondTimestamp(_ date: Date) -> String {
        let milliseconds = (date.timeIntervalSince1970 * 1000).rounded()
        let wholeSeconds = (milliseconds / 1000).rounded(.down)
        let fraction = Int(milliseconds - wholeSeconds * 1000)
        let base = wholeSecondFormatter.string(from: Date(timeIntervalSince1970: wholeSeconds))
        return String(base.dropLast()) + String(format: ".%03dZ", fraction)
    }

    private static let wholeSecondFormatter = ISO8601DateFormatter()
}
