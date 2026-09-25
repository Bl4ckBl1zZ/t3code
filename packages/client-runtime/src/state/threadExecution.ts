import {
  latestRootProviderFailure,
  threadErrorSummary,
} from "@t3tools/shared/orchestrationV2ThreadError";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadRunSummary, ThreadRuntimeSummary } from "./models.ts";

const ACTIVITY_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const INTERRUPTIBLE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);

function latestMatchingRun(
  projection: OrchestrationV2ThreadProjection,
  predicate: (run: OrchestrationV2ThreadProjection["runs"][number]) => boolean,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, candidate) =>
      predicate(candidate) && (latest === null || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    null,
  );
}

function summarizeThreadRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2ThreadProjection["runs"][number],
): ThreadRunSummary {
  return {
    runId: run.id,
    status: run.status,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    assistantMessageId:
      projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      )?.id ?? null,
    ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
  };
}

export function deriveLatestThreadRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run = latestMatchingRun(projection, () => true);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Returns the run that owns live provider work, falling back to the newest run
 * once the thread is idle. A newer queued run must not make an older executing
 * run look settled in clients that render per-run activity.
 */
export function deriveThreadActivityRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run =
    latestMatchingRun(projection, (candidate) => ACTIVITY_RUN_STATUSES.has(candidate.status)) ??
    latestMatchingRun(projection, () => true);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Provider-native subagent threads never get app runs: their work is a runless
 * root turn whose status follows the subagent. Returns when that work started
 * while it is still active, so clients can show the same working state (and
 * timer) as a run. Stop, queue, and steer stay run-only.
 */
export function deriveRunlessWorkStartedAt(
  projection: OrchestrationV2ThreadProjection,
): string | null {
  const node = projection.nodes.findLast(
    (candidate) =>
      candidate.kind === "root_turn" &&
      candidate.runId === null &&
      isOrchestrationV2WorkActive(candidate.status),
  );
  return node?.startedAt == null ? null : DateTime.formatIso(node.startedAt);
}

export function deriveThreadRuntime(
  projection: OrchestrationV2ThreadProjection,
): ThreadRuntimeSummary | null {
  const latestRun = deriveLatestThreadRun(projection);
  const activityRun = deriveThreadActivityRun(projection);
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  if (latestRun === null && projection.thread.activeProviderThreadId === null) return null;
  const activeRunId =
    latestMatchingRun(projection, (run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status))?.id ?? null;
  return {
    // Queueing creates a newer run, but does not replace the provider work
    // already in flight. Present the executing run's status until it reaches
    // a terminal state so clients do not flash from "running" to "queued".
    status: activityRun?.status ?? "idle",
    activeRunId,
    providerInstanceId: projection.thread.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    ...threadErrorSummary(
      latestRootProviderFailure(
        latestMatchingRun(projection, () => true),
        projection.turnItems,
      ),
      providerSession?.lastError ?? null,
    ),
    updatedAt: DateTime.formatIso(projection.updatedAt),
  };
}

export function threadRuntimeHasInterruptibleRun(
  runtime: ThreadRuntimeSummary | null | undefined,
): boolean {
  return runtime?.activeRunId !== null && runtime?.activeRunId !== undefined;
}
