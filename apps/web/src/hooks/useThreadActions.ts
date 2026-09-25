import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSettle, canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";

import { getFallbackThreadIdAfterDelete, pinOrderKeyBetween } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import {
  loadArchivedThreadShells,
  refreshArchivedThreadsForEnvironment,
} from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsPinReorder,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsVisitedTracking,
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import {
  formatOrphanedWorktreeRemovalMessage,
  formatWorktreePathForDisplay,
  getWorktreesOrphanedByDeletion,
  mergeWorktreeOwners,
} from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import * as ThreadUndo from "./threadUndo";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useAtomCommand } from "../state/use-atom-command";

export class ThreadArchiveBlockedError extends Schema.TaggedErrorClass<ThreadArchiveBlockedError>()(
  "ThreadArchiveBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Cannot archive a running thread.";
  }
}

export class ThreadSettlementUnsupportedError extends Schema.TaggedErrorClass<ThreadSettlementUnsupportedError>()(
  "ThreadSettlementUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support settling yet. Update the server to use Settle.";
  }
}

export class ThreadSettleBlockedError extends Schema.TaggedErrorClass<ThreadSettleBlockedError>()(
  "ThreadSettleBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This thread still needs attention. Resolve or interrupt it first, then try again.";
  }
}

export class ThreadSnoozeUnsupportedError extends Schema.TaggedErrorClass<ThreadSnoozeUnsupportedError>()(
  "ThreadSnoozeUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support snoozing yet. Update the server to use Snooze.";
  }
}

export class ThreadSnoozeBlockedError extends Schema.TaggedErrorClass<ThreadSnoozeBlockedError>()(
  "ThreadSnoozeBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This thread is waiting on you. Respond to the pending request before snoozing it.";
  }
}

/** Key that sorts before every arranged pinned thread, so a fresh pin lands
    at the top of the run. Undefined (keyless, sorts with the legacy block)
    when key math can't produce one — pinning must never fail on placement. */
function topOfPinnedRunOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of readThreadShells()) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

export class ThreadAutoSettleOptOutUnsupportedError extends Schema.TaggedErrorClass<ThreadAutoSettleOptOutUnsupportedError>()(
  "ThreadAutoSettleOptOutUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.";
  }
}

export class ThreadPinningUnsupportedError extends Schema.TaggedErrorClass<ThreadPinningUnsupportedError>()(
  "ThreadPinningUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support pinning yet. Update the server to use Pin.";
  }
}

/**
 * Marks a thread unread. Servers with visited tracking own the unread marker
 * (thread.mark-unread rewinds the server-side visited watermark, syncing the
 * marker to every device); older servers keep the browser-local marker.
 */
export function useMarkThreadUnread() {
  const markThreadUnreadMutation = useAtomCommand(threadEnvironment.markUnread, {
    reportFailure: false,
  });
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  return useCallback(
    (target: ScopedThreadRef) => {
      if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
        void markThreadUnreadMutation({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        return;
      }
      const thread = readThreadShell(target);
      markThreadUnreadLocal(scopedThreadKey(target), thread?.latestRun?.completedAt);
    },
    [markThreadUnreadLocal, markThreadUnreadMutation],
  );
}

export class ThreadPinReorderUnsupportedError extends Schema.TaggedErrorClass<ThreadPinReorderUnsupportedError>()(
  "ThreadPinReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This environment's server does not support reordering pinned threads yet. Update the server to reorder pins.";
  }
}

export async function requestThreadUnpinConfirmation(input: {
  enabled: boolean;
  title: string;
  confirm: ((message: string) => Promise<boolean>) | null;
}) {
  const { confirm } = input;
  if (!input.enabled || confirm === null) {
    return AsyncResult.success(true);
  }

  return settlePromise(() =>
    confirm(
      [
        `Unpin thread "${input.title}"?`,
        "This will move the thread out of your pinned section.",
      ].join("\n"),
    ),
  );
}

type OrphanedWorktree = {
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string;
  readonly worktreePath: string;
  /** Scoped keys of the deleting threads that hold this worktree. */
  readonly ownerKeys: ReadonlyArray<string>;
};

