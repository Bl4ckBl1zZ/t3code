import Foundation

// Ported from apps/mobile/src/features/threads/threadActivityFileNavigation.ts.

/// The route a file link in the activity inspector opens.
public struct ThreadActivityFileRoute: Equatable, Sendable {
    public let environmentID: String
    public let threadID: String
    /// Path segments, so the route can escape each one independently.
    public let path: [String]
    /// Absent unless the link points at a specific line.
    public let line: String?

    /// - Parameter activitySourceThreadID: Deliberately unused. Activity
    ///   provenance may come from a parent thread, but file routes stay scoped
    ///   to the thread whose workspace is currently selected, so the caller
    ///   passing provenance sees it discarded here rather than guessing.
    public static func build(
        environmentID: String,
        currentThreadID: String,
        activitySourceThreadID: String,
        relativePath: String,
        line: Int? = nil
    ) -> ThreadActivityFileRoute {
        let resolvedLine: String? = if let line, line > 0 { String(line) } else { nil }
        return ThreadActivityFileRoute(
            environmentID: environmentID,
            threadID: currentThreadID,
            // `split` drops empty segments, so a leading or doubled separator
            // does not produce a blank path component.
            path: relativePath.split(separator: "/").map(String.init),
            line: resolvedLine
        )
    }
}
