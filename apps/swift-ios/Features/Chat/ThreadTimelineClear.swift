import Foundation

/// T3 Work's `/clear` keeps the thread and stamps `timelineClearedAt` on it.
/// Ported from `deriveMessagesTimelineRows` in
/// apps/web/src/components/chat/MessagesTimeline.logic.ts: everything that
/// started at or before the stamp leaves the transcript, and a "Chat cleared"
/// divider takes its place.
enum ThreadTimelineClear {
    /// Whether something that happened at `date` is behind the clear. An
    /// undated item stays, as on web, where an unparsable time never compares.
    static func hides(_ date: Date?, clearedAt: Date?) -> Bool {
        guard let clearedAt, let date else { return false }
        return date <= clearedAt
    }

    /// The items and messages still on screen after a clear, in their order.
    /// An item is dated the way the feed dates it: when it started, else when
    /// it last changed.
    static func visible(
        timelineItems: [OrchestrationV2ProjectedTurnItem],
        messages: [FeatureMessage],
        clearedAt: Date?
    ) -> (timelineItems: [OrchestrationV2ProjectedTurnItem], messages: [FeatureMessage]) {
        guard clearedAt != nil else { return (timelineItems, messages) }
        return (
            timelineItems.filter { !hides(itemDate($0.item), clearedAt: clearedAt) },
            messages.filter { !hides($0.createdAt, clearedAt: clearedAt) }
        )
    }

    /// Paging stops at the clear: once the oldest loaded item is behind it,
    /// everything older would be hidden too, so asking for it only spins.
    static func canLoadEarlier(_ detail: FeatureThreadDetail) -> Bool {
        guard detail.page?.hasMore == true else { return false }
        guard let clearedAt = detail.thread.timelineClearedAt,
              let oldest = detail.timelineItems.first else { return true }
        return !hides(itemDate(oldest.item), clearedAt: clearedAt)
    }

    private static func itemDate(_ item: OrchestrationV2TurnItem) -> Date? {
        ThreadTimelineDay.date(fromISO8601: item.base.startedAt ?? item.base.updatedAt)
    }
}
