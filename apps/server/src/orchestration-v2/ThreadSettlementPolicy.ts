import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequestChains";
import * as DateTime from "effect/DateTime";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
}

/**
 * `latestUserAuthoredMessageAt` is the last message the user wrote. Agent,
 * provider, and server wakes also use the user role, so `latestUserMessageAt`
 * moves when delegated work or a restart wakes the agent. Optional: shells
 * from servers that predate it keep the older anchor.
 */
export type SettlementThread = Pick<
  OrchestrationV2ThreadShell,
  | "createdAt"
  | "latestUserMessageAt"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "status"
  | "activeRunId"
  | "pendingRuntimeRequest"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "autoSettleDisabledAt"
  | "snoozedAt"
  | "snoozedUntil"
  | "pinnedAt"
  | "workInboxRole"
  | "backgroundProcessCount"
  | "activeAgentCount"
  | "pendingBackgroundTasks"
  | "pullRequests"
  | "latestUserAuthoredMessageAt"
> & {
  /**
   * When the user last woke the thread from a snooze. Lives on the app thread
   * rather than the shell; callers without it fall back to plain activity.
   */
  readonly lastSnoozeWakeAt?: DateTime.Utc | null | undefined;
};

const DAY_MS = 86_400_000;
const QUEUED_GRACE_MS = 120_000;
const millis = (value: DateTime.Utc | null | undefined) =>
  value == null ? Number.NEGATIVE_INFINITY : DateTime.toEpochMillis(value);
const latest = (values: readonly (DateTime.Utc | null | undefined)[]) =>
  values.reduce<DateTime.Utc | null>(
    (result, value) => (millis(value) > millis(result) ? value! : result),
    null,
  );

/** V2 execution and request projections replace V1 session/background-liveness checks. */
export function isAutoSettlementCandidate(thread: SettlementThread, now: DateTime.Utc): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null || thread.settledOverride !== null)
    return false;
  // The user turned automatic settlement off for this thread.
  if (thread.autoSettleDisabledAt != null) return false;
  if (thread.workInboxRole === "main") return false;
  if (
    thread.activeRunId !== null ||
    (thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.responseMode !== "message")
  )
    return false;
  if (["preparing", "queued", "starting", "running", "waiting"].includes(thread.status))
    return false;
  // Background work that will wake the agent is not staleness. A dev server
  // left running is: the agent is done with it. Shells without the named list
  // fall back to the counts, which cannot tell the two apart.
  if (
    thread.pendingBackgroundTasks === undefined
      ? (thread.backgroundProcessCount ?? 0) > 0 || (thread.activeAgentCount ?? 0) > 0
      : backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks)
  )
    return false;
  const userAt = millis(thread.latestUserMessageAt);
  if (
    thread.status !== "failed" &&
    Number.isFinite(userAt) &&
    Math.abs(DateTime.toEpochMillis(now) - userAt) <= QUEUED_GRACE_MS &&
    [thread.latestRunRequestedAt, thread.latestRunStartedAt, thread.latestRunCompletedAt].every(
      (at) => millis(at) < userAt,
    )
  )
    return false;
  if (millis(thread.snoozedUntil) <= DateTime.toEpochMillis(now)) return true;
  return (
    ["failed", "completed"].includes(thread.status) &&
    millis(thread.latestRunCompletedAt) > millis(thread.snoozedAt)
  );
}

/**
 * Whether a thread is parked on its snooze: its wake time is in the future and
 * it has not raised its hand with a pending request, a fresh failure, or work
 * that completed after the snooze. Server twin of the client's
 * `effectiveSnoozed`, so agents and the sidebar agree on what is snoozed. One
 * difference: a failure counts as fresh when its run completed after the
 * snooze, like `isAutoSettlementCandidate`. The client compares the shell's
 * update time, so a rename can wake a failed thread there but not here.
 */
export function isSnoozed(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "snoozedUntil" | "snoozedAt" | "latestRunCompletedAt" | "status" | "pendingRuntimeRequest"
  >,
  now: DateTime.Utc,
): boolean {
  if (millis(thread.snoozedUntil) <= DateTime.toEpochMillis(now)) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  const snoozedAt = millis(thread.snoozedAt);
  const completedAt = millis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" && (thread.snoozedAt == null || completedAt > snoozedAt);
  // Like the client, only a run that completed wakes it; an interrupt or cancel does not.
  const wokeOnCompletion =
    thread.status === "completed" && thread.snoozedAt != null && completedAt > snoozedAt;
  return !wokeOnError && !wokeOnCompletion;
}

/** Terminal host timestamps prevent later PR metadata edits from settling resumed work. */
export function resolveAutoSettlementAt(input: {
  readonly thread: SettlementThread;
  readonly pullRequest: SettlementPullRequest | null;
  readonly now: DateTime.Utc;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
}): DateTime.Utc | null {
  const { thread } = input;
  if (!isAutoSettlementCandidate(thread, input.now)) return null;
  const links = visibleThreadPullRequests(thread.pullRequests ?? []);
  if (links.some((link) => link.snapshot === null || link.snapshot.state === "open")) return null;
  let pullRequest = input.pullRequest;
  if (links.length > 0) {
    const terminalMs = (link: (typeof links)[number]) => {
      const snapshot = link.snapshot;
      const timestamp = Date.parse(
        (snapshot?.state === "merged" ? snapshot.mergedAt : snapshot?.closedAt) ?? "",
      );
      return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
    };
    const last = links.reduce((current, candidate) =>
      terminalMs(candidate) > terminalMs(current) ? candidate : current,
    );
    pullRequest =
      last.snapshot === null
        ? null
        : {
            state: last.snapshot.state,
            mergedAt: last.snapshot.mergedAt ?? null,
            closedAt: last.snapshot.closedAt ?? null,
          };
  }
  const activity = latest([
    thread.latestUserMessageAt,
    thread.latestRunRequestedAt,
    thread.latestRunStartedAt,
    thread.latestRunCompletedAt,
  ]);
  // A merged or closed pull request settles the thread unless the user wrote
  // to it afterwards. Runs that delegated work, a restart, or another agent
  // started do not count, so they cannot hold a merged thread open.
  const anchor =
    thread.latestUserAuthoredMessageAt === undefined
      ? latest([thread.createdAt, thread.latestUserMessageAt, thread.latestRunRequestedAt])
      : latest([thread.createdAt, thread.latestUserAuthoredMessageAt]);
  if (
    pullRequest !== null &&
    (pullRequest.state === "closed" || (pullRequest.state === "merged" && input.autoSettleOnMerge))
  ) {
    const terminalAt = Date.parse(
      (pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt) ?? "",
    );
    if (Number.isFinite(terminalAt) && anchor !== null && terminalAt >= millis(anchor))
      return activity ?? thread.createdAt;
  }
  if (input.autoSettleAfterDays === null || activity === null) return null;
  // A passed wake timer restarts inactivity. An earlier wake can only delay settlement.
  const nowMs = DateTime.toEpochMillis(input.now);
  const timerWake =
    thread.snoozedUntil != null && millis(thread.snoozedUntil) <= nowMs
      ? thread.snoozedUntil
      : null;
  const inactivity = latest([activity, thread.lastSnoozeWakeAt, timerWake]) ?? activity;
  return millis(inactivity) < nowMs - input.autoSettleAfterDays * DAY_MS ? inactivity : null;
}
