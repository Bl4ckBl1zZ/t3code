import type {
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
