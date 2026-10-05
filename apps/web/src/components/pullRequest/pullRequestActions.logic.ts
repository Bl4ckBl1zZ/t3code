/**
 * What a pull request action says and the order it reports in, shared by every surface that runs
 * one. Kept out of the hook so the order the list relies on can be tested without rendering.
 */
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestUpdateMethod,
} from "@t3tools/contracts";

export const ACTION_SUCCESS_LABELS: Record<PullRequestAction, string> = {
  merge: "Pull request merged",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: "Pull request closed",
  reopen: "Pull request reopened",
  "update-branch": "Branch updated with the base branch",
  // True whichever it did: a pull request that was already mergeable merges the moment this is
  // armed, and the client has no way to tell that apart from one still waiting on something.
  "enable-auto-merge":
    "Auto-merge turned on — merges as soon as this is ready, sooner if it already is",
  "disable-auto-merge": "Auto-merge turned off",
  revert: "Revert pull request opened",
  "approve-workflows": "Workflows approved",
};

/** Said as the thing that did not happen, rather than as the operation that returned an error. */
export const ACTION_FAILURE_LABELS: Record<PullRequestAction, string> = {
  merge: "Could not merge this pull request",
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: "Could not close this pull request",
  reopen: "Could not reopen this pull request",
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not turn on auto-merge",
  "disable-auto-merge": "Could not turn off auto-merge",
  revert: "Could not open a revert pull request",
  "approve-workflows": "Could not approve workflows",
};

/** What to try, for the times the host says only that it refused. */
const ACTION_FAILURE_HINTS: Record<PullRequestAction, string> = {
  merge:
    "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ready: "The host refused it. Check that you have write access to this repository.",
  draft: "The host refused it. Check that you have write access to this repository.",
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, and that the branch still exists.",
  // Said for the merge commit, which is what an update is unless a rebase was asked for. The
  // rebase has its own reasons to fail and its own sentence below.
  "update-branch":
    "The host refused it. Check that you have write access to the branch — one from a fork also needs its author to allow edits from maintainers — and that it does not conflict with the base.",
  // The one refusal that is usually a repository setting rather than anything about this branch:
  // GitHub will not arm an auto-merge at all unless the repository has the feature switched on.
  "enable-auto-merge":
    "The host refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.",
  "disable-auto-merge":
    "The host refused it. Check that you have write access, and that the merge has not already happened.",
  revert:
    "The host refused it. Check that you have write access and that this pull request was merged on the host.",
  "approve-workflows":
    "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
};

/**
 * Said instead of the update hint when the reader asked for a rebase: it is the one that fails on
 * its own merits, because GitHub replays the commits and stops at the first that does not apply.
 * Offering the merge commit only makes sense to somebody who did not already choose it.
 */
const UPDATE_BRANCH_REBASE_FAILURE_HINT =
  "The host refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.";

/**
 * Where an action is: "sent" the moment it leaves, so a list can answer before the host does;
 * "done" or "failed" once the host has spoken. A merge refused before it was sent — a stack, a
 * method the repository no longer allows — says nothing at all, since nothing left.
 */
export type PullRequestActionPhase = "sent" | "done" | "failed";

export interface PullRequestActionOptions {
  readonly mergeMethod?: PullRequestMergeMethod;
  readonly updateMethod?: PullRequestUpdateMethod;
  /**
   * Work that belongs to this action and holds it pending, such as the comment a close posts
   * first. Returning false stops the action before it is sent.
   */
  readonly before?: () => Promise<boolean>;
}

export type PullRequestActionOutcome =
  | { readonly _tag: "stopped" }
  | { readonly _tag: "done" }
  | { readonly _tag: "failed"; readonly failure: unknown; readonly hint: string };

/**
 * One action from the press to the host's answer, reporting each phase as it passes. Kept apart
 * from the hook so the order the list relies on — nothing before "sent", exactly one of "done" or
 * "failed" after it — is the same for every surface.
 */
export async function sendPullRequestAction(input: {
  readonly action: PullRequestAction;
  readonly options: PullRequestActionOptions;
  readonly resolveMergeMethod?: (() => Promise<PullRequestMergeMethod>) | undefined;
  readonly run: (request: {
    readonly mergeMethod?: PullRequestMergeMethod;
    readonly updateMethod?: PullRequestUpdateMethod;
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly onActed?:
    | ((action: PullRequestAction, phase: PullRequestActionPhase) => void)
    | undefined;
}): Promise<PullRequestActionOutcome> {
  const { action, options } = input;
  if (options.before && !(await options.before())) return { _tag: "stopped" };
  let mergeMethod = options.mergeMethod;
  if (mergeMethod === undefined && action === "merge" && input.resolveMergeMethod) {
    try {
      mergeMethod = await input.resolveMergeMethod();
    } catch (failure) {
      return { _tag: "failed", failure, hint: ACTION_FAILURE_HINTS[action] };
    }
  }
  const { updateMethod } = options;
  input.onActed?.(action, "sent");
  const result = await input.run({
    ...(mergeMethod ? { mergeMethod } : {}),
    ...(updateMethod ? { updateMethod } : {}),
  });
  if (result._tag === "Failure") {
    input.onActed?.(action, "failed");
    return {
      _tag: "failed",
      failure: squashAtomCommandFailure(result),
      // The hint stands for what was asked: a reader who chose a rebase is not offered the merge
      // commit they passed over.
      hint:
        updateMethod === "rebase"
          ? UPDATE_BRANCH_REBASE_FAILURE_HINT
          : ACTION_FAILURE_HINTS[action],
    };
  }
  input.onActed?.(action, "done");
  return { _tag: "done" };
}
