import type {
  EnvironmentId,
  OrchestrationV2BackgroundTaskOutput,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { presentBackgroundTaskOutput } from "@t3tools/client-runtime/state/thread-execution";
import { useEffect, useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

const EMPTY_OUTPUTS: ReadonlyMap<string, OrchestrationV2BackgroundTaskOutput> = new Map();

/**
 * Live output of a settled thread's background commands and monitors, by task
 * id. Subscribes only while such work is pending; the server reads provider
 * output only while someone subscribes, and the banner and thread details share
 * this one subscription.
 */
export function useThreadBackgroundOutput(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}): ReadonlyMap<string, OrchestrationV2BackgroundTaskOutput> {
  const threadId = input.threadId;
  const watches = threadId !== null && input.tasks.some((task) => task.kind !== "subagent");
  const query = useEnvironmentQuery(
    watches
      ? orchestrationEnvironment.v2.backgroundOutput({
          environmentId: input.environmentId,
          input: { threadId },
        })
      : null,
  );
  const tasks = watches ? query.data?.tasks : undefined;
  return tasks === undefined ? EMPTY_OUTPUTS : new Map(tasks.map((task) => [task.taskId, task]));
}

/**
 * Wall clock for one task's labels, advanced no more often than its coarsest
 * label changes: every second while something reads in seconds, every 30s
 * after. Nothing ticks for a task with no clock.
 */
export function useBackgroundOutputClock(
  output: OrchestrationV2BackgroundTaskOutput | undefined,
): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const nextChangeMs = presentBackgroundTaskOutput(output, nowMs).nextChangeMs;
  useEffect(() => {
    if (nextChangeMs === null) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), nextChangeMs);
    return () => window.clearInterval(timer);
  }, [nextChangeMs]);
  return nowMs;
}
