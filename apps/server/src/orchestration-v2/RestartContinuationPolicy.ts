import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export const RESTART_CONTINUATION_PROMPT =
  "Continue where you left off before the server restarted. Check the current state before repeating any action.";

/** Recovery only owns the latest uninterrupted provider context, never a newer user turn. */
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
    projection.runs.some((other) => other.ordinal > run.ordinal) ||
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
    !projection.runs.some((other) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(other.status),
    )
  );
}
