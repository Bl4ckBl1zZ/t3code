import { describe, expect, it } from "vite-plus/test";

import {
  formatTaskUsage,
  formatTokenCount,
  workflowPhaseProgress,
} from "./workflowObservability.ts";

describe("workflowPhaseProgress", () => {
  it("returns null when no phases were declared", () => {
    expect(workflowPhaseProgress(undefined)).toBeNull();
    expect(workflowPhaseProgress({ phases: [] })).toBeNull();
  });

  it("resolves position by title", () => {
    const progress = workflowPhaseProgress({
      phases: [
        { index: 0, title: "Scan" },
        { index: 1, title: "Fix" },
        { index: 2, title: "Verify" },
      ],
      currentPhase: "Fix",
    });
    expect(progress).toEqual({ current: 2, total: 3 });
  });

  it("reports progress running backwards when a script revisits a phase", () => {
    // Honest over monotonic: the workflow really is back in phase 1.
    const progress = workflowPhaseProgress({
      phases: [
        { index: 0, title: "Scan" },
        { index: 1, title: "Fix" },
      ],
      currentPhase: "Scan",
    });
    expect(progress).toEqual({ current: 1, total: 2 });
  });

  it("counts an undeclared current phase as started rather than dropping it", () => {
    const progress = workflowPhaseProgress({
      phases: [{ index: 0, title: "Scan" }],
      currentPhase: "Improvised",
    });
    expect(progress).toEqual({ current: 1, total: 1 });
  });

  it("reports zero progress before any phase is entered", () => {
    expect(workflowPhaseProgress({ phases: [{ index: 0, title: "Scan" }] })).toEqual({
      current: 0,
      total: 1,
    });
  });
});

describe("formatTokenCount", () => {
  it("keeps small counts exact", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("compacts thousands and millions", () => {
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(45_000)).toBe("45k");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});

describe("formatTaskUsage", () => {
  it("omits the readout when the task reported no usage", () => {
    expect(formatTaskUsage(undefined)).toBeNull();
  });

  it("leaves unreported tool uses out instead of showing zero", () => {
    expect(formatTaskUsage({ totalTokens: 12_400 })).toBe("12k tok");
    expect(formatTaskUsage({ totalTokens: 900, toolUses: 1 })).toBe("900 tok · 1 tool");
    expect(formatTaskUsage({ totalTokens: 900, toolUses: 0 })).toBe("900 tok · 0 tools");
  });
});
