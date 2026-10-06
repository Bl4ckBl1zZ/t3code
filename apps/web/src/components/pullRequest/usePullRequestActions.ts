/**
 * The actions a pull request offers, shared by every surface that performs them — the detail
 * panel and the list's quick actions. Two copies of "merge" would drift apart one fix at a time;
 * these hooks are where that behavior lives, and the panels are only where it is rendered.
 */
import { useAtomValue } from "@effect/atom-react";
import type { PullRequestMergePreparation } from "@t3tools/client-runtime/state/pull-requests";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestRef,
} from "@t3tools/contracts";
import { resolveProjectPullRequestMergeMethod } from "@t3tools/shared/serverSettings";
import { useCallback, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import {
  ACTION_FAILURE_LABELS,
  ACTION_SUCCESS_LABELS,
  type PullRequestActionOptions,
  type PullRequestActionPhase,
  sendPullRequestAction,
} from "./pullRequestActions.logic";
import { readableFailure } from "./pullRequestDetail.logic";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

/**
 * The project's merge method, then the machine's. Null when neither is set, where the method
 * last chosen on this device applies instead.
 */
export function usePullRequestDefaultMergeMethod(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): PullRequestMergeMethod | null {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return settings === null ? null : resolveProjectPullRequestMergeMethod(settings, projectId);
}

/** The same answer read once, at a click, so a long list of rows subscribes to nothing. */
export function readPullRequestDefaultMergeMethod(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): PullRequestMergeMethod | null {
  const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  return settings === null ? null : resolveProjectPullRequestMergeMethod(settings, projectId);
}

/**
 * Runs one host action against a pull request, with the toasts every surface says the same way.
 * One action at a time per runner: the pending action is the one whose button may say what it is
 * doing, and every other control waits for it.
 */
export function usePullRequestActionRunner({
  environmentId,
  reference,
  onActed,
  prepareMerge,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef | null;
  onActed?: (action: PullRequestAction, phase: PullRequestActionPhase) => void;
  /**
   * Small surfaces settle the merge method from the host's answer when the merge runs, rather
   * than for every row on screen.
   */
  prepareMerge?: PullRequestMergePreparation;
}) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [pendingAction, setPendingAction] = useState<PullRequestAction | null>(null);
  // State lags a double click; the ref does not.
  const pendingRef = useRef(false);

  /** Resolves true once the host has done it, false for a refusal or a press that was ignored. */
  const perform = async (
    action: PullRequestAction,
    options: PullRequestActionOptions = {},
  ): Promise<boolean> => {
    if (pendingRef.current || reference === null) return false;
    pendingRef.current = true;
    setPendingAction(action);
    try {
      const outcome = await sendPullRequestAction({
        action,
        options,
        prepareMerge,
        run: (request) => runAction({ environmentId, input: { ...reference, action, ...request } }),
        onActed: (acted, phase) => {
          // The toast goes first, so whatever the caller re-reads lands under the answer.
          if (phase === "done") {
            toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[acted] });
          }
          onActed?.(acted, phase);
        },
      });
      if (outcome._tag === "failed") {
        // The host's own sentence, because it is the only thing that says why. A merge strategy a
        // branch policy forbids is refused at completion and nowhere earlier — Azure DevOps
        // publishes no per-strategy availability to hide the control with — so "action failed"
        // would leave the reader pressing the same button again.
        toastManager.add({
          type: "error",
          title: ACTION_FAILURE_LABELS[action],
          description: readableFailure(outcome.failure, outcome.hint),
        });
      }
      return outcome._tag === "done";
    } finally {
      pendingRef.current = false;
      setPendingAction(null);
    }
  };

  return { pendingAction, actionPending: pendingAction !== null, perform };
}

/**
 * Closes a swept batch through the same per-environment lanes as single actions, in sweep order.
 * Each row reports its own phases, so a refused close goes back on the list to retry.
 */
export function usePullRequestCloseBatch(
  onActed: (entry: EnvironmentPullRequestEntry, phase: PullRequestActionPhase) => void,
) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const pending = useRef(new Set<string>());
  const [closingKeys, setClosingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const close = useCallback(
    async (entries: readonly EnvironmentPullRequestEntry[]) => {
      const batch = entries.filter((entry) => {
        const key = pullRequestEntryKey(entry);
        if (entry.state !== "open" || entry.provider !== "github" || pending.current.has(key))
          return false;
        pending.current.add(key);
        return true;
      });
      if (batch.length === 0) return;
      setClosingKeys(new Set(pending.current));
      let closed = 0;
      const failures: string[] = [];
      await Promise.all(
        batch.map(async (entry) => {
          try {
            const outcome = await sendPullRequestAction({
              action: "close",
              options: {},
              run: (request) =>
                runAction({
                  environmentId: entry.environmentId,
                  input: {
                    projectId: entry.projectId,
                    ...(entry.host === undefined ? {} : { host: entry.host }),
                    repository: entry.repository,
                    number: entry.number,
                    action: "close",
                    ...request,
                  },
                }),
              onActed: (_action, phase) => onActed(entry, phase),
            });
            if (outcome._tag === "done") closed++;
            if (outcome._tag === "failed") {
              failures.push(`#${entry.number}: ${readableFailure(outcome.failure, outcome.hint)}`);
            }
          } finally {
            pending.current.delete(pullRequestEntryKey(entry));
            setClosingKeys(new Set(pending.current));
          }
        }),
      );
      toastManager.add({
        type: failures.length > 0 ? "error" : "success",
        title:
          failures.length > 0
            ? `Closed ${closed} of ${batch.length} pull requests`
            : `Closed ${closed} pull request${closed === 1 ? "" : "s"}`,
        ...(failures.length > 0 ? { description: failures.slice(0, 3).join("\n") } : {}),
      });
    },
    [onActed, runAction],
  );
  return { close, closingKeys };
}
