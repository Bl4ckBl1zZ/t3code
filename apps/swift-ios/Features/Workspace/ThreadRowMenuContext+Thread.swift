import Foundation

extension ThreadRowMenuContext {
    /// The menu facts for one thread, shared by the Home row's long press and
    /// the chat's Thread Actions menu so both offer the same actions under the
    /// same rules.
    init(
        thread: FeatureThread,
        isArchived: Bool,
        offersParking: Bool,
        now: Date,
        changeRequest: FeaturePullRequest?,
        isGeneratingHandoffScript: Bool = false
    ) {
        self.init(
            isArchived: isArchived,
            canTogglePin: thread.canTogglePin,
            isPinned: thread.pinnedAt != nil,
            isSettled: thread.canShelveSettled && thread.isEffectivelySettled(
                at: now,
                changeRequest: changeRequest
            ),
            isSnoozed: thread.canShelveSnoozed && thread.isEffectivelySnoozed(at: now),
            canSnooze: thread.state != .queued
                && thread.state != .waitingForApproval
                && thread.state != .waitingForInput,
            offersParking: offersParking,
            settlementSupported: thread.canShelveSettled,
            snoozeSupported: thread.canShelveSnoozed,
            autoSettleSupported: thread.supportsAutoSettleOptOut == true,
            autoSettleEnabled: thread.autoSettleDisabledAt == nil,
            hasWorktreePath: ThreadCopy.value(for: .path, on: thread) != nil,
            hasBranch: ThreadCopy.value(for: .branch, on: thread) != nil,
            titleRegenerationSupported: thread.canRegenerateTitle,
            isRegeneratingTitle: thread.isRegeneratingTitle,
            canArchive: thread.canArchive,
            isGeneratingHandoffScript: isGeneratingHandoffScript,
            snoozedUntil: thread.snoozedUntil,
            canMarkUnread: thread.canMarkUnread,
            canMarkRead: thread.canMarkRead(at: now)
        )
    }
}
