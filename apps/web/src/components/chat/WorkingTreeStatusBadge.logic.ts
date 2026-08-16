import type { ActivePlanState } from "~/session-logic";

export interface WorkingTreeBadgeStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface WorkingTreeBadgeState {
  currentStep: number | null;
  totalSteps: number | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export function deriveWorkingTreeBadgeState(input: {
  plan: ActivePlanState | null;
  stats: WorkingTreeBadgeStats | null;
}): WorkingTreeBadgeState | null {
  const { plan, stats } = input;
  if (stats === null || stats.filesChanged === 0) return null;
  let currentStep: number | null = null;
  let totalSteps: number | null = null;
  if (plan !== null && plan.steps.length > 0) {
    totalSteps = plan.steps.length;
    const inProgressIndex = plan.steps.findIndex((step) => step.status === "inProgress");
    if (inProgressIndex >= 0) {
      currentStep = inProgressIndex + 1;
    } else {
      const completed = plan.steps.filter((step) => step.status === "completed").length;
      // No step is actively running: show the next pending step, capped at the total.
      currentStep = Math.min(completed + 1, totalSteps);
    }
  }
  return {
    currentStep,
    totalSteps,
    filesChanged: stats.filesChanged,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}