/** Report navigation separately so a completed deletion can still finish worktree cleanup. */
export async function navigateAfterThreadDeletion(navigate: () => Promise<void>) {
  const result = await settlePromise(navigate);
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Thread deleted, but navigation failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

export function useThreadActions() {
  const closeTerminal = useAtomCommand(terminalEnvironment.close);
  const archiveThreadMutation = useAtomCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useAtomCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useAtomCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const settleThreadMutation = useAtomCommand(threadEnvironment.settle, {
    reportFailure: false,
  });
  const unsettleThreadMutation = useAtomCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  const pinThreadMutation = useAtomCommand(threadEnvironment.pin, {
    reportFailure: false,
  });
  const unpinThreadMutation = useAtomCommand(threadEnvironment.unpin, {
    reportFailure: false,
  });
  const setThreadAutoSettleMutation = useAtomCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const reorderPinnedThreadMutation = useAtomCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const snoozeThreadMutation = useAtomCommand(threadEnvironment.snooze, {
    reportFailure: false,
  });
  const unsnoozeThreadMutation = useAtomCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const markThreadUnread = useMarkThreadUnread();
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  // Keep a ref so archiveThread can call handleNewThread without appearing in
  // its dependency array — handleNewThread is inherently unstable (depends on
  // the projects list) and would otherwise cascade new references into every
  // sidebar row via archiveThread → attemptArchiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;

  const resolveThreadTarget = useCallback((target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  }, []);
  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const unarchiveThread = useCallback(
    async (target: ScopedThreadRef, opts: { navigate?: boolean } = {}) => {
      ThreadUndo.invalidate("archive", scopedThreadKey(target));
      const result = await unarchiveThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Failure") {
        return result;
      }
      refreshArchivedThreadsForEnvironment(target.environmentId);
      if (opts.navigate) {
        return settlePromise(() =>
          router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          }),
        );
      }
      return result;
    },
    [router, unarchiveThreadMutation],
  );

  const archiveThread = useCallback(
    async (target: ScopedThreadRef, opts: { onArchived?: () => void } = {}) => {
      const resolved = resolveThreadTarget(target);
      if (!resolved) return AsyncResult.success(undefined);
      const { thread, threadRef } = resolved;
      if (thread.runtime?.status === "running" && thread.runtime.activeRunId != null) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadArchiveBlockedError({
              environmentId: threadRef.environmentId,
              threadId: threadRef.threadId,
            }),
          ),
        );
      }

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToDraft =
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId;
      const action = ThreadUndo.begin("archive", scopedThreadKey(threadRef));
      const archiveResult = await archiveThreadMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (archiveResult._tag === "Failure") {
        action.finish();
        return archiveResult;
      }
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      opts.onArchived?.();
      showThreadUndoNotice({
        action: "Archived",
        claim: action,
        // Undo also brings the reader back when archiving moved them to a draft.
        undo: () => unarchiveThread(threadRef, { navigate: shouldNavigateToDraft }),
        failureTitle: "Failed to undo archive",
      });

      if (shouldNavigateToDraft) {
        const navigationResult = await settlePromise(() =>
          handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId)),
        );
        if (navigationResult._tag === "Failure") {
          return navigationResult;
        }
        return archiveResult;
      }

      return archiveResult;
    },
    [archiveThreadMutation, getCurrentRouteThreadRef, resolveThreadTarget, unarchiveThread],
  );

  // Asks once whether to remove the worktrees a delete leaves unused. Null
  // when there is no dialog surface to ask on; the worktrees are then kept.
  const confirmOrphanedWorktreeRemoval = useCallback(
    async (input: { threadCount: number; worktreePaths: ReadonlyArray<string> }) => {
      const localApi = readLocalApi();
      if (!localApi) {
        return null;
      }
      return await settlePromise(() =>
        localApi.dialogs.confirm(formatOrphanedWorktreeRemovalMessage(input), {
          variant: "destructive",
        }),
      );
    },
    [],
  );

  // Removes worktrees whose last threads are gone, then refreshes Git status
  // once per project. The threads are already deleted by this point, so a
  // failure here is reported but never rolled back.
  const removeOrphanedWorktrees = useCallback(
    async (worktrees: ReadonlyArray<OrphanedWorktree>) => {
      const reportFailure = (
        title: string,
        description: string,
        error: unknown,
        worktree: OrphanedWorktree,
      ) => {
        console.error("Failed to clean up orphaned worktree after thread deletion", {
          projectCwd: worktree.projectCwd,
          worktreePath: worktree.worktreePath,
          error,
        });
        toastManager.add(stackedThreadToast({ type: "error", title, description }));
      };

      const removedByProject = new Map<string, OrphanedWorktree>();
      // One at a time: removals in the same repository contend for its Git lock.
      for (const worktree of worktrees) {
        const removeResult = await removeWorktree({
          environmentId: worktree.environmentId,
          input: { cwd: worktree.projectCwd, path: worktree.worktreePath, force: true },
        });
        if (removeResult._tag === "Failure") {
          const error = squashAtomCommandFailure(removeResult);
          const message =
            error instanceof Error ? error.message : "Unknown error removing worktree.";
          reportFailure(
            "Thread deleted, but worktree removal failed",
            `Could not remove ${formatWorktreePathForDisplay(worktree.worktreePath)}. ${message}`,
            error,
            worktree,
          );
          continue;
        }
        removedByProject.set(`${worktree.environmentId}:${worktree.projectCwd}`, worktree);
      }

      for (const worktree of removedByProject.values()) {
        const refreshResult = await refreshVcsStatus({
          environmentId: worktree.environmentId,
          input: { cwd: worktree.projectCwd },
        });
        if (refreshResult._tag === "Failure") {
          const error = squashAtomCommandFailure(refreshResult);
          reportFailure(
            "Worktree deleted, but Git status refresh failed",
            error instanceof Error ? error.message : "Unknown error refreshing Git status.",
            error,
            worktree,
          );
        }
      }
    },
    [refreshVcsStatus, removeWorktree],
  );

  /**
   * Deletes threads as one batch. Worktree ownership, the worktree question
   * and the post-delete route are all decided once up front, so a bulk delete
   * asks at most one question and never routes through a thread it is about
   * to delete. The worktree question follows the delete confirmation setting;
   * with it off, orphaned worktrees are kept. Results line up with `targets`.
   */
  const deleteThreads = useCallback(
    async (
      targets: ReadonlyArray<ScopedThreadRef>,
    ): Promise<ReadonlyArray<AtomCommandResult<unknown, unknown>>> => {
      const environmentIds = [...new Set(targets.map((target) => target.environmentId))];
      const plans = await Promise.all(
        environmentIds.map(async (environmentId) => {
          const deletingIds = new Set(
            targets.flatMap((target) =>
              target.environmentId === environmentId ? [target.threadId] : [],
            ),
          );
          const threads = readEnvironmentThreadRefs(environmentId).flatMap((ref) => {
            const shell = readThreadShell(ref);
            return shell === null ? [] : [shell];
          });
          // Archived threads are absent from the main shell store but still
          // carry a worktreePath, so orphan detection has to see them — and
          // only orphan detection. Skipped when no target can hold a worktree,
          // so the common delete never waits on this snapshot.
          const mayOwnWorktree = [...deletingIds].some((threadId) => {
            const shell = threads.find((thread) => thread.id === threadId);
            return shell === undefined || shell.worktreePath !== null;
          });
          const archivedThreads = mayOwnWorktree
            ? await loadArchivedThreadShells(environmentId)
            : [];
          const orphanedWorktrees = [
            ...getWorktreesOrphanedByDeletion(
              mergeWorktreeOwners(threads, archivedThreads),
              deletingIds,
            ),
          ].flatMap(([worktreePath, ownerIds]): OrphanedWorktree[] => {
            const ownerId = ownerIds[0];
            const owner =
              threads.find((thread) => thread.id === ownerId) ??
              archivedThreads.find((thread) => thread.id === ownerId);
            const projectCwd = owner
              ? (readProject({ environmentId, projectId: owner.projectId })?.workspaceRoot ?? null)
              : null;
            if (projectCwd === null) return [];
            return [
              {
                environmentId,
                projectCwd,
                worktreePath,
                ownerKeys: ownerIds.map((threadId) =>
                  scopedThreadKey(scopeThreadRef(environmentId, threadId)),
                ),
              },
            ];
          });
          return { environmentId, deletingIds, threads, orphanedWorktrees };
        }),
      );

      const orphanedWorktrees = plans.flatMap((plan) => plan.orphanedWorktrees);
      let shouldRemoveWorktrees = false;
      if (orphanedWorktrees.length > 0 && confirmThreadDelete) {
        const confirmation = await confirmOrphanedWorktreeRemoval({
          threadCount: targets.length,
          worktreePaths: orphanedWorktrees.map((worktree) => worktree.worktreePath),
        });
        if (confirmation?._tag === "Failure") {
          return targets.map(() => confirmation);
        }
        shouldRemoveWorktrees = confirmation?.value === true;
      }

      // The fallback skips every thread in the batch, not just the ones
      // already gone, so deleting the open thread lands on a survivor.
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const routePlan =
        currentRouteThreadRef === null
          ? undefined
          : plans.find(
              (plan) =>
                plan.environmentId === currentRouteThreadRef.environmentId &&
                plan.deletingIds.has(currentRouteThreadRef.threadId),
            );
      const fallbackThreadId =
        currentRouteThreadRef && routePlan
          ? getFallbackThreadIdAfterDelete({
              threads: routePlan.threads,
              deletedThreadId: currentRouteThreadRef.threadId,
              deletedThreadIds: routePlan.deletingIds,
              sortOrder: sidebarThreadSortOrder,
            })
          : null;

      const results = await Promise.all(
        targets.map(async (target) => {
          // Archived threads have no session, terminal or drafts to release.
          const thread = readThreadShell(target);
          if (thread !== null) {
            if (thread.runtime !== null) {
              await stopThreadSession({
                environmentId: target.environmentId,
                input: { threadId: target.threadId },
              });
            }
            await closeTerminal({
              environmentId: target.environmentId,
              input: { threadId: target.threadId, deleteHistory: true },
            });
          }
          const result = await deleteThreadMutation({
            environmentId: target.environmentId,
            input: { threadId: target.threadId },
          });
          if (result._tag === "Success" && thread !== null) {
            releaseComposerDraftUploads(target);
            clearComposerDraftForThread(target);
            clearProjectDraftThreadById(
              scopeProjectRef(target.environmentId, thread.projectId),
              target,
            );
            clearTerminalUiState(target);
          }
          return result;
        }),
      );

      const deletedThreadKeys = new Set(
        targets.flatMap((target, index) =>
          results[index]?._tag === "Success" ? [scopedThreadKey(target)] : [],
        ),
      );
      for (const environmentId of environmentIds) {
        refreshArchivedThreadsForEnvironment(environmentId);
      }

      if (currentRouteThreadRef && deletedThreadKeys.has(scopedThreadKey(currentRouteThreadRef))) {
        const fallbackThread = fallbackThreadId
          ? readThreadShell(scopeThreadRef(currentRouteThreadRef.environmentId, fallbackThreadId))
          : null;
        await navigateAfterThreadDeletion(() =>
          fallbackThread
            ? router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
                ),
                replace: true,
              })
            : router.navigate({ to: "/", replace: true }),
        );
      }

      if (shouldRemoveWorktrees) {
        // A worktree goes only when every thread holding it was deleted.
        await removeOrphanedWorktrees(
          orphanedWorktrees.filter((worktree) =>
            worktree.ownerKeys.every((key) => deletedThreadKeys.has(key)),
          ),
        );
      }
      return results;
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalUiState,
      closeTerminal,
      confirmOrphanedWorktreeRemoval,
      confirmThreadDelete,
      deleteThreadMutation,
      getCurrentRouteThreadRef,
      removeOrphanedWorktrees,
      router,
      sidebarThreadSortOrder,
      stopThreadSession,
    ],
  );

  const deleteThread = useCallback(
    async (target: ScopedThreadRef) => {
      const [result] = await deleteThreads([target]);
      return result ?? AsyncResult.success(undefined);
    },
    [deleteThreads],
  );

  const unsettleThread = useCallback(
    async (target: ScopedThreadRef) => {
      if (!readEnvironmentSupportsSettlement(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadSettlementUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      ThreadUndo.invalidate("settle", scopedThreadKey(target));
      // reason "user" pins the thread active: auto-settle (PR merged /
      // inactivity) stays suppressed until real activity clears the pin.
      return unsettleThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, reason: "user" },
      });
    },
    [unsettleThreadMutation],
  );

  /** Turns automatic settlement (inactivity, merged PR) on or off for one thread. */
  const setThreadAutoSettle = useCallback(
    async (target: ScopedThreadRef, enabled: boolean) => {
      if (!readEnvironmentSupportsAutoSettleOptOut(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadAutoSettleOptOutUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      return setThreadAutoSettleMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, enabled },
      });
    },
    [setThreadAutoSettleMutation],
  );

  const pinThread = useCallback(
    async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
      // Version skew: never send the command to a server that predates it.
      if (!readEnvironmentSupportsPinning(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadPinningUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      // Every pin path places the thread at the top of the arranged run:
      // callers with a better anchor (the sidebar, which knows the displayed
      // order) pass their own key; everyone else (chat header, context menus)
      // gets the default so the same action never places differently.
      // orderKey rides only to servers that decode it; pre-reorder servers
      // get the bare pin they understand and the thread stays keyless.
      const orderKey = readEnvironmentSupportsPinReorder(target.environmentId)
        ? (opts.orderKey ?? topOfPinnedRunOrderKey())
        : undefined;
      ThreadUndo.invalidate("pin", scopedThreadKey(target));
      return pinThreadMutation({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          ...(orderKey !== undefined ? { orderKey } : {}),
        },
      });
    },
    [pinThreadMutation],
  );

  const unpinThread = useCallback(
    async (target: ScopedThreadRef) => {
      if (!readEnvironmentSupportsPinning(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadPinningUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      const orderKey = readThreadShell(target)?.pinOrderKey ?? undefined;
      const action = ThreadUndo.begin("pin", scopedThreadKey(target));
      const result = await unpinThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success" && action.isCurrent()) {
        showThreadUndoNotice({
          action: "Unpinned",
          claim: action,
          undo: () => pinThread(target, orderKey === undefined ? {} : { orderKey }),
          failureTitle: "Failed to undo unpin",
        });
      } else {
        action.finish();
      }
      return result;
    },
    [pinThread, unpinThreadMutation],
  );

  const settleThread = useCallback(
    async (target: ScopedThreadRef) => {
      // Version skew: never send the command to a server that predates it —
      // the raw protocol rejection would read as a random failure.
      if (!readEnvironmentSupportsSettlement(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadSettlementUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      const resolved = resolveThreadTarget(target);
      // Settle may only target what effectiveSettled could classify as
      // settled: not starting/running sessions, not threads waiting on
      // approvals or user input. Anything else would hide live work.
      if (resolved && !canSettle(resolved.thread, { now: new Date().toISOString() })) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadSettleBlockedError({
              environmentId: resolved.threadRef.environmentId,
              threadId: resolved.threadRef.threadId,
            }),
          ),
        );
      }
      // A user settle drops the pin server-side (keeping its order key) but
      // leaves any snooze alone, so Undo only has to put the pin back.
      const wasPinned = resolved?.thread.pinnedAt != null;
      const pinOrderKey = wasPinned ? resolved?.thread.pinOrderKey : null;
      // An older unpin/snooze Undo would re-pin or wake a thread that is now
      // settled, which the server refuses or which fights the settle.
      ThreadUndo.invalidate("pin", scopedThreadKey(target));
      ThreadUndo.invalidate("snooze", scopedThreadKey(target));
      const action = ThreadUndo.begin("settle", scopedThreadKey(target));
      const result = await settleThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag !== "Success") {
        action.finish();
        return result;
      }
      showThreadUndoNotice({
        action: "Settled",
        claim: action,
        undo: async () => {
          const unsettled = await unsettleThread(target);
          if (unsettled._tag !== "Success" || !wasPinned) return unsettled;
          return pinThread(target, pinOrderKey == null ? {} : { orderKey: pinOrderKey });
        },
        failureTitle: "Failed to undo settle",
      });
      return result;
    },
    [pinThread, resolveThreadTarget, settleThreadMutation, unsettleThread],
  );

  const confirmAndUnpinThread = useCallback(
    async (target: ScopedThreadRef) => {
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      const confirmationResult = await requestThreadUnpinConfirmation({
        enabled: confirmThreadUnpin,
        title: resolved?.thread.title ?? "this thread",
        confirm: localApi ? (message) => localApi.dialogs.confirm(message) : null,
      });
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      if (!confirmationResult.value) {
        return AsyncResult.success(undefined);
      }
      return unpinThread(target);
    },
    [confirmThreadUnpin, resolveThreadTarget, unpinThread],
  );

  const reorderPinnedThread = useCallback(
    async (target: ScopedThreadRef, orderKey: string) => {
      // Callers (the sidebar drag handler) only enable dragging on
      // reorder-capable environments; this guard covers races around
      // capability changes mid-drag.
      if (!readEnvironmentSupportsPinReorder(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadPinReorderUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      ThreadUndo.invalidate("pin", scopedThreadKey(target));
      return reorderPinnedThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, orderKey },
      });
    },
    [reorderPinnedThreadMutation],
  );

  const unsnoozeThread = useCallback(
    async (target: ScopedThreadRef) => {
      if (!readEnvironmentSupportsSnooze(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadSnoozeUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      ThreadUndo.invalidate("snooze", scopedThreadKey(target));
      return unsnoozeThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, reason: "user" },
      });
    },
    [unsnoozeThreadMutation],
  );

  const snoozeThread = useCallback(
    async (target: ScopedThreadRef, snoozedUntil: string) => {
      // Version skew: never send the command to a server that predates it.
      if (!readEnvironmentSupportsSnooze(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadSnoozeUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      const resolved = resolveThreadTarget(target);
      // Blocked-on-you work and queued turns can't be snoozed away —
      // client-side twin of the server invariants so the UI rejects before
      // a round trip.
      if (resolved && !canSnooze(resolved.thread, { now: new Date().toISOString() })) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadSnoozeBlockedError({
              environmentId: resolved.threadRef.environmentId,
              threadId: resolved.threadRef.threadId,
            }),
          ),
        );
      }
      // Snoozing drops the pin server-side (keeping its order key), and a
      // snoozed thread cannot be pinned, so an older unpin Undo is void and
      // this Undo puts the pin back itself.
      const wasPinned = resolved?.thread.pinnedAt != null;
      const pinOrderKey = wasPinned ? resolved?.thread.pinOrderKey : null;
      ThreadUndo.invalidate("pin", scopedThreadKey(target));
      const action = ThreadUndo.begin("snooze", scopedThreadKey(target));
      const result = await snoozeThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, snoozedUntil },
      });
      if (result._tag !== "Success") {
        action.finish();
        return result;
      }
      // Snooze hides the row, so keep its confirmation in the sidebar.
      showThreadUndoNotice({
        action: "Snoozed",
        claim: action,
        undo: async () => {
          const woken = await unsnoozeThread(target);
          if (woken._tag !== "Success" || !wasPinned) return woken;
          return pinThread(target, pinOrderKey == null ? {} : { orderKey: pinOrderKey });
        },
        failureTitle: "Failed to wake thread",
      });
      return result;
    },
    [pinThread, resolveThreadTarget, snoozeThreadMutation, unsnoozeThread],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef) => {
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);

      if (confirmThreadDelete && localApi) {
        const title = resolved?.thread.title ?? "this thread";
        const confirmationResult = await settlePromise(() =>
          localApi.dialogs.confirm(
            [
              `Delete thread "${title}"?`,
              "This permanently clears conversation history for this thread.",
            ].join("\n"),
          ),
        );
        if (confirmationResult._tag === "Failure") {
          return confirmationResult;
        }
        if (!confirmationResult.value) {
          return AsyncResult.success(undefined);
        }
      }

      return deleteThread(target);
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget],
  );

  return useMemo(
    () => ({
      archiveThread,
      unarchiveThread,
      deleteThread,
      deleteThreads,
      confirmAndDeleteThread,
      settleThread,
      unsettleThread,
      snoozeThread,
      unsnoozeThread,
      markThreadUnread,
      pinThread,
      unpinThread,
      confirmAndUnpinThread,
      reorderPinnedThread,
      setThreadAutoSettle,
    }),
    [
      archiveThread,
      confirmAndDeleteThread,
      confirmAndUnpinThread,
      deleteThread,
      deleteThreads,
      markThreadUnread,
      pinThread,
      reorderPinnedThread,
      setThreadAutoSettle,
      settleThread,
      snoozeThread,
      unarchiveThread,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );
}
