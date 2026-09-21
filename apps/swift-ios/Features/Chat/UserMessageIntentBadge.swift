import Foundation

// Ported from apps/mobile/src/features/threads/userMessageIntentBadge.ts.
// Input intent is metadata, so it reads as a quiet caption under the bubble
// rather than a coloured badge.
public struct UserMessageIntentBadge: Equatable, Sendable {
    public let label: String
    public let accessibilityLabel: String
    public let systemImage: String

    /// Returns nil for a message that simply started its turn — the common case
    /// needs no annotation.
    public static func resolve(
        _ intent: OrchestrationV2UserMessageInputIntent?
    ) -> UserMessageIntentBadge? {
        switch intent {
        case .queuedTurn:
            UserMessageIntentBadge(
                label: "Queued",
                accessibilityLabel: "Queued behind the active turn",
                systemImage: "hourglass"
            )
        case .steer:
            UserMessageIntentBadge(
                label: "Steered the run",
                accessibilityLabel: "Steered the active turn",
                systemImage: "bolt"
            )
        case .promotedQueuedToSteer:
            UserMessageIntentBadge(
                label: "Queued, then steered",
                accessibilityLabel: "Originally queued, then promoted to steer the active turn",
                systemImage: "bolt"
            )
        case .turnStart, .unknown, nil:
            nil
        }
    }
}
