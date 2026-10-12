import {
  latestProviderTurnForAttempt,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

export const RESTART_CONTINUATION_PROMPT =
  "Continue where you left off before the server restarted. Check the current state before repeating any action.";

/** Consecutive automatic continuations allowed before a person has to step in. */
export const MAX_RESTART_CONTINUATION_CHAIN = 3;

/** A native /compact or /logout turn: provider maintenance, not agent work to resume. */
function isNativeMaintenanceCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}): boolean {
  return (
    message.attachments.length === 0 &&
    ["/compact", "/logout"].includes(message.text.trim().toLowerCase())
  );
}

/** A snoozed thread waits for the user; a restart does not wake it. */
export function isSnoozedForRestart(
  thread: Pick<OrchestrationV2AppThread, "snoozedUntil">,
  now: DateTime.Utc,
): boolean {
  return thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now);
}

/**
 * How many automatic restart continuations in a row led to this run, capped
 * at MAX_RESTART_CONTINUATION_CHAIN. A continuation run starts from the
 * message its source run reserved.
 */
function restartContinuationChainLength(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): number {
  let length = 0;
  let current: OrchestrationV2Run | undefined = run;
  while (current !== undefined && length < MAX_RESTART_CONTINUATION_CHAIN) {
    const userMessageId: OrchestrationV2Run["userMessageId"] = current.userMessageId;
    const message = projection.messages.find((candidate) => candidate.id === userMessageId);
    if (message?.restartContinuation !== true) break;
    length += 1;
    current = projection.runs.find(
      (candidate) => candidate.restartContinuation?.messageId === userMessageId,
    );
  }
  return length;
}

/**
 * Recovery only owns the latest uninterrupted provider context, never a newer
 * user turn. Held queued runs never started; they wait behind the continuation.
 * A run waiting on the user, or one reached through three continuations in a
 * row, is left for the user: a turn that keeps crashing the server must not
 * restart it forever.
 */
export function canContinueAfterRestart(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
  phase: "prepare" | "resume",
): boolean {
  const thread = projection.thread;
  if (
    thread.settledOverride === "settled" ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.providerInstanceId !== run.providerInstanceId ||
    thread.activeProviderThreadId !== run.providerThreadId ||
    run.providerThreadId === null ||
    projection.runs.some(
      (other) => other.id !== run.id && other.status !== "queued" && runRanAfter(other, run),
    ) ||
    projection.messages.some(
      (message) => message.id === run.userMessageId && isNativeMaintenanceCommand(message),
    ) ||
    projection.turnItems.some(
      (item) =>
        item.runId === run.id &&
        (item.type === "run_interrupt_request" ||
          (item.type === "secret_request" && item.secretStatus === "pending")),
    ) ||
    projection.runtimeRequests.some(
      (request) => request.status === "pending" && request.responseMode !== "message",
    ) ||
    restartContinuationChainLength(projection, run) >= MAX_RESTART_CONTINUATION_CHAIN
  )
    return false;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    providerThread?.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength === "none" ||
    providerThread.ownerNodeId !== null ||
    providerThread.status === "closed" ||
    providerThread.status === "archived" ||
    providerThread.status === "error"
  )
    return false;
  if (phase === "prepare") {
    // A provider turn that already ended has nothing left to continue.
    const turn = latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
    return (
      run.status === "running" &&
      turn?.status !== "completed" &&
      turn?.status !== "failed" &&
      turn?.status !== "interrupted"
    );
  }
  return (
    run.status === "cancelled" &&
    run.restartContinuation?.status === "pending" &&
    !projection.messages.some((message) => message.id === run.restartContinuation?.messageId) &&
    !projection.runs.some(
      (other) =>
        ["preparing", "starting", "running", "waiting"].includes(other.status) ||
        (other.status === "queued" && other.queueHeld !== true),
    )
  );
}
