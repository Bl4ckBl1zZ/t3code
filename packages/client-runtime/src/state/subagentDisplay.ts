import type { OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Summarizes one adjacent group, without changing its member identities or order. */
export function subagentGroupSummary(
  members: ReadonlyArray<{ readonly status: OrchestrationV2TurnItemStatus }>,
) {
  const active = members.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    label: `${active ? "Kicked off" : "Ran"} ${members.length} ${members.length === 1 ? "subagent" : "subagents"}`,
    active,
    failed: members.some(({ status }) => status === "failed"),
  };
}

/**
 * Counts a group's states in the order a reader scans them: what is still
 * running first, then outcomes.
 */
export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>,
): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (status === "pending" || status === "running" || status === "waiting") counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

/**
 * One elapsed span for a whole group: first launch to last settle, running
 * while any member works. A settled member without a completion time leaves
 * the end unknown, so the span is withheld rather than cut short.
 */
export function subagentGroupTiming(
  agents: ReadonlyArray<{
    readonly status: OrchestrationV2TurnItemStatus;
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
  }>,
): {
  readonly status: "running" | "completed";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
} {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let endUnknown = false;
  for (const agent of agents) {
    if (agent.startedAt) {
      const ms = DateTime.toEpochMillis(agent.startedAt);
      startMs = startMs === null ? ms : Math.min(startMs, ms);
    }
    if (agent.completedAt) {
      const ms = DateTime.toEpochMillis(agent.completedAt);
      endMs = endMs === null ? ms : Math.max(endMs, ms);
    } else {
      endUnknown = true;
    }
  }
  const live = agents.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    status: live ? "running" : "completed",
    startedAt: startMs === null ? null : new Date(startMs).toISOString(),
    completedAt: live || endUnknown || endMs === null ? null : new Date(endMs).toISOString(),
  };
}

/** Formats Codex task paths for display while leaving provider identity untouched. */
export function formatSubagentDisplayTitle(title: string): string {
  const displayTitle = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(displayTitle);
  if (path === null) return displayTitle;

  const name = path[1]!.replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || displayTitle;
}
