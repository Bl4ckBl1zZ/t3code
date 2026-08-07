/**
 * Usage accumulation for the Agents surface.
 *
 * Drivers disagree about what a usage report means. Claude emits a delta per
 * activation, so the running total is a sum. Codex emits the cumulative total
 * so far, so the running total is a replacement — summing it would multiply
 * the real number by the update count. Normalizing here means every rollup
 * that leaves the server is cumulative, and clients never need to know which
 * driver produced it.
 *
 * @module SubagentUsage
 */
import type { OrchestrationV2TaskUsage } from "@t3tools/contracts";

/**
 * How a driver reports usage. Keyed off the driver at the call site rather
 * than sniffed from the numbers: a delta that happens to be monotonically
 * increasing is indistinguishable from a cumulative total.
 */
export type SubagentUsageReporting = "delta" | "cumulative";

type UsageField = keyof OrchestrationV2TaskUsage;

const OPTIONAL_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "toolUses",
] as const satisfies ReadonlyArray<UsageField>;

/**
 * Merge one usage report into the running rollup.
 *
 * Absent fields are preserved as absent rather than coerced to zero: "this
 * driver does not report cached input tokens" and "this task used zero cached
 * input tokens" are different facts, and the UI renders them differently.
 *
 * `durationMs` is always taken from the newest report rather than summed —
 * it is wall-clock for the task, not a per-activation cost.
 */
export function mergeSubagentUsage(
  previous: OrchestrationV2TaskUsage | undefined,
  incoming: OrchestrationV2TaskUsage,
  reporting: SubagentUsageReporting,
): OrchestrationV2TaskUsage {
  if (previous === undefined || reporting === "cumulative") {
    return incoming;
  }

  const merged: {
    -readonly [K in UsageField]?: OrchestrationV2TaskUsage[K];
  } = {
    totalTokens: previous.totalTokens + incoming.totalTokens,
  };

  for (const field of OPTIONAL_FIELDS) {
    const before = previous[field];
    const next = incoming[field];
    // Only one side reporting still yields a usable running total; neither
    // side reporting must stay unset.
    if (before === undefined && next === undefined) continue;
    merged[field] = (before ?? 0) + (next ?? 0);
  }

  const durationMs = incoming.durationMs ?? previous.durationMs;
  if (durationMs !== undefined) {
    merged.durationMs = durationMs;
  }

  return merged as OrchestrationV2TaskUsage;
}

/**
 * Claude reports per-activation deltas; every other driver we ingest reports
 * cumulative totals. Centralized so a new driver is a one-line decision here
 * instead of a guess at each call site.
 */
export function usageReportingForDriver(driver: string): SubagentUsageReporting {
  return driver === "claude" ? "delta" : "cumulative";
}
