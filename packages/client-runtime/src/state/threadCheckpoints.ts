import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export function deriveThreadCheckpointSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages">,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

/**
 * Files a restore to `turnCount` puts back: every path a later checkpoint in
 * the same scope changed, in the order they were first changed.
 */
export function filesChangedAfterCheckpoint(
  summaries: ReadonlyArray<
    Pick<ThreadCheckpointSummary, "scopeId" | "checkpointTurnCount" | "files">
  >,
  turnCount: number,
): ReadonlyArray<string> {
  const scopeId = summaries.find((summary) => summary.checkpointTurnCount === turnCount)?.scopeId;
  const paths = new Set<string>();
  for (const summary of [...summaries].sort(
    (left, right) => left.checkpointTurnCount - right.checkpointTurnCount,
  )) {
    if (summary.checkpointTurnCount <= turnCount) continue;
    if (scopeId !== undefined && summary.scopeId !== scopeId) continue;
    for (const file of summary.files) paths.add(file.path);
  }
  return [...paths];
}
