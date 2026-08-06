import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";

type TimelineRun = Pick<OrchestrationV2Run, "id" | "status">;
type TimelineRunAttempt = Pick<OrchestrationV2RunAttempt, "runId" | "rootNodeId" | "status">;
type TimelineTurnItem = Pick<OrchestrationV2TurnItem, "type" | "runId" | "nodeId"> & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function isOrchestrationV2SupersededInterrupt(input: {
  readonly item: TimelineTurnItem;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) {
    return false;
  }

  const isSuperseded = input.attempts.some(
    (attempt) =>
      attempt.runId === item.runId &&
      attempt.rootNodeId === item.nodeId &&
      attempt.status === "superseded",
  );
  if (!isSuperseded) {
    return false;
  }

  // Paired stop-then-steer results have a matching request on the same run and
  // must stay visible. Legacy plain-steer results have no request and stay hidden.
  const hasMatchingRequest = input.items.some(
    (candidate) => candidate.type === "run_interrupt_request" && candidate.runId === item.runId,
  );
  return !hasMatchingRequest;
}

/**
 * Precomputed visibility lookups for scanning many turn items at once. The
 * per-item checks in {@link isOrchestrationV2TurnItemVisible} scan runs,
 * attempts, and items per call — O(N²) over a whole timeline. This context
 * builds the same answers as set lookups so a full scan is O(N).
 */
export function makeOrchestrationV2VisibilityContext(input: {
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): (item: TimelineTurnItem) => boolean {
  const rolledBackRuns = new Set<unknown>();
  const cancelledRuns = new Set<unknown>();
  for (const run of input.runs) {
    if (run.status === "rolled_back") rolledBackRuns.add(run.id);
    else if (run.status === "cancelled") cancelledRuns.add(run.id);
  }
  const supersededAttempts = new Set<string>();
  for (const attempt of input.attempts) {
    if (attempt.status === "superseded") {
      supersededAttempts.add(`${String(attempt.runId)}:${String(attempt.rootNodeId)}`);
    }
  }
  const interruptRequestRuns = new Set<unknown>();
  for (const item of input.items) {
    if (item.type === "run_interrupt_request") interruptRequestRuns.add(item.runId);
  }

  return (item) => {
    if (item.runId !== null && rolledBackRuns.has(item.runId)) return false;
    if (
      item.type === "user_message" &&
      item.inputIntent === "queued_turn" &&
      item.runId !== null &&
      cancelledRuns.has(item.runId)
    ) {
      return false;
    }
    if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) {
      return true;
    }
    const isSuperseded = supersededAttempts.has(`${String(item.runId)}:${String(item.nodeId)}`);
    if (!isSuperseded) return true;
    return interruptRequestRuns.has(item.runId);
  };
}

export function isOrchestrationV2TurnItemVisible(input: {
  readonly item: TimelineTurnItem;
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "rolled_back")
  ) {
    return false;
  }

  // A queued message is composer state, not conversation history. When its run
  // is cancelled the input never reached the provider, so it must not surface
  // as a transcript row.
  if (
    item.type === "user_message" &&
    item.inputIntent === "queued_turn" &&
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "cancelled")
  ) {
    return false;
  }

  return !isOrchestrationV2SupersededInterrupt({
    item,
    attempts: input.attempts,
    items: input.items,
  });
}

/**
 * Detail line for a checkpoint rollback marker: "2 turns · 7 files restored",
 * dropping either half when it is zero and returning null when both are.
 */
export function formatOrchestrationV2RollbackDetail(input: {
  readonly rolledBackRunCount: number;
  readonly restoredFileCount: number;
}): string | null {
  const parts: string[] = [];
  if (input.rolledBackRunCount > 0) {
    parts.push(`${input.rolledBackRunCount} ${input.rolledBackRunCount === 1 ? "turn" : "turns"}`);
  }
  if (input.restoredFileCount > 0) {
    parts.push(
      `${input.restoredFileCount} ${input.restoredFileCount === 1 ? "file" : "files"} restored`,
    );
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * Local calendar day of an ISO timestamp, or null when it doesn't parse.
 * Local rather than UTC: a message sent at 23:30 belongs to the day the reader
 * remembers sending it, not the day UTC happened to be on.
 */
export function orchestrationV2TimelineDayKey(isoDate: string): string | null {
  const instant = DateTime.make(isoDate);
  if (Option.isNone(instant)) return null;
  return DateTime.formatIsoDate(DateTime.setZone(instant.value, DateTime.zoneMakeLocal()));
}

/**
 * "Today" / "Yesterday" for the days a reader still holds in their head, and a
 * dated label beyond that. The year only appears once it isn't the current one.
 * `nowMs` is explicit so callers stay testable and this stays pure.
 */
export function formatOrchestrationV2TimelineDayLabel(isoDate: string, nowMs: number): string {
  const instant = DateTime.make(isoDate);
  if (Option.isNone(instant)) return "Earlier";
  const zone = DateTime.zoneMakeLocal();
  const zoned = DateTime.setZone(instant.value, zone);
  const dayKey = DateTime.formatIsoDate(zoned);
  const now = DateTime.setZone(DateTime.makeUnsafe(nowMs), zone);
  if (dayKey === DateTime.formatIsoDate(now)) return "Today";
  if (dayKey === DateTime.formatIsoDate(DateTime.subtract(now, { days: 1 }))) return "Yesterday";
  const sameYear = DateTime.toParts(zoned).year === DateTime.toParts(now).year;
  return DateTime.formatLocal(zoned, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

type TimelineAttemptSource = Pick<
  OrchestrationV2RunAttempt,
  "id" | "runId" | "attemptOrdinal" | "rootNodeId" | "status"
>;
type TimelineNodeSource = Pick<OrchestrationV2ExecutionNode, "id" | "rootNodeId" | "parentNodeId">;

/**
 * The run attempt an item belongs to, walked up the execution-node chain: an
 * item hangs off a tool-call node, while the attempt is keyed by the root node
 * of the turn. Undefined when the nodes aren't locally available yet.
 */
export function resolveOrchestrationV2ItemAttempt<Attempt extends TimelineAttemptSource>(input: {
  readonly item: Pick<OrchestrationV2TurnItem, "runId" | "nodeId">;
  readonly attemptByRootNodeId: ReadonlyMap<string, Attempt>;
  readonly nodeById: ReadonlyMap<string, TimelineNodeSource>;
}): Attempt | undefined {
  const { item } = input;
  if (item.nodeId === null || item.runId === null) return undefined;
  let nodeId: string | null = item.nodeId;
  const visited = new Set<string>();
  while (nodeId !== null && !visited.has(nodeId)) {
    visited.add(nodeId);
    const directAttempt = input.attemptByRootNodeId.get(nodeId);
    if (directAttempt?.runId === item.runId) return directAttempt;
    const node = input.nodeById.get(nodeId);
    if (node === undefined) return undefined;
    const rootAttempt = input.attemptByRootNodeId.get(node.rootNodeId);
    if (rootAttempt?.runId === item.runId) return rootAttempt;
    nodeId = node.parentNodeId;
  }
  return undefined;
}
