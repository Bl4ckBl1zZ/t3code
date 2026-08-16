import { WorktreeRetentionSettings } from "@t3tools/contracts";
import * as Duration from "effect/Duration";

export type WorktreeRetentionSafetyState = boolean | "unknown";

export type WorktreeRetentionPullRequestState = "merged" | "not_merged" | "unknown";

export type WorktreeRetentionCandidate = {
  readonly worktreePath: string;
  readonly createdAtMs: number | null;
  readonly lastActivityAtMs: number | null;
  readonly pullRequestState: WorktreeRetentionPullRequestState;
  readonly safety: {
    readonly managed: WorktreeRetentionSafetyState;
    readonly pathWithinManagedRoot: WorktreeRetentionSafetyState;
    readonly gitWorktreePresent: WorktreeRetentionSafetyState;
    readonly projectRoot: WorktreeRetentionSafetyState;
    readonly gitClean: WorktreeRetentionSafetyState;
    readonly inUse: WorktreeRetentionSafetyState;
    readonly sharedOwner: WorktreeRetentionSafetyState;
  };
};

export type WorktreeRetentionRule = "maxAge" | "staleAfter" | "pullRequestMerged";

export type WorktreeRetentionSkipReason =
  | "retention_disabled"
  | "no_rules_configured"
  | "not_old_or_stale"
  | "max_age_unknown"
  | "stale_activity_unknown"
  | "pr_unknown"
  | "unmanaged"
  | "ownership_unknown"
  | "path_outside_managed_root"
  | "path_boundary_unknown"
  | "not_git_worktree"
  | "git_worktree_unknown"
  | "project_root"
  | "project_root_unknown"
  | "dirty_worktree"
  | "git_state_unknown"
  | "active_use"
  | "active_use_unknown"
  | "shared_owner"
  | "shared_owner_unknown";

export type WorktreeRetentionEvaluation =
  | {
      readonly eligible: true;
      readonly action: "report" | "delete";
      readonly matchedRules: ReadonlyArray<WorktreeRetentionRule>;
    }
  | {
      readonly eligible: false;
      readonly reasons: ReadonlyArray<WorktreeRetentionSkipReason>;
    };

/**
 * The moment a candidate's time rules first make it eligible, or null when it
 * has none that can be predicted.
 *
 * The two time rules are plain thresholds, so their due time is known long
 * before it arrives — which is what lets the scan sleep until a worktree is
 * actually due instead of rechecking everything on a fixed cadence.
 * `pullRequestMerged` has no due time by nature: nothing here can know when a
 * pull request will merge, so a candidate whose only rule is that one keeps
 * waiting for the periodic scan.
 *
 * Deliberately mirrors the comparisons in `evaluateWorktreeRetentionCandidate`
 * rather than restating them loosely: a deadline that disagrees with the
 * evaluator either wakes the scan for a worktree it then declines to touch, or
 * lets an eligible one sleep past its threshold.
 */
export const worktreeRetentionDeadlineMs = (input: {
  readonly settings: WorktreeRetentionSettings;
  readonly candidate: Pick<WorktreeRetentionCandidate, "createdAtMs" | "lastActivityAtMs">;
}): number | null => {
  const { candidate, settings } = input;
  if (settings.mode === "off") return null;

  const dueAtMs: Array<number> = [];
  if (settings.maxAge !== null && candidate.createdAtMs !== null) {
    dueAtMs.push(candidate.createdAtMs + Duration.toMillis(settings.maxAge));
  }
  if (settings.staleAfter !== null && candidate.lastActivityAtMs !== null) {
    dueAtMs.push(candidate.lastActivityAtMs + Duration.toMillis(settings.staleAfter));
  }

  return dueAtMs.length === 0 ? null : Math.min(...dueAtMs);
};

const addSafetyReason = (
  reasons: Array<WorktreeRetentionSkipReason>,
  state: WorktreeRetentionSafetyState,
  unsafeReason: WorktreeRetentionSkipReason,
  unknownReason: WorktreeRetentionSkipReason,
): void => {
  if (state === true) return;
  reasons.push(state === "unknown" ? unknownReason : unsafeReason);
};

