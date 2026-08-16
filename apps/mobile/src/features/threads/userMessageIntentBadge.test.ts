import { describe, expect, it } from "@effect/vitest";

import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";

describe("user message intent badge", () => {
  it("does not label ordinary turn-start messages", () => {
    expect(resolveUserMessageIntentBadge(undefined)).toBeNull();
    expect(resolveUserMessageIntentBadge("turn_start")).toBeNull();
  });

  it("labels messages waiting behind the active turn", () => {
    expect(resolveUserMessageIntentBadge("queued_turn")).toEqual({
      label: "queued",
      accessibilityLabel: "Queued behind the active turn",
    });
  });

  it("labels messages that steer the active turn", () => {
    expect(resolveUserMessageIntentBadge("steer")).toEqual({
      label: "steered the run",
      accessibilityLabel: "Steered the active turn",
    });
  });

  it("preserves the queued origin after promotion to steer", () => {
    expect(resolveUserMessageIntentBadge("promoted_queued_to_steer")).toEqual({
      label: "queued → steered the run",
      accessibilityLabel: "Originally queued, then promoted to steer the active turn",
    });
  });
});
