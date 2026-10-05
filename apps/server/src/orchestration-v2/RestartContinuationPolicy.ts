import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

export const RESTART_CONTINUATION_PROMPT =
  "Continue where you left off before the server restarted. Check the current state before repeating any action.";

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

/**
 * Recovery only owns the latest uninterrupted provider context, never a newer
 * user turn. Held queued runs never started; they wait behind the continuation.
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
      (item) => item.runId === run.id && item.type === "run_interrupt_request",
    ) ||
    projection.runtimeRequests.some(
      (request) => request.status === "pending" && request.responseMode !== "message",
    )
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
  if (phase === "prepare") return run.status === "running";
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
