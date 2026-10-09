import { USAGE_CONTRACT_VERSION, UsageDay, type UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isUsageUpdating, usageEnvironmentProgress } from "./usageProgress.ts";

const SUMMARY: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-09-05T12:00:00Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-05"),
  untilDay: UsageDay.make("2026-09-05"),
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
};

function environment(
  overrides: Partial<{
    isConnected: boolean;
    isPending: boolean;
    error: string | null;
    summary: UsageSummary | null;
  }> = {},
) {
  return {
    isConnected: true,
    isPending: false,
    error: null as string | null,
    summary: SUMMARY as UsageSummary | null,
    ...overrides,
  };
}

describe("usageEnvironmentProgress", () => {
  it("separates first answers, refetches over old totals, and settled answers", () => {
    expect(usageEnvironmentProgress(environment({ summary: null, isPending: true }))).toBe(
      "loading",
    );
    expect(usageEnvironmentProgress(environment({ isPending: true }))).toBe("stale");
    expect(usageEnvironmentProgress(environment())).toBe("ready");
  });

  it("treats every answer as stale while a manual refresh runs", () => {
    // Pricing refreshes first, so the query is not pending yet.
    expect(usageEnvironmentProgress(environment(), true)).toBe("stale");
  });

  it("ignores reconnecting and failed environments", () => {
    expect(usageEnvironmentProgress(environment({ isPending: true, isConnected: false }))).toBe(
      "inactive",
    );
    expect(usageEnvironmentProgress(environment({ error: "Offline", summary: null }))).toBe(
      "inactive",
    );
  });
});

describe("isUsageUpdating", () => {
  it("is true while any environment has not answered or is answering again", () => {
    expect(isUsageUpdating([environment(), environment({ summary: null })])).toBe(true);
    expect(isUsageUpdating([environment(), environment({ isPending: true })])).toBe(true);
    expect(isUsageUpdating([environment(), environment()], true)).toBe(true);
  });

  it("settles once every environment that can answer has", () => {
    expect(
      isUsageUpdating([
        environment(),
        environment({ summary: null, isConnected: false }),
        environment({ summary: null, error: "Offline" }),
      ]),
    ).toBe(false);
  });
});
