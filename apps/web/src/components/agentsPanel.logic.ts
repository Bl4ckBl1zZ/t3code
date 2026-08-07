/**
 * Pure derivation for the Agents surface.
 *
 * The panel shows two rosters from one subagent list: delegated agents, and
 * background work (watch loops, shells that outlived their turn). Splitting
 * here rather than in the component keeps the classification -- the part with
 * real rules -- testable without rendering.
 */
import {
  classifyV2AgentKind,
  type OrchestrationV2AgentKind,
  type OrchestrationV2Subagent,
  type OrchestrationV2TaskUsage,
  type OrchestrationV2WorkflowProgress,
} from "@t3tools/contracts";

export type AgentRowState = "active" | "idle" | "done" | "failed";

export interface AgentRow {
  readonly id: string;
  readonly title: string;
  readonly state: AgentRowState;
  readonly status: OrchestrationV2Subagent["status"];
  readonly childThreadId: string | null;
  readonly model: string | null;
  readonly progress: string | null;
  readonly usage: OrchestrationV2TaskUsage | undefined;
  readonly workflow: OrchestrationV2WorkflowProgress | undefined;
  readonly scriptPath: string | undefined;
  readonly sessionUrl: string | undefined;
  readonly transcriptDir: string | undefined;
  readonly startedAt: string | null;
}

export interface AgentsPanelModel {
  readonly agents: ReadonlyArray<AgentRow>;
  readonly background: ReadonlyArray<AgentRow>;
  readonly activeCount: number;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * A task is "active" only while genuinely running. `waiting` is deliberately
 * idle rather than active: a task blocked on an approval is not consuming
 * anything, and animating it reads as progress that is not happening.
 */
export function agentRowState(status: OrchestrationV2Subagent["status"]): AgentRowState {
  switch (status) {
    case "running":
      return "active";
    case "pending":
    case "waiting":
      return "idle";
    case "completed":
      return "done";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "failed";
  }
}

/**
 * Resolve the roster a task belongs to. Prefers the server's stamped
 * `agentKind` and only reclassifies when it is absent, so rows written before
 * the stamp existed still land somewhere sensible instead of vanishing.
 */
export function resolveAgentKind(
  subagent: Pick<OrchestrationV2Subagent, "agentKind" | "taskType">,
): OrchestrationV2AgentKind {
  return subagent.agentKind ?? classifyV2AgentKind({ taskType: subagent.taskType });
}

function toRow(subagent: OrchestrationV2Subagent): AgentRow {
  const handles = subagent.runHandles;
  return {
    id: subagent.id,
    // Fall back through the fields most likely to carry something human before
    // showing a bare id, which tells the user nothing.
    title:
      subagent.title?.trim() ||
      subagent.workflow?.name?.trim() ||
      subagent.prompt.trim().split("\n")[0]?.slice(0, 80) ||
      subagent.id,
    state: agentRowState(subagent.status),
    status: subagent.status,
    childThreadId: subagent.childThreadId,
    model: subagent.model,
    progress: subagent.progress?.trim() || null,
    usage: subagent.usage,
    workflow: subagent.workflow,
    scriptPath: handles?.scriptPath,
    sessionUrl: handles?.sessionUrl,
    transcriptDir: handles?.transcriptDir,
    startedAt: subagent.startedAt === null ? null : String(subagent.startedAt),
  };
}

/**
 * Live work sorts above finished work, and within each half the most recently
 * started comes first. A roster that reorders as tasks finish is unreadable,
 * so terminal rows sink once and stay put.
 */
function compareRows(a: AgentRow, b: AgentRow): number {
  const aTerminal = TERMINAL_STATUSES.has(a.status);
  const bTerminal = TERMINAL_STATUSES.has(b.status);
  if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
  const aStarted = a.startedAt ?? "";
  const bStarted = b.startedAt ?? "";
  if (aStarted !== bStarted) return aStarted < bStarted ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

export function buildAgentsPanelModel(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): AgentsPanelModel {
  const agents: AgentRow[] = [];
  const background: AgentRow[] = [];

  for (const subagent of subagents) {
    const row = toRow(subagent);
    if (resolveAgentKind(subagent) === "background") {
      background.push(row);
    } else {
      agents.push(row);
    }
  }

  agents.sort(compareRows);
  background.sort(compareRows);

  return {
    agents,
    background,
    // Background work counts: the point of the badge is "something is still
    // running", and a watch loop still running is exactly that.
    activeCount: [...agents, ...background].filter((row) => row.state === "active").length,
  };
}

// Phase/token presentation is shared with mobile so both surfaces report the
// same numbers; see @t3tools/shared/workflowObservability.
export { formatTokenCount, workflowPhaseProgress } from "@t3tools/shared/workflowObservability";
