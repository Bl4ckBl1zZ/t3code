import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequestChains";
import * as DateTime from "effect/DateTime";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
}

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
  | "snoozedAt"
  | "snoozedUntil"
  | "pinnedAt"
  | "workInboxRole"
  | "backgroundProcessCount"
  | "activeAgentCount"
  | "pullRequests"
>;

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
  if (thread.workInboxRole === "main") return false;
  if (
    thread.activeRunId !== null ||
    (thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.responseMode !== "message")
  )
    return false;
  if (["preparing", "queued", "starting", "running", "waiting"].includes(thread.status))
    return false;
  if ((thread.backgroundProcessCount ?? 0) > 0 || (thread.activeAgentCount ?? 0) > 0) return false;
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
  const anchor = latest([
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestRunRequestedAt,
  ]);
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
  return input.autoSettleAfterDays !== null &&
    activity !== null &&
    millis(activity) < DateTime.toEpochMillis(input.now) - input.autoSettleAfterDays * DAY_MS
    ? activity
    : null;
}
