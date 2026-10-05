import type {
  OrchestrationV2AgentKind,
  OrchestrationV2CommandWaitKind,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import {
  classifyV2AgentKind,
  isOrchestrationV2WorkActive,
  orchestrationV2CommandExecutionIsLiveInBackground,
} from "@t3tools/contracts";

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

/**
 * Latest-run statuses that let the list surface. `waiting` is included: a
 * successful turn persists as waiting until checkpoint capture flips it to
 * completed. `rolled_back` is not: its work was abandoned, not left running.
 */
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<string>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

/** Shell rows carry a name, not a transcript: a long command is cut to this. */
const DESCRIPTION_MAX_LENGTH = 200;

/**
 * Whether background work left behind by a completed run holds back its
 * completion (the sidebar's Background state, the completion alert, automatic
 * settlement). Commands, such as dev servers and other long-lived shells, do
 * not: the agent is done and may leave them running for hours. Subagents and
 * monitors do, because they wake the agent and it continues. Work the server
 * cannot name, including kinds this build does not know, holds as the
 * conservative choice.
 */
export function backgroundWorkHoldsCompletion(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind">>,
): boolean {
  return tasks.some((task) => backgroundWorkKindHoldsCompletion(task.kind));
}

function backgroundWorkKindHoldsCompletion(kind: PendingBackgroundWorkTask["kind"]): boolean {
  switch (kind) {
    case "command":
      return false;
    case "subagent":
    case "monitor":
    case "background_task":
      return true;
  }
}

/** A command item as the list reads it. Every field past status is optional on the wire. */
export type PendingBackgroundWorkCommand = {
  readonly id: string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  readonly input?: unknown;
  readonly background?: boolean | undefined;
  readonly waitKind?: OrchestrationV2CommandWaitKind | undefined;
};

/** A subagent row as the list reads it. */
export type PendingBackgroundWorkSubagent = {
  readonly id: string;
  readonly status: OrchestrationV2Subagent["status"];
  readonly title: string | null;
  readonly childThreadId: ThreadId | null;
  readonly taskType?: string | undefined;
  readonly agentKind?: OrchestrationV2AgentKind | undefined;
};

function clippedDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, DESCRIPTION_MAX_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function named(taskId: string, description: string | undefined) {
  return { taskId, ...(description === undefined ? {} : { description }) };
}

/**
 * What a settled thread still runs in the background, named and kinded, for
 * the thread shell and every client that reads it.
 *
 * Built from the same sources as the shell's counts, so the list and the
 * counts agree: live background commands (a monitor is its own `monitor`
 * entry, since it wakes the agent while the command it watches may not) and
 * delegated agents (`subagent`; watch-loop tasks already appear as their
 * command). Empty while a run is in flight or when the latest run was rolled
 * back, since then the run itself, not leftover work, is what the thread shows.
 */
export function derivePendingBackgroundWork(input: {
  readonly latestRunStatus: string | null | undefined;
  readonly hasActiveRun: boolean;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkCommand>;
  readonly subagents: ReadonlyArray<PendingBackgroundWorkSubagent>;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  if (input.hasActiveRun) return [];
  if (
    input.latestRunStatus === null ||
    input.latestRunStatus === undefined ||
    !SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES.has(input.latestRunStatus)
  ) {
    return [];
  }
  const tasks: Array<PendingBackgroundWorkTask> = [];
  for (const item of input.turnItems) {
    if (!orchestrationV2CommandExecutionIsLiveInBackground(item)) continue;
    if (item.waitKind === "monitor") {
      tasks.push({ ...named(item.id, clippedDescription(item.title)), kind: "monitor" });
      continue;
    }
    tasks.push({
      ...named(item.id, clippedDescription(item.title) ?? clippedDescription(item.input)),
      kind: "command",
    });
  }
  for (const subagent of input.subagents) {
    if (!isOrchestrationV2WorkActive(subagent.status)) continue;
    if ((subagent.agentKind ?? classifyV2AgentKind({ taskType: subagent.taskType })) !== "agent") {
      continue;
    }
    tasks.push({
      ...named(subagent.id, clippedDescription(subagent.title)),
      kind: "subagent",
      ...(subagent.childThreadId === null ? {} : { childThreadId: subagent.childThreadId }),
    });
  }
  return tasks;
}
