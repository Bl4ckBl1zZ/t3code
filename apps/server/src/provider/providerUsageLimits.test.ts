import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerProviderUsageLimits } from "@t3tools/contracts";
import { codexUsageLimits, claudeUsageLimits } from "./providerUsageLimits.ts";

const decodeLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);
const checkedAt = "2026-09-06T00:00:00.000Z";
describe("provider subscription limits", () => {
  it("normalizes Codex windows, clamping percentages and rejecting invalid durations", () => {
    const limits = codexUsageLimits(
      {
        primary: { usedPercent: 125, resetsAt: 1788652800, windowDurationMins: -1 },
        secondary: { usedPercent: Number.NaN },
      },
      checkedAt,
    );
    expect(limits.windows).toHaveLength(1);
    expect(limits.windows[0]).toMatchObject({
      usedPercent: 100,
      windowDurationMins: 300,
      kind: "session",
    });
    expect(decodeLimits(limits)).toEqual(limits);
  });
  it("recognizes monthly free plans and explicit weekly durations", () => {
    expect(
      codexUsageLimits({ planType: "free", primary: { usedPercent: 3 } }, checkedAt).windows[0]
        ?.kind,
    ).toBe("monthly");
    expect(
      codexUsageLimits({ primary: { usedPercent: 3, windowDurationMins: 10080 } }, checkedAt)
        .windows[0]?.kind,
    ).toBe("weekly");
  });
  it("does not represent unsupported Claude accounts as unused quota", () => {
    expect(
      claudeUsageLimits({ rate_limits_available: false, rate_limits: null }, checkedAt),
    ).toMatchObject({ windows: [], unavailable: { reason: "unsupported" } });
  });
  it("reads Claude percentages without multiplying them and drops malformed windows", () => {
    const limits = claudeUsageLimits(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: "2026-09-06T03:00:00Z" },
          seven_day: { utilization: Number.NaN, resets_at: null },
        },
      },
      checkedAt,
    );
    expect(limits.windows).toHaveLength(1);
    expect(limits.windows[0]?.usedPercent).toBe(42);
    expect(decodeLimits(limits)).toEqual(limits);
  });
});
