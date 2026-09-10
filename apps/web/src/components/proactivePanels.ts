import type { RunId, ThreadLinkedPullRequest } from "@t3tools/contracts";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { RightPanelSurface } from "../rightPanelStore";

export function shouldOpenProactivePullRequest(
  previousTargetKey: string | null | undefined,
  targetKey: string | null,
): boolean {
  return targetKey !== null && targetKey !== previousTargetKey;
}

interface ProactivePanelObservation {
  threadKey: string;
  runningRunId: RunId | null | undefined;
  targetKey: string | null | undefined;
  userActionRunId: RunId | null;
  userActionRevision: number;
}

/** Capture user intent before loading or metadata writes can defer panel activation. */
export function observeProactivePanelUserChoice(
  previous: ProactivePanelObservation | null,
  input: { threadKey: string; runningRunId: RunId | null; userActionRevision: number },
): ProactivePanelObservation {
  const sameThread = previous?.threadKey === input.threadKey;
  const newRun =
    sameThread && input.runningRunId !== null && input.runningRunId !== previous.userActionRunId;
  return {
    threadKey: input.threadKey,
    runningRunId: sameThread ? previous.runningRunId : undefined,
    targetKey: sameThread ? previous.targetKey : undefined,
    userActionRunId: input.runningRunId ?? (sameThread ? previous.userActionRunId : null),
    userActionRevision:
      !sameThread || newRun ? input.userActionRevision : previous.userActionRevision,
  };
}

/** Follow a changed server link only when the panel still shows the previous linked PR. */
export function shouldRetargetThreadPullRequestPanel(
  previous: ThreadLinkedPullRequest | null,
  current: ThreadLinkedPullRequest | null,
  surface: RightPanelSurface | null,
): boolean {
  if (previous === null || current === null || surface?.kind !== "pull-request") return false;
  const previousRepository = previous.repository.toLowerCase();
  return (
    (previous.projectId !== current.projectId ||
      previousRepository !== current.repository.toLowerCase() ||
      previous.number !== current.number) &&
    surface.projectId === previous.projectId &&
    surface.repository.toLowerCase() === previousRepository &&
    surface.number === previous.number
  );
}

export function shouldOpenProactiveRunDiff(input: {
  previousRunningRunId: RunId | null | undefined;
  runningRunId: RunId | null;
  settledRunId: RunId | null;
  runCompleted: boolean;
}): boolean {
  return (
    input.runningRunId === null &&
    input.runCompleted &&
    input.settledRunId !== null &&
    (input.previousRunningRunId === undefined || input.settledRunId === input.previousRunningRunId)
  );
}

export function resolveProactiveRunDiffAction(input: {
  checkpoint: Pick<ThreadCheckpointSummary, "status" | "files"> | undefined;
  isGitRepo: boolean | undefined;
}): "defer" | "ignore" | "open" {
  if (input.checkpoint === undefined || input.checkpoint.status === "missing") return "defer";
  if (input.isGitRepo === undefined) return "defer";
  if (
    !input.isGitRepo ||
    input.checkpoint.status !== "ready" ||
    input.checkpoint.files.length === 0
  ) {
    return "ignore";
  }
  return "open";
}
