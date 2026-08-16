import { describe, expect, it } from "@effect/vitest";

import { mergeSubagentUsage, usageReportingForDriver } from "./SubagentUsage.ts";

describe("mergeSubagentUsage", () => {
  it("sums delta reports into a cumulative rollup", () => {
    const merged = mergeSubagentUsage(
      { totalTokens: 100, inputTokens: 60, outputTokens: 40, toolUses: 1 },
      { totalTokens: 50, inputTokens: 30, outputTokens: 20, toolUses: 2 },
      "delta",
    );
    expect(merged.totalTokens).toBe(150);
    expect(merged.inputTokens).toBe(90);
    expect(merged.outputTokens).toBe(60);
    expect(merged.toolUses).toBe(3);
  });

  it("replaces rather than sums for cumulative reporters", () => {
    // Summing a cumulative total would multiply the real figure by the number
    // of updates -- the bug this distinction exists to prevent.
    const merged = mergeSubagentUsage(
      { totalTokens: 100, inputTokens: 60 },
      { totalTokens: 150, inputTokens: 90 },
      "cumulative",
    );
    expect(merged.totalTokens).toBe(150);
    expect(merged.inputTokens).toBe(90);
  });

  it("takes the first report as-is regardless of reporting mode", () => {
    const merged = mergeSubagentUsage(undefined, { totalTokens: 42 }, "delta");
    expect(merged.totalTokens).toBe(42);
  });

  it("keeps an unreported field absent instead of turning it into zero", () => {
    const merged = mergeSubagentUsage({ totalTokens: 10 }, { totalTokens: 5 }, "delta");
    expect(merged.totalTokens).toBe(15);
    // Neither side reported these; they must not materialize as 0.
    expect(merged.inputTokens).toBeUndefined();
    expect(merged.cachedInputTokens).toBeUndefined();
    expect(merged.durationMs).toBeUndefined();
  });

  it("carries a field forward when only one side reports it", () => {
    const merged = mergeSubagentUsage(
      { totalTokens: 10, inputTokens: 8 },
      { totalTokens: 5 },
      "delta",
    );
    expect(merged.inputTokens).toBe(8);

    const other = mergeSubagentUsage(
      { totalTokens: 10 },
      { totalTokens: 5, outputTokens: 3 },
      "delta",
    );
    expect(other.outputTokens).toBe(3);
  });

  it("treats durationMs as wall-clock, not an accumulating cost", () => {
    const merged = mergeSubagentUsage(
      { totalTokens: 10, durationMs: 1000 },
      { totalTokens: 5, durationMs: 2500 },
      "delta",
    );
    expect(merged.durationMs).toBe(2500);
  });

  it("keeps the previous duration when the newest report omits it", () => {
    const merged = mergeSubagentUsage(
      { totalTokens: 10, durationMs: 1000 },
      { totalTokens: 5 },
      "delta",
    );
    expect(merged.durationMs).toBe(1000);
  });
});

describe("usageReportingForDriver", () => {
  it("marks claude as a delta reporter and everything else cumulative", () => {
    expect(usageReportingForDriver("claude")).toBe("delta");
    expect(usageReportingForDriver("codex")).toBe("cumulative");
    expect(usageReportingForDriver("cursor")).toBe("cumulative");
  });
});
