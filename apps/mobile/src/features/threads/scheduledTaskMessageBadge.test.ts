import { describe, expect, it } from "@effect/vitest";

import { isScheduledTaskMessageId } from "./scheduledTaskMessageBadge";

describe("isScheduledTaskMessageId", () => {
  it("matches scheduler-minted message ids", () => {
    expect(isScheduledTaskMessageId("scheduled-task-message:task-1:2026-08-02T09:00")).toBe(true);
  });

  it("rejects ordinary message ids", () => {
    expect(isScheduledTaskMessageId("message:abc")).toBe(false);
    expect(isScheduledTaskMessageId("")).toBe(false);
    expect(isScheduledTaskMessageId("scheduled-task:task-1")).toBe(false);
  });
});
