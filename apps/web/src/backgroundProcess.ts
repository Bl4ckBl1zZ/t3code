import * as DateTime from "effect/DateTime";
import {
  orchestrationV2CommandExecutionIsLiveInBackground,
  orchestrationV2TurnItemStatusIsTerminal,
  type OrchestrationV2CommandExecutionItem,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

/**
 * How a live command presents itself, chosen by what the provider actually
 * makes knowable rather than by preference:
 *
 * - `tail` — output is readable while it runs (a background task's output file,
 *   or Codex's output deltas). Elapsed plus the last line, no progress bar.
 * - `deadline` — a timeout was declared, so a determinate bar is honest. Output
 *   is not available until the command exits.
 * - `monitor` — the command exists only to wait for something. Rendered as the
 *   agent being asleep, with the deadline it will give up at.
 */
export type BackgroundProcessVariant = "tail" | "deadline" | "monitor";

export interface BackgroundProcessView {
  readonly variant: BackgroundProcessVariant;
  readonly live: boolean;
  readonly paused: boolean;
  readonly command: string;
  readonly taskId: string | null;
  /** Last line of output, or null when nothing has been printed yet. */
  readonly tail: string | null;
  readonly outputTruncated: boolean;
  /** Milliseconds the command has been running, excluding time paused. */
  readonly elapsedMs: number;
  /** Milliseconds since output last moved; null when there is no output. */
  readonly sinceOutputMs: number | null;
  /** 0–1 progress against a declared deadline; null without one. */
  readonly deadlineFraction: number | null;
  readonly deadlineRemainingMs: number | null;
  /** Task this monitor is waiting on, so the UI can name its target. */
  readonly waitingOnTaskId: string | null;
  readonly outcome: BackgroundProcessOutcome | null;
}

export interface BackgroundProcessOutcome {
  readonly tone: "success" | "danger" | "warning" | "neutral";
  readonly label: string;
}

/**
 * A command's ending, in the terms a reader cares about. The distinction that
 * matters most is between a command that failed and one that never got to
 * finish — those look identical in a status field and mean opposite things.
 */
export function backgroundProcessOutcome(
  item: OrchestrationV2CommandExecutionItem,
): BackgroundProcessOutcome | null {
  if (!orchestrationV2TurnItemStatusIsTerminal(item.status)) {
    return null;
  }
  const exitCode = item.exitCode;
  if (item.exitReason === "unknown") {
    return { tone: "warning", label: "outcome unknown, server restarted while it ran" };
  }
  if (item.exitReason === "killed") {
    return { tone: "warning", label: "stopped when the session ended" };
  }
  if (item.exitReason === "timeout") {
    return { tone: "warning", label: "gave up waiting" };
  }
  if (item.status === "cancelled" || item.status === "interrupted") {
    return { tone: "warning", label: "stopped" };
  }
  if (item.status === "failed" || (exitCode !== undefined && exitCode !== 0)) {
    return {
      tone: "danger",
      label: exitCode === undefined ? "failed" : `failed exit ${exitCode}`,
    };
  }
  return {
    tone: "success",
    label: exitCode === undefined ? "finished" : `finished exit ${exitCode}`,
  };
}

function backgroundProcessVariant(
  item: OrchestrationV2CommandExecutionItem,
): BackgroundProcessVariant {
  if (item.waitKind === "monitor") {
    return "monitor";
  }
  // Output beats a bar: a command that is visibly printing needs no estimate,
  // and one with a deadline but no output has nothing else to show.
  if (item.hasOutputStream === true || (item.output ?? "").length > 0) {
    return "tail";
  }
  return item.timeoutMs === undefined ? "tail" : "deadline";
}

/** Last non-empty line, which is what "doing right now" means to a reader. */
export function backgroundProcessTail(output: string | undefined): string | null {
  if (output === undefined) {
    return null;
  }
  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trimEnd();
    if (line.trim().length > 0) {
      return line;
    }
  }
  return null;
}

