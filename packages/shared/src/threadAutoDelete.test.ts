import { describe, expect, it } from "vite-plus/test";

import { resolveAutoDeleteAtMs } from "./threadAutoDelete.ts";

const settled = {
  archivedAt: null,
  deletedAt: null,
  pinnedAt: null,
  settledOverride: "settled" as const,
  settledAt: "2026-01-01T00:00:00.000Z",
};

describe("resolveAutoDeleteAtMs", () => {
  it("counts from when the thread entered Settled, falling back to settledAt", () => {
    expect(resolveAutoDeleteAtMs(settled, 2)).toBe(Date.parse("2026-01-03T00:00:00.000Z"));
    expect(
      resolveAutoDeleteAtMs({ ...settled, settledRecordedAt: "2026-02-01T00:00:00.000Z" }, 2),
    ).toBe(Date.parse("2026-02-03T00:00:00.000Z"));
  });

  it("never schedules kept, active, or disabled threads", () => {
    expect(resolveAutoDeleteAtMs(settled, null)).toBeNull();
    expect(resolveAutoDeleteAtMs({ ...settled, pinnedAt: settled.settledAt }, 2)).toBeNull();
    expect(resolveAutoDeleteAtMs({ ...settled, archivedAt: settled.settledAt }, 2)).toBeNull();
    expect(resolveAutoDeleteAtMs({ ...settled, settledOverride: "active" }, 2)).toBeNull();
  });
});
