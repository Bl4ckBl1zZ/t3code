import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  codexUsageLimits,
  claudeUsageLimits,
  applyClaudeRateLimitEvent,
  applyCodexRateLimitEvent,
  usageLimitsAfterProbe,
} from "./providerUsageLimits.ts";

const decodeLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);
const checkedAt = "2026-09-06T00:00:00.000Z";
describe("provider subscription limits", () => {
  it("maps available reset credits and preserves them across live window updates", () => {
    const snapshot = codexUsageLimits({ primary: { usedPercent: 90 } }, checkedAt, {
      availableCount: 2,
      credits: [
        { status: "used", expiresAt: 1 },
        { status: "available", expiresAt: 1788652800 },
        { status: "available", expiresAt: 1788652900 },
      ],
    });
    expect(snapshot.resetCredits).toEqual({
      availableCount: 2,
      nextExpiresAt: "2026-09-06T00:00:00.000Z",
    });
    expect(decodeLimits(snapshot)).toEqual(snapshot);
    expect(
      applyCodexRateLimitEvent(snapshot, { primary: { usedPercent: 95 } }, checkedAt)?.resetCredits,
    ).toEqual(snapshot.resetCredits);
    expect(codexUsageLimits({}, checkedAt).resetCredits).toBeUndefined();
    expect(
      codexUsageLimits({}, checkedAt, { availableCount: 0 }).resetCredits?.availableCount,
    ).toBe(0);
  });
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

it("does not present model-specific Codex quotas as the main allowance", () => {
  const checkedAt = "2026-09-09T00:00:00.000Z";
  expect(
    codexUsageLimits({ limitId: "codex_spark", primary: { usedPercent: 90 } }, checkedAt).windows,
  ).toEqual([]);
  expect(
    codexUsageLimits({ limitId: "codex", primary: { usedPercent: 20 } }, checkedAt).windows[0]
      ?.usedPercent,
  ).toBe(20);
});

it("updates Claude live fractions without losing reset times, scoped identities or other windows", () => {
  const previous = {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session" as const,
        label: "Session",
        usedPercent: 20,
        resetsAt: "2026-09-06T03:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        id: "seven_day_fable",
        kind: "weekly" as const,
        label: "Weekly · Fable",
        usedPercent: 30,
        windowDurationMins: 10080,
      },
    ],
  };
  const update = applyClaudeRateLimitEvent(
    previous,
    { status: "allowed", rateLimitType: "seven_day_overage_included", utilization: 0.5 },
    "2026-09-06T01:00:00.000Z",
  );
  expect(update?.windows.map((w) => [w.id, w.usedPercent])).toEqual([
    ["five_hour", 20],
    ["seven_day_fable", 50],
  ]);
  expect(update?.windows[1]?.label).toBe("Weekly · Fable");
  expect(
    applyClaudeRateLimitEvent(
      update,
      { status: "allowed", rateLimitType: "seven_day_overage_included", utilization: 0.5 },
      checkedAt,
    ),
  ).toBe(update);
  expect(
    applyClaudeRateLimitEvent(
      previous,
      { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 },
      checkedAt,
    )?.windows[0]?.resetsAt,
  ).toBe(previous.windows[0]?.resetsAt);
  expect(decodeLimits(update)).toEqual(update);
});

it("does not invent unknown model buckets or turn unsupported accounts into quota bars", () => {
  const unavailable = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
  const scoped = {
    status: "allowed" as const,
    rateLimitType: "seven_day_overage_included" as const,
    utilization: 0.5,
  };
  expect(applyClaudeRateLimitEvent(undefined, scoped, checkedAt)).toBeUndefined();
  expect(
    applyClaudeRateLimitEvent(
      unavailable,
      { status: "allowed", rateLimitType: "five_hour", utilization: 0.5 },
      checkedAt,
    ),
  ).toBe(unavailable);
  expect(
    applyClaudeRateLimitEvent(
      undefined,
      { status: "allowed", rateLimitType: "five_hour", utilization: Number.NaN },
      checkedAt,
    ),
  ).toBeUndefined();
});

it("keeps live usage across stale or failed probes, while unsupported remains authoritative", () => {
  const current = { checkedAt: "2026-09-06T01:00:00.000Z", windows: [] };
  expect(usageLimitsAfterProbe(current, { checkedAt, windows: [] })).toBe(current);
  expect(
    usageLimitsAfterProbe(current, {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    }),
  ).toBe(current);
  const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
  expect(usageLimitsAfterProbe(current, unsupported)).toBe(unsupported);
});

it("keeps the probe's first model-scoped bucket stable across successive live updates", () => {
  const previous = {
    checkedAt,
    windows: [
      { id: "seven_day_zeta", kind: "weekly" as const, label: "Weekly · Zeta", usedPercent: 10 },
      { id: "seven_day_alpha", kind: "weekly" as const, label: "Weekly · Alpha", usedPercent: 20 },
    ],
  };
  const first = applyClaudeRateLimitEvent(
    previous,
    { status: "allowed", rateLimitType: "seven_day_overage_included", utilization: 0.5 },
    checkedAt,
  );
  const second = applyClaudeRateLimitEvent(
    first,
    { status: "allowed", rateLimitType: "seven_day_overage_included", utilization: 0.6 },
    checkedAt,
  );
  expect(second?.windows.map((w) => [w.id, w.usedPercent])).toEqual([
    ["seven_day_zeta", 60],
    ["seven_day_alpha", 20],
  ]);
});

it("merges live Codex windows without replacing monthly semantics, reset times or other quotas", () => {
  const previous = codexUsageLimits(
    {
      planType: "free",
      primary: { usedPercent: 20, resetsAt: 1788652800 },
      secondary: { usedPercent: 30 },
    },
    checkedAt,
  );
  const updated = applyCodexRateLimitEvent(previous, { primary: { usedPercent: 40 } }, checkedAt);
  expect(updated?.windows[0]).toMatchObject({
    kind: "monthly",
    usedPercent: 40,
    resetsAt: previous.windows[0]?.resetsAt,
    windowDurationMins: 43200,
  });
  expect(updated?.windows[1]).toEqual(previous.windows[1]);
  expect(applyCodexRateLimitEvent(updated, { primary: { usedPercent: 40 } }, checkedAt)).toBe(
    updated,
  );
  expect(
    applyCodexRateLimitEvent(
      updated,
      { limitId: "codex_spark", primary: { usedPercent: 99 } },
      checkedAt,
    ),
  ).toBe(updated);
  expect(decodeLimits(updated)).toEqual(updated);
});
