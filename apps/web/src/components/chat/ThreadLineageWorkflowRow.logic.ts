import {
  orchestrationV2TurnItemStatusIsTerminal,
  type OrchestrationV2Subagent,
  type OrchestrationV2TaskUsage,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type SubagentStatus = OrchestrationV2Subagent["status"];

/** One roster member as a Lineage row renders it. */
export interface WorkflowMember {
  /** Spawn ordinal within the run, the member's stable identity. */
  readonly index: number;
  readonly title: string;
  readonly model: string | null;
  readonly status: SubagentStatus;
  readonly childThreadId: ThreadId | null;
  readonly phaseIndex: number | null;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly prompt: string | null;
  readonly result: string | null;
  readonly usage: OrchestrationV2TaskUsage | undefined;
}

export interface WorkflowPhaseGroup {
  readonly index: number;
  readonly title: string;
  readonly members: ReadonlyArray<WorkflowMember>;
  /** done = every member settled (success or error); running = any still active. */
  readonly state: "pending" | "running" | "done";
  readonly settledCount: number;
}

/** A workflow coordinator's roster grouped by phase, as Lineage unfolds it. */
export interface WorkflowGroup {
  readonly phases: ReadonlyArray<WorkflowPhaseGroup>;
  /** Members with no reported phase render directly under the workflow. */
  readonly unphasedMembers: ReadonlyArray<WorkflowMember>;
}

const isActive = (status: SubagentStatus) =>
  status === "pending" || status === "running" || status === "waiting" || status === "idle";

function memberFromRoster(
  coordinator: Pick<OrchestrationV2Subagent, "status" | "completedAt">,
  agent: NonNullable<NonNullable<OrchestrationV2Subagent["workflow"]>["agents"]>[number],
): WorkflowMember {
  // A member the run never settled ends with the run: once the coordinator is
  // done, a queued or running roster entry is stale, not still working.
  const status: SubagentStatus =
    (agent.state === "queued" || agent.state === "running") &&
    orchestrationV2TurnItemStatusIsTerminal(coordinator.status)
      ? coordinator.status
      : agent.state === "queued"
        ? "pending"
        : agent.state;
  // A queued member has not started work, so it reports no clock.
  const startedAt =
    agent.state === "queued" || agent.startedAt === undefined
      ? null
      : DateTime.makeUnsafe(agent.startedAt);
  // The provider reports a settled member's duration, not its end instant.
  const completedAt = orchestrationV2TurnItemStatusIsTerminal(status)
    ? agent.startedAt !== undefined && agent.durationMs !== undefined
      ? DateTime.makeUnsafe(agent.startedAt + agent.durationMs)
      : coordinator.completedAt
    : null;
  return {
    index: agent.index,
    title: agent.label,
    model: agent.model ?? null,
    status,
    childThreadId: agent.childThreadId ?? null,
    phaseIndex: agent.phaseIndex ?? null,
    startedAt,
    completedAt,
    prompt: agent.prompt ?? null,
    result: agent.result ?? null,
    usage:
      agent.totalTokens === undefined
        ? undefined
        : {
            totalTokens: agent.totalTokens,
            ...(agent.toolCalls === undefined ? {} : { toolUses: agent.toolCalls }),
            ...(agent.durationMs === undefined ? {} : { durationMs: agent.durationMs }),
          },
  };
}

/**
 * Groups a workflow coordinator's member roster by phase. Returns null for a
 * subagent whose provider reported no roster, which keeps its plain row.
 */
export function deriveWorkflowGroup(
  coordinator: Pick<OrchestrationV2Subagent, "status" | "completedAt" | "workflow">,
): WorkflowGroup | null {
  const workflow = coordinator.workflow;
  if (workflow?.agents === undefined) return null;
  const members = workflow.agents
    .map((agent) => memberFromRoster(coordinator, agent))
    .sort((a, b) => a.index - b.index);

  // Union, not either/or: the declared plan lags the members, because the
  // provider only admits a phase once something in it starts. Members seed
  // the map; the declared titles then overwrite whatever they guessed.
  const phaseTitles = new Map<number, string>();
  for (const agent of workflow.agents) {
    if (agent.phaseIndex === undefined) continue;
    phaseTitles.set(
      agent.phaseIndex,
      agent.phaseTitle ?? phaseTitles.get(agent.phaseIndex) ?? `Phase ${agent.phaseIndex + 1}`,
    );
  }
  for (const phase of workflow.phases) phaseTitles.set(phase.index, phase.title);

  const phases = Array.from(phaseTitles, ([index, title]) => {
    const phaseMembers = members.filter((member) => member.phaseIndex === index);
    const settledCount = phaseMembers.filter((member) =>
      orchestrationV2TurnItemStatusIsTerminal(member.status),
    ).length;
    const state: WorkflowPhaseGroup["state"] =
      phaseMembers.length === 0
        ? "pending"
        : phaseMembers.some((member) => isActive(member.status))
          ? "running"
          : "done";
    return { index, title, members: phaseMembers, state, settledCount };
  }).sort((a, b) => a.index - b.index);

  return {
    phases,
    unphasedMembers: members.filter((member) => member.phaseIndex === null),
  };
}

/** The phase's header label; its tone and the member orbs show the same state visually. */
export function workflowPhaseStatusLabel(phase: WorkflowPhaseGroup) {
  if (phase.state === "running") return "running";
  if (phase.members.some((member) => member.status === "failed")) return "failed";
  if (
    phase.members.some((member) => member.status === "cancelled" || member.status === "interrupted")
  ) {
    return "stopped";
  }
  return phase.state === "done" ? "done" : "not started";
}