export function resolveBackgroundProcessView(
  item: OrchestrationV2CommandExecutionItem,
  nowMs: number,
): BackgroundProcessView {
  const live = !orchestrationV2TurnItemStatusIsTerminal(item.status);
  const startedMs = item.startedAt === null ? nowMs : DateTime.toEpochMillis(item.startedAt);
  const endedMs =
    item.completedAt === null || item.completedAt === undefined
      ? nowMs
      : DateTime.toEpochMillis(item.completedAt);
  const elapsedMs = Math.max(0, (live ? nowMs : endedMs) - startedMs - (item.pausedMs ?? 0));
  const lastOutputMs =
    item.lastOutputAt === undefined ? null : DateTime.toEpochMillis(item.lastOutputAt);
  const timeoutMs = item.timeoutMs;
  return {
    variant: backgroundProcessVariant(item),
    live,
    paused: item.paused === true,
    command: item.input,
    taskId: item.taskId ?? null,
    tail: backgroundProcessTail(item.output),
    outputTruncated: item.outputTruncated === true,
    elapsedMs,
    sinceOutputMs: lastOutputMs === null ? null : Math.max(0, nowMs - lastOutputMs),
    deadlineFraction:
      timeoutMs === undefined || timeoutMs === 0
        ? null
        : Math.min(1, Math.max(0, elapsedMs / timeoutMs)),
    deadlineRemainingMs: timeoutMs === undefined ? null : Math.max(0, timeoutMs - elapsedMs),
    waitingOnTaskId: item.waitingOnTaskId ?? null,
    outcome: backgroundProcessOutcome(item),
  };
}

/**
 * Coarse on purpose. Under ten minutes a reader wants seconds; past that the
 * seconds are noise, and dropping them lets the row re-render a hundredth as
 * often in a timeline that can hold thousands of them.
 */
export function formatBackgroundElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 10) {
    return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
}

/** Tick cadence matched to the precision on screen — no wasted renders. */
export function backgroundElapsedTickMs(elapsedMs: number): number {
  return elapsedMs < 10 * 60 * 1_000 ? 1_000 : 30_000;
}

/**
 * "3s ago" is the difference between a command working and a command wedged,
 * and it is the only progress signal that exists for most commands.
 */
export function formatBackgroundSinceOutput(sinceOutputMs: number): string {
  const seconds = Math.max(0, Math.floor(sinceOutputMs / 1_000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

export function isBackgroundProcessItem(
  item: OrchestrationV2TurnItem,
): item is OrchestrationV2CommandExecutionItem {
  return item.type === "command_execution" && item.background === true;
}

export interface LiveBackgroundProcess {
  readonly item: OrchestrationV2CommandExecutionItem;
  /** The monitor waiting on this command, when one exists. */
  readonly monitor: OrchestrationV2CommandExecutionItem | null;
}

/**
 * Live background commands drawn straight from the timeline entries a thread
 * already renders, so the strip above the composer and the rows in the timeline
 * cannot disagree about what is running.
 */
export function liveBackgroundProcessesFromTimeline(
  entries: ReadonlyArray<{
    readonly kind: string;
    readonly projectedItem?: OrchestrationV2ProjectedTurnItem | undefined;
    readonly entry?: { readonly projectedItem?: OrchestrationV2ProjectedTurnItem | undefined };
  }>,
): ReadonlyArray<LiveBackgroundProcess> {
  const projectedItems: Array<OrchestrationV2ProjectedTurnItem> = [];
  for (const entry of entries) {
    const projected = entry.projectedItem ?? entry.entry?.projectedItem;
    if (projected !== undefined) {
      projectedItems.push(projected);
    }
  }
  return liveBackgroundProcesses(projectedItems);
}

/**
 * Live background commands for a thread, with any monitor folded into the
 * command it watches.
 *
 * Claude reports a monitor as a peer background task, so a plain listing shows
 * two rows for one thing the user is waiting on. The monitor is an
 * implementation detail of the wait, not a second process.
 */
export function liveBackgroundProcesses(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<LiveBackgroundProcess> {
  const live: Array<OrchestrationV2CommandExecutionItem> = [];
  for (const projected of items) {
    const item = projected.item;
    if (isBackgroundProcessItem(item) && orchestrationV2CommandExecutionIsLiveInBackground(item)) {
      live.push(item);
    }
  }
  const monitors = live.filter((item) => item.waitKind === "monitor");
  const foldedMonitorIds = new Set<string>();
  const processes: Array<LiveBackgroundProcess> = [];
  for (const item of live) {
    if (item.waitKind === "monitor") {
      continue;
    }
    // Guarded on taskId: two commands with no handle must not both match a
    // monitor whose target is likewise undefined.
    const monitor =
      item.taskId === undefined
        ? null
        : (monitors.find((candidate) => candidate.waitingOnTaskId === item.taskId) ?? null);
    if (monitor !== null) {
      foldedMonitorIds.add(monitor.id);
    }
    processes.push({ item, monitor });
  }
  // An orphan monitor still deserves a row: the agent is asleep either way, and
  // silence is the failure mode this whole feature exists to remove. This also
  // keeps the row count equal to `orchestrationV2BackgroundProcessCount`, which
  // drives the sidebar dot.
  for (const monitor of monitors) {
    if (!foldedMonitorIds.has(monitor.id)) {
      processes.push({ item: monitor, monitor: null });
    }
  }
  return processes;
}
