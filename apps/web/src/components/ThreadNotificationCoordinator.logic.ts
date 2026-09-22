import type { RunId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { isSidebarSubagentThread, resolveSidebarThreadStatus } from "./Sidebar.logic";

export type ThreadNotificationThread = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "id"
  | "title"
  | "archivedAt"
  | "lineage"
  | "latestRun"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundProcessCount"
  | "activeAgentCount"
>;

export interface ThreadNotificationMemory {
  /** `<runId>:<status>` while the thread is blocked on the user or failed. */
  readonly attention: string | null;
  /** The latest run this thread was seen resting on after completing. */
  readonly completion: RunId | null;
}

export interface ThreadNotificationEvent {
  readonly thread: ThreadNotificationThread;
  readonly kind: "completion" | "input";
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  /** The sidebar status icon the row shows for the same state, so a toast matches it. */
  readonly icon: "done" | "approval" | "input" | "failed";
}

export function threadNotificationKey(
  thread: Pick<ThreadNotificationThread, "environmentId" | "id">,
) {
  return `${thread.environmentId}:${thread.id}`;
}

/**
 * Compares the thread shells against what was last seen and reports the threads that newly
 * completed, failed, or started waiting on the user. A thread seen for the first time only
 * seeds the memory, so loading or reconnecting an environment never alerts for old work.
 */
export function resolveThreadNotificationEvents(
  previous: ReadonlyMap<string, ThreadNotificationMemory>,
  threads: ReadonlyArray<ThreadNotificationThread>,
): {
  readonly next: Map<string, ThreadNotificationMemory>;
  readonly events: ThreadNotificationEvent[];
} {
  const next = new Map<string, ThreadNotificationMemory>();
  const events: ThreadNotificationEvent[] = [];

  for (const thread of threads) {
    const key = threadNotificationKey(thread);
    const status = resolveSidebarThreadStatus(thread);
    const prior = previous.get(key);
    const attention =
      status === "input" || status === "approval" || status === "failed"
        ? `${thread.latestRun?.runId ?? ""}:${status}`
        : null;
    const completion =
      status === "ready" && thread.latestRun?.status === "completed"
        ? thread.latestRun.runId
        : (prior?.completion ?? null);
    next.set(key, { attention, completion });

    if (!prior || thread.archivedAt !== null || isSidebarSubagentThread(thread)) continue;
    if (attention && attention !== prior.attention) {
      events.push({
        thread,
        kind: "input",
        tone: status === "failed" ? "error" : "warning",
        icon: status === "approval" || status === "failed" ? status : "input",
        title:
          status === "approval"
            ? "Approval needed"
            : status === "failed"
              ? "Thread failed"
              : "Input needed",
      });
    } else if (completion !== null && completion !== prior.completion) {
      events.push({
        thread,
        kind: "completion",
        tone: "success",
        title: "Thread completed",
        icon: "done",
      });
    }
  }

  return { next, events };
}
