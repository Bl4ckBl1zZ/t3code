import { orchestrationV2RunWorkStartedAt, type OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * A wake (background notification, delegated task result, restart
 * continuation) carries on the work of the run that started last, so it keeps
 * that work's start. Stamp it when the wake run starts, not when it queues:
 * a queued prompt ahead of it has no start yet, and delegated results jump
 * the queue. Other runs start new work.
 */
export function wakeWorkStartedAt(
  runs: ReadonlyArray<OrchestrationV2Run>,
  trigger: {
    readonly notification?: unknown;
    readonly delegatedCompletion?: unknown;
    readonly restartContinuation?: unknown;
  },
): Pick<OrchestrationV2Run, "workStartedAt"> {
  if (
    trigger.notification === undefined &&
    trigger.delegatedCompletion === undefined &&
    (trigger.restartContinuation === undefined || trigger.restartContinuation === false)
  ) {
    return {};
  }
  const previous = runs
    .flatMap((run) => (run.startedAt === null ? [] : [{ run, startedAt: run.startedAt }]))
    .toSorted(
      (left, right) =>
        DateTime.Order(right.startedAt, left.startedAt) || right.run.ordinal - left.run.ordinal,
    )[0]?.run;
  return previous === undefined ? {} : { workStartedAt: orchestrationV2RunWorkStartedAt(previous) };
}
