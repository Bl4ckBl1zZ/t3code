import { describe, expect, it } from "vite-plus/test";
import { hermesThreadScheduleSummary } from "./HermesThreadDetailsPanel.logic";

describe("Hermes thread schedule summaries", () => {
  it("does not promise another execution for a paused job with an old next-run timestamp", () => {
    const summary = hermesThreadScheduleSummary({
      paused: true,
      nextRunAt: "2026-09-15T10:00:00Z",
      lastStatus: "failed",
    });
    expect(summary.timing).toBe("Paused");
    expect(summary.outcome).toBe("Last run: failed");
  });

  it("does not invent a next run or successful outcome when native details are missing", () => {
    const summary = hermesThreadScheduleSummary({
      paused: false,
      nextRunAt: null,
      lastStatus: null,
    });
    expect(summary.timing).toBe("Next run not reported");
    expect(summary.outcome).toBeNull();
  });

  it("keeps malformed native dates out of the displayed schedule", () => {
    expect(
      hermesThreadScheduleSummary({
        paused: false,
        nextRunAt: "unknown",
        lastStatus: "delivery_failed",
      }),
    ).toMatchObject({ timing: "Next run not reported", outcome: "Last run: delivery failed" });
  });
});
