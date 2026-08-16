import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";

// Input intent is metadata, so it reads as quiet text alongside the timestamp
// rather than a colored badge.
export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
): UserMessageIntentBadgePresentation | null {
  switch (intent) {
    case "queued_turn":
      return {
        label: "queued",
        accessibilityLabel: "Queued behind the active turn",
      };
    case "steer":
      return {
        label: "steered the run",
        accessibilityLabel: "Steered the active turn",
      };
    case "promoted_queued_to_steer":
      return {
        label: "queued → steered the run",
        accessibilityLabel: "Originally queued, then promoted to steer the active turn",
      };
    case "turn_start":
    case undefined:
      return null;
  }
}
