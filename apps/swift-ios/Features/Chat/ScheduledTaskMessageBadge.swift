import Foundation

// Ported from apps/mobile/src/features/threads/scheduledTaskMessageBadge.ts.

/// Scheduler-initiated user messages carry no dedicated input intent; the only
/// stable marker is the message id the scheduler mints
/// (`scheduled-task-message:<fireKey>` — see ScheduledTaskService). Keying off
/// that prefix lets the feed badge automation-fired prompts without a contract
/// change.
public enum ScheduledTaskMessageBadge {
    private static let messageIDPrefix = "scheduled-task-message:"

    public static func isScheduledTaskMessageID(_ messageID: String) -> Bool {
        messageID.hasPrefix(messageIDPrefix)
    }
}