const addFalseSafetyReason = (
  reasons: Array<WorktreeRetentionSkipReason>,
  state: WorktreeRetentionSafetyState,
  unsafeReason: WorktreeRetentionSkipReason,
  unknownReason: WorktreeRetentionSkipReason,
): void => {
  if (state === false) return;
  reasons.push(state === "unknown" ? unknownReason : unsafeReason);
};

export const evaluateWorktreeRetentionCandidate = (input: {
  readonly nowMs: number;
  readonly settings: WorktreeRetentionSettings;
  readonly candidate: WorktreeRetentionCandidate;
}): WorktreeRetentionEvaluation => {
  const { candidate, settings } = input;

  if (settings.mode === "off") {
    return { eligible: false, reasons: ["retention_disabled"] };
  }

  const hasAgeRule = settings.maxAge !== null;
  const hasStaleRule = settings.staleAfter !== null;
  const hasMergeRule = settings.deleteOnPullRequestMerge;
  if (!hasAgeRule && !hasStaleRule && !hasMergeRule) {
    return { eligible: false, reasons: ["no_rules_configured"] };
  }

  const safetyReasons: Array<WorktreeRetentionSkipReason> = [];
  addSafetyReason(safetyReasons, candidate.safety.managed, "unmanaged", "ownership_unknown");
  addSafetyReason(
    safetyReasons,
    candidate.safety.pathWithinManagedRoot,
    "path_outside_managed_root",
    "path_boundary_unknown",
  );
  addSafetyReason(
    safetyReasons,
    candidate.safety.gitWorktreePresent,
    "not_git_worktree",
    "git_worktree_unknown",
  );
  if (candidate.safety.projectRoot === true) safetyReasons.push("project_root");
  if (candidate.safety.projectRoot === "unknown") safetyReasons.push("project_root_unknown");
  addSafetyReason(safetyReasons, candidate.safety.gitClean, "dirty_worktree", "git_state_unknown");
  addFalseSafetyReason(safetyReasons, candidate.safety.inUse, "active_use", "active_use_unknown");
  addFalseSafetyReason(
    safetyReasons,
    candidate.safety.sharedOwner,
    "shared_owner",
    "shared_owner_unknown",
  );
  if (safetyReasons.length > 0) {
    return { eligible: false, reasons: safetyReasons };
  }

  const matchedRules: Array<WorktreeRetentionRule> = [];
  if (
    settings.maxAge !== null &&
    candidate.createdAtMs !== null &&
    input.nowMs >= candidate.createdAtMs &&
    input.nowMs - candidate.createdAtMs >= Duration.toMillis(settings.maxAge)
  ) {
    matchedRules.push("maxAge");
  }

  if (settings.staleAfter !== null) {
    if (
      candidate.lastActivityAtMs !== null &&
      input.nowMs >= candidate.lastActivityAtMs &&
      input.nowMs - candidate.lastActivityAtMs >= Duration.toMillis(settings.staleAfter)
    ) {
      matchedRules.push("staleAfter");
    }
  }

  if (settings.deleteOnPullRequestMerge && candidate.pullRequestState === "merged") {
    matchedRules.push("pullRequestMerged");
  }

  if (matchedRules.length === 0) {
    if (settings.deleteOnPullRequestMerge && candidate.pullRequestState === "unknown") {
      return { eligible: false, reasons: ["pr_unknown"] };
    }
    if (settings.staleAfter !== null && candidate.lastActivityAtMs === null) {
      return { eligible: false, reasons: ["stale_activity_unknown"] };
    }
    if (settings.maxAge !== null && candidate.createdAtMs === null) {
      return { eligible: false, reasons: ["max_age_unknown"] };
    }
    return { eligible: false, reasons: ["not_old_or_stale"] };
  }

  return {
    eligible: true,
    action: settings.mode === "report" ? "report" : "delete",
    matchedRules,
  };
};
