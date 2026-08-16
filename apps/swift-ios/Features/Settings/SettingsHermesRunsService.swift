import Foundation

// Ported from packages/contracts/src/hermesProactive.ts and the section
// apps/web/src/components/settings/HermesCronSettings.tsx renders.
//
// Hermes owns its own scheduler, and a scheduled run executes in its own
// short-lived session rather than in a thread T3 is subscribed to. These are the
// runs the server noticed by watching the schedule, carrying how each one ended
// — which for a failing job is the only place that failure surfaces.

public enum FeatureHermesRunStatus: String, Sendable, Equatable, CaseIterable {
    case unread
    case read
    case dismissed
}

public struct FeatureHermesRun: Identifiable, Sendable, Equatable {
    public let id: String
    public var title: String
    public var body: String
    /// `nil` when the gateway never named the session the job runs in, which
    /// the pinned Hermes protocol allows. Such a row reports the run but has no
    /// thread to open.
    public var threadID: String?
    public var status: FeatureHermesRunStatus
    /// ISO-8601, echoed rather than parsed on the way in so the row shows
    /// exactly the instant the server reported.
    public var createdAt: String

    public init(
        id: String,
        title: String,
        body: String,
        threadID: String? = nil,
        status: FeatureHermesRunStatus,
        createdAt: String
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.threadID = threadID
        self.status = status
        self.createdAt = createdAt
    }

    public var isUnread: Bool { status == .unread }
}

public struct FeatureHermesInbox: Sendable, Equatable {
    public var runs: [FeatureHermesRun]
    public var unreadCount: Int
    public var deadLetterCount: Int

    public init(runs: [FeatureHermesRun] = [], unreadCount: Int = 0, deadLetterCount: Int = 0) {
        self.runs = runs
        self.unreadCount = unreadCount
        self.deadLetterCount = deadLetterCount
    }

    public static let empty = FeatureHermesInbox()

    /// Dismissed rows are hidden by default but never deleted, so the screen can
    /// offer them back rather than making Dismiss a one-way door.
    public func visibleRuns(includingDismissed: Bool) -> [FeatureHermesRun] {
        includingDismissed ? runs : runs.filter { $0.status != .dismissed }
    }

    public var dismissedCount: Int {
        runs.count { $0.status == .dismissed }
    }

    public var unreadIDs: [String] {
        runs.filter(\.isUnread).map(\.id)
    }
}

/// The inbox is environment state: two paired servers reach different Hermes
/// gateways, so every call names the environment it acts on.
@MainActor
public protocol FeatureHermesInboxManaging: AnyObject {
    /// Emits the current inbox immediately, then again after every change.
    /// A stream rather than a fetch because the whole point of the feature is
    /// work arriving while nobody asked for it.
    func hermesInboxUpdates(
        environmentID: String
    ) async -> AsyncThrowingStream<FeatureHermesInbox, Error>

    func markHermesRuns(
        environmentID: String,
        ids: [String],
        status: FeatureHermesRunStatus
    ) async throws -> FeatureHermesInbox
}

@MainActor
final class EmptyFeatureHermesInboxManager: FeatureHermesInboxManaging {
    static let shared = EmptyFeatureHermesInboxManager()

    private init() {}

    func hermesInboxUpdates(
        environmentID _: String
    ) async -> AsyncThrowingStream<FeatureHermesInbox, Error> {
        // Finishes rather than hanging, so the screen settles on its empty state
        // instead of spinning forever against a client without the capability.
        AsyncThrowingStream { $0.finish() }
    }

    func markHermesRuns(
        environmentID _: String,
        ids _: [String],
        status _: FeatureHermesRunStatus
    ) async throws -> FeatureHermesInbox {
        throw FeatureCapabilityUnavailable("Hermes runs")
    }
}

// MARK: - Labels

/// Pure formatting for the run rows, kept out of the view so the strings the
/// screen promises are testable without rendering it.
public enum HermesRunLabels {
    private static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let fallbackParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    public static func date(from iso: String) -> Date? {
        parser.date(from: iso) ?? fallbackParser.date(from: iso)
    }

    /// "2h ago" style, falling back to the raw instant when the server sends
    /// something this build cannot parse — a row with an odd timestamp is still
    /// worth showing.
    public static func relativeTime(_ iso: String, now: Date) -> String {
        guard let date = date(from: iso) else { return iso }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: now)
    }

    public static func accessibilityStatus(_ status: FeatureHermesRunStatus) -> String {
        switch status {
        case .unread: "Unread"
        case .read: "Read"
        case .dismissed: "Dismissed"
        }
    }

    /// What the row's leading action does next. Both directions are offered so
    /// a run marked read by accident can be put back.
    public static func readToggleTitle(_ status: FeatureHermesRunStatus) -> String {
        status == .unread ? "Mark Read" : "Mark Unread"
    }

    public static func readToggleTarget(_ status: FeatureHermesRunStatus) -> FeatureHermesRunStatus {
        status == .unread ? .read : .unread
    }

    public static func dismissToggleTitle(_ status: FeatureHermesRunStatus) -> String {
        status == .dismissed ? "Restore" : "Dismiss"
    }

    public static func dismissToggleTarget(
        _ status: FeatureHermesRunStatus
    ) -> FeatureHermesRunStatus {
        status == .dismissed ? .read : .dismissed
    }

    public static func badgeText(unreadCount: Int) -> String? {
        guard unreadCount > 0 else { return nil }
        // A three-digit badge would push the row's title out of the way, and the
        // exact number stops being useful long before that.
        return unreadCount > 99 ? "99+" : String(unreadCount)
    }

    public static func deadLetterWarning(count: Int) -> String? {
        guard count > 0 else { return nil }
        return count == 1
            ? "1 notification could not be delivered and was given up on."
            : "\(count) notifications could not be delivered and were given up on."
    }
}
