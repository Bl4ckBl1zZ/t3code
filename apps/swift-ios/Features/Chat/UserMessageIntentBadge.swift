import Foundation

// Ported from apps/mobile/src/features/threads/userMessageIntentBadge.ts.
// Input intent is metadata, so it reads as quiet text beside the timestamp
// rather than a coloured badge.
public struct UserMessageIntentBadge: Equatable, Sendable {
    public let label: String
    public let accessibilityLabel: String

    /// Returns nil for a message that simply started its turn — the common case
    /// needs no annotation.
    public static func resolve(
        _ intent: OrchestrationV2UserMessageInputIntent?
    ) -> UserMessageIntentBadge? {
        switch intent {
        case .queuedTurn:
            UserMessageIntentBadge(
                label: "queued",
                accessibilityLabel: "Queued behind the active turn"
            )
        case .steer:
            UserMessageIntentBadge(
                label: "steered the run",
                accessibilityLabel: "Steered the active turn"
            )
        case .promotedQueuedToSteer:
            UserMessageIntentBadge(
                label: "queued → steered the run",
                accessibilityLabel: "Originally queued, then promoted to steer the active turn"
            )
        case .turnStart, .unknown, nil:
            nil
        }
    }
}
