import { describe, expect, it } from "vite-plus/test";
import type { ActivePlanState } from "~/session-logic";
import { deriveWorkingTreeBadgeState } from "./WorkingTreeStatusBadge.logic";

const plan = (statuses: ActivePlanState["steps"][number]["status"][]): ActivePlanState => ({
  createdAt: "2026-08-04T00:00:00.000Z",
  runId: "run_1" as ActivePlanState["runId"],
  explanation: null,
  steps: statuses.map((status, index) => ({ step: `step ${index + 1}`, status })),
});

const stats = { filesChanged: 106, insertions: 51490, deletions: 9837 };

describe("deriveWorkingTreeBadgeState", () => {
  it("returns null without stats", () => {
    expect(deriveWorkingTreeBadgeState({ plan: plan(["inProgress"]), stats: null })).toBeNull();
  });

  it("returns null when no files changed", () => {
    expect(
      deriveWorkingTreeBadgeState({
        plan: null,
        stats: { filesChanged: 0, insertions: 0, deletions: 0 },
      }),
    ).toBeNull();
  });

  it("shows stats without step info when there is no plan", () => {
    expect(deriveWorkingTreeBadgeState({ plan: null, stats })).toEqual({
      currentStep: null,
      totalSteps: null,
      ...stats,
    });
  });

  it("uses the in-progress step as the current step", () => {
    const state = deriveWorkingTreeBadgeState({
      plan: plan(["completed", "completed", "inProgress", "pending"]),
      stats,
    });
    expect(state?.currentStep).toBe(3);
    expect(state?.totalSteps).toBe(4);
  });

  it("falls back to the next pending step when nothing is running", () => {
    const state = deriveWorkingTreeBadgeState({
      plan: plan(["completed", "pending", "pending"]),
      stats,
    });
    expect(state?.currentStep).toBe(2);
  });

  it("caps the current step at the total when all steps are completed", () => {
    const state = deriveWorkingTreeBadgeState({
      plan: plan(["completed", "completed"]),
      stats,
    });
    expect(state?.currentStep).toBe(2);
    expect(state?.totalSteps).toBe(2);
  });
});
