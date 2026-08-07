/**
 * Presentation helpers for workflow observability, shared by web and mobile.
 *
 * These live here rather than in either app because both surfaces render the
 * same facts and must agree about them: a phase counter that means one thing
 * on desktop and another on a phone is worse than no counter.
 */
import type { OrchestrationV2WorkflowProgress } from "@t3tools/contracts";

export interface WorkflowPhaseProgress {
  readonly current: number;
  readonly total: number;
}

/**
 * Phase progress as a "3/7" style pair. Returns null when the script declared
 * no phases, so callers omit the indicator rather than rendering "0/0".
 *
 * Position resolves by title rather than by tracking the furthest phase
 * reached. A workflow script may skip a phase or revisit an earlier one, and
 * showing progress move backwards is more honest than pinning it at a
 * high-water mark that no longer describes what is running.
 */
export function workflowPhaseProgress(
  workflow: OrchestrationV2WorkflowProgress | undefined,
): WorkflowPhaseProgress | null {
  if (workflow === undefined || workflow.phases.length === 0) return null;
  const total = workflow.phases.length;
  if (workflow.currentPhase === undefined) return { current: 0, total };
  const index = workflow.phases.findIndex((phase) => phase.title === workflow.currentPhase);
  // An unrecognized current phase means the script entered a phase it never
  // declared in meta.phases; count it as started rather than dropping the
  // indicator entirely.
  return { current: index === -1 ? 1 : index + 1, total };
}

/** Compact token count: 1234 -> "1.2k". Exact below 1000. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  const millions = tokens / 1_000_000;
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`;
}
