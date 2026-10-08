import Foundation

/// How long a finished agent ran, for tight rows such as Lineage. Mirrors
/// `formatCompactElapsedSeconds` and `hasAgentElapsed` in
/// apps/web/src/components/chat/AgentElapsed.tsx, for settled agents only:
/// a running row keeps its status and Stop rather than a ticking clock.
enum AgentElapsed {
    /// "45s", "12m", "1.5h", "14h". Rounds down.
    static func compact(seconds totalSeconds: Double) -> String {
        let seconds = max(0, Int(totalSeconds.rounded(.down)))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        if minutes >= 600 { return "\(minutes / 60)h" }
        let tenths = minutes / 6
        return tenths % 10 == 0 ? "\(tenths / 10)h" : "\(tenths / 10).\(tenths % 10)h"
    }

    /// The elapsed label for a settled agent, or nil while it is live, when it
    /// failed (the row says "Failed" instead), or when either time is unknown.
    static func settledLabel(status: String, startedAt: String?, completedAt: String?) -> String? {
        guard !["pending", "running", "waiting", "failed", "error"].contains(status),
              let start = date(startedAt), let end = date(completedAt) else { return nil }
        return compact(seconds: end.timeIntervalSince(start))
    }

    private static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return fractionalParser.date(from: value) ?? plainParser.date(from: value)
    }

    private static let fractionalParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainParser = ISO8601DateFormatter()
}
