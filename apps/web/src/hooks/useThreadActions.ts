import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRouter } from "@tanstack/react-router";

import {
  deleteSelectedThreadEntries,
  getFallbackThreadIdAfterDelete,
  pinOrderKeyBetween,
} from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { orchestrationEnvironment } from "../state/orchestration";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsPinReorder,
  readEnvironmentSupportsActiveReorder,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsVisitedTracking,
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { clearThreadPreviewState } from "../previewStateStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import {
  formatOrphanedWorktreeRemovalMessage,
  formatWorktreePathForDisplay,
  getWorktreesOrphanedByDeletion,
} from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import * as ThreadUndo from "./threadUndo";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

export class ThreadArchiveBlockedError extends Schema.TaggedError<ThreadArchiveBlockedError>()(
  "ThreadArchiveBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Cannot archive while the provider is active.";
  }
}

export class ThreadSettlementUnsupportedError extends Schema.TaggedError<ThreadSettlementUnsupportedError>()(
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

export class ThreadSnoozeUnsupportedError extends Schema.TaggedError<ThreadSnoozeUnsupportedError>()(
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

export class ThreadSnoozeBlockedError extends Schema.TaggedError<ThreadSnoozeBlockedError>()(
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

function topOfPinnedRunOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of readThreadShells()) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

export class ThreadAutoSettleOptOutUnsupportedError extends Schema.TaggedError<ThreadAutoSettleOptOutUnsupportedError>()(
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

export class ThreadPinningUnsupportedError extends Schema.TaggedError<ThreadPinningUnsupportedError>()(
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

export class ThreadPinReorderUnsupportedError extends Schema.TaggedError<ThreadPinReorderUnsupportedError>()(
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

export class ThreadActiveReorderUnsupportedError extends Schema.TaggedError<ThreadActiveReorderUnsupportedError>()(
  "ThreadActiveReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "Update this environment's server to reorder active threads.";
  }
}

async function requestThreadUnpinConfirmation(input: {
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

function useMarkThreadUnread() {
  const markThreadUnreadMutation = useAtomCommand(threadEnvironment.markUnread, {
    reportFailure: false,
  });
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  return (target: ScopedThreadRef) => {
    if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
      void markThreadUnreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      return;
    }
    const thread = readThreadShell(target);
    markThreadUnreadLocal(scopedThreadKey(target), thread?.latestRun?.completedAt);
  };
}

export function useAcknowledgeThreadWoke() {
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  return (target: ScopedThreadRef, wokeAt: string) => {
    if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
      void visitThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visitedAt: wokeAt },
      });
      return;
    }
    markThreadVisited(scopedThreadKey(target), wokeAt);
  };
}

function threadOperationFailure(target: ScopedThreadRef) {
  return readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    ? null
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "This connection cannot change threads.",
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
}

export function useThreadActions() {
  const archiveThreadMutation = useOrchestrationCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useOrchestrationCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const settleThreadMutation = useOrchestrationCommand(threadEnvironment.settle, {
    reportFailure: false,
  });
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  const pinThreadMutation = useOrchestrationCommand(threadEnvironment.pin, {
    reportFailure: false,
  });
  const unpinThreadMutation = useOrchestrationCommand(threadEnvironment.unpin, {
    reportFailure: false,
  });
  const setThreadAutoSettleMutation = useOrchestrationCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const reorderPinnedThreadMutation = useOrchestrationCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveThreadMutation = useOrchestrationCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const snoozeThreadMutation = useOrchestrationCommand(threadEnvironment.snooze, {
    reportFailure: false,
  });
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const markThreadUnread = useMarkThreadUnread();
  const stopThreadSession = useOrchestrationCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const loadSessionState = useAtomQueryRunner(environmentSession.sessionStateAtom, {
    reportFailure: false,
  });
  const loadWorktreeThreadIds = useAtomQueryRunner(orchestrationEnvironment.worktreeThreadIds, {
    reportFailure: false,
    refresh: true,
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
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();

  const resolveThreadTarget = (target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  };
  const getCurrentRouteThreadRef = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  };

  const unarchiveThread = async (target: ScopedThreadRef, opts: { navigate?: boolean } = {}) => {
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
  };

  const archiveThread = async (target: ScopedThreadRef, opts: { onArchived?: () => void } = {}) => {
    const resolved = resolveThreadTarget(target);
    if (!resolved) return AsyncResult.success(undefined);
    const { thread, threadRef } = resolved;
    if (!threadRuntimeCanArchive(thread.runtime)) {
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
    const wokeAt = threadWokeAt(thread, { now: new Date().toISOString() });
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(threadRef), wokeAt);
    }
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    opts.onArchived?.();
    showThreadUndoNotice({
      action: "Archived",
      claim: action,
      undo: () => unarchiveThread(threadRef, { navigate: shouldNavigateToDraft }),
      failureTitle: "Failed to undo archive",
    });

    if (shouldNavigateToDraft) {
      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (navigationResult._tag === "Failure") {
        return navigationResult;
      }
      return archiveResult;
    }

    return archiveResult;
  };

  /**
   * Worktrees a batch delete leaves with no thread and that this client may
   * offer to remove. Worked out once per batch so a bulk delete asks at most
   * one worktree question. Archived targets are not in the shell store, so they
   * never own a worktree here (as before batching).
   */
  const findRemovableOrphanedWorktrees = async (targets: ReadonlyArray<ScopedThreadRef>) => {
    const localApi = readLocalApi();
    if (!localApi) return [];
    const worktrees: OrphanedWorktree[] = [];
    for (const environmentId of new Set(targets.map((target) => target.environmentId))) {
      const deletingIds = new Set(
        targets.flatMap((target) =>
          target.environmentId === environmentId ? [target.threadId] : [],
        ),
      );
      const threads = readEnvironmentThreadRefs(environmentId).flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell === null ? [] : [shell];
      });
      const environmentConfig = appAtomRegistry
        .get(environmentServerConfigsAtom)
        .get(environmentId);
      const candidates = [...getWorktreesOrphanedByDeletion(threads, deletingIds)].flatMap(
        ([worktreePath, ownerIds]) => {
          const owner = threads.find((thread) => thread.id === ownerIds[0]);
          const project = owner ? readProject({ environmentId, projectId: owner.projectId }) : null;
          if (
            !project ||
            isScratchProject(project, environmentConfig?.scratchWorkspaceRoot) ||
            // The server removes these itself when the project cleans up on delete.
            (environmentConfig?.settings &&
              resolveWorktreeCleanup(environmentConfig.settings, project.id).worktreeOnDelete)
          ) {
            return [];
          }
          return [
            {
              environmentId,
              projectCwd: project.workspaceRoot,
              worktreePath,
              ownerKeys: ownerIds.map((threadId) =>
                scopedThreadKey(scopeThreadRef(environmentId, threadId)),
              ),
            },
          ];
        },
      );
      const unshared: OrphanedWorktree[] = [];
      for (const candidate of candidates) {
        // A shell that leaves idle subagent children out cannot prove nobody else uses the
        // worktree, so the server's list decides. A failed read keeps the worktree.
        if (environmentConfig?.shellThreadFamilies === true) {
          const occupants = await loadWorktreeThreadIds({
            environmentId,
            input: { worktreePath: candidate.worktreePath },
          });
          if (
            occupants._tag !== "Success" ||
            occupants.value.threadIds.some((threadId) => !deletingIds.has(threadId))
          ) {
            continue;
          }
        }
        unshared.push(candidate);
      }
      if (unshared.length === 0) continue;
      const sessionResult = await loadSessionState(environmentId);
      if (
        sessionResult._tag === "Success" &&
        sessionGrantsScope(sessionResult.value, AuthSourceControlWriteScope)
      ) {
        worktrees.push(...unshared);
      }
    }
    return worktrees;
  };

  /**
   * Removes worktrees whose last threads are gone, one at a time (removals in
   * one repository contend for its Git lock), then refreshes Git status once
   * per project. The threads are already deleted, so failures get their own
   * toast and never count as a thread deletion error.
   */
  const removeOrphanedWorktrees = async (worktrees: ReadonlyArray<OrphanedWorktree>) => {
    const reportFailure = (title: string, description: string, worktree: OrphanedWorktree) => {
      console.error("Worktree cleanup failed after thread deletion", {
        projectCwd: worktree.projectCwd,
        worktreePath: worktree.worktreePath,
        description,
      });
      toastManager.add(stackedThreadToast({ type: "error", title, description }));
    };
    const failureMessage = (result: AsyncResult.Failure<unknown, unknown>) => {
      const error = squashAtomCommandFailure(result);
      return error instanceof Error ? error.message : "An error occurred.";
    };
    const removedByProject = new Map<string, OrphanedWorktree>();
    for (const worktree of worktrees) {
      const removeResult = readEnvironmentScope(worktree.environmentId, AuthSourceControlWriteScope)
        ? await removeWorktree({
            environmentId: worktree.environmentId,
            input: { cwd: worktree.projectCwd, path: worktree.worktreePath, force: true },
          })
        : AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                message: "This connection can no longer remove worktrees.",
                requiredScope: AuthSourceControlWriteScope,
              }),
            ),
          );
      if (removeResult._tag === "Failure") {
        reportFailure(
          "Failed to delete worktree",
          `Could not remove ${formatWorktreePathForDisplay(worktree.worktreePath)}. ${failureMessage(removeResult)}`,
          worktree,
        );
        continue;
      }
      const teardownFailure = removeResult.value?.teardownFailure;
      if (teardownFailure) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: `Teardown script "${teardownFailure.scriptName}" ${
              teardownFailure.timedOut ? "timed out" : "failed"
            }`,
            description: `The worktree was deleted anyway.${
              teardownFailure.detail ? ` ${teardownFailure.detail}` : ""
            }`,
          }),
        );
      }
      removedByProject.set(`${worktree.environmentId}:${worktree.projectCwd}`, worktree);
    }
    for (const worktree of removedByProject.values()) {
      const refreshResult = await refreshVcsStatus({
        environmentId: worktree.environmentId,
        input: { cwd: worktree.projectCwd },
      });
      if (refreshResult._tag === "Failure") {
        reportFailure(
          "Worktree deleted, but Git status refresh failed",
          failureMessage(refreshResult),
          worktree,
        );
      }
    }
  };

  /** Deletes one thread without touching its worktree. `batchThreadIds` are skipped as the route fallback. */
  const deleteThreadRecord = async (
    target: ScopedThreadRef,
    batchThreadIds: ReadonlySet<ThreadId>,
  ) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const resolved = resolveThreadTarget(target);
    if (!resolved) {
      const result = await deleteThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success") {
        refreshArchivedThreadsForEnvironment(target.environmentId);
        clearThreadPreviewState(target);
      }
      return result;
    }
    const { thread, threadRef } = resolved;
    const threads = readEnvironmentThreadRefs(threadRef.environmentId).flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null ? [] : [shell];
    });

    if (thread.runtime !== null) {
      await stopThreadSession({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    }

    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const shouldNavigateToFallback =
      currentRouteThreadRef?.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    // Skip the whole batch, so deleting the open thread never lands on a
    // thread that is about to be deleted too.
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads,
      deletedThreadId: threadRef.threadId,
      deletedThreadIds: batchThreadIds,
      sortOrder: sidebarThreadSortOrder,
    });

    const deleteResult = await deleteThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (deleteResult._tag === "Failure") {
      return deleteResult;
    }
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    releaseComposerDraftUploads(threadRef);
    clearComposerDraftForThread(threadRef);
    clearProjectDraftThreadById(
      scopeProjectRef(threadRef.environmentId, thread.projectId),
      threadRef,
    );
    clearTerminalUiState(threadRef);
    clearThreadPreviewState(threadRef);

    if (shouldNavigateToFallback) {
      const fallbackThread = fallbackThreadId
        ? readThreadShell(scopeThreadRef(threadRef.environmentId, fallbackThreadId))
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
    return deleteResult;
  };

  /**
   * Deletes threads one after another. The worktrees the batch leaves unused
   * are asked about once, up front, however many threads are selected; a
   * worktree is removed only after every thread holding it was deleted.
   * `lastResult` is the outcome of the last delete attempted.
   */
  const deleteThreads = async (targets: ReadonlyArray<ScopedThreadRef>) => {
    const orphanedWorktrees = await findRemovableOrphanedWorktrees(targets);
    let shouldRemoveWorktrees = false;
    const localApi = readLocalApi();
    if (orphanedWorktrees.length > 0 && localApi) {
      const confirmation = await settlePromise(() =>
        localApi.dialogs.confirm(
          formatOrphanedWorktreeRemovalMessage({
            threadCount: targets.length,
            worktreePaths: orphanedWorktrees.map((worktree) => worktree.worktreePath),
          }),
          { variant: "destructive" },
        ),
      );
      if (confirmation._tag === "Failure") {
        return {
          deletedThreadKeys: new Set<string>(),
          firstFailure: confirmation,
          lastResult: confirmation,
        };
      }
      shouldRemoveWorktrees = confirmation.value;
    }

    const attempted: AtomCommandResult<unknown, unknown>[] = [];
    const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
      entries: targets.map((ref) => ({ threadKey: scopedThreadKey(ref), ref })),
      delete: async ({ ref }) => {
        const result = await deleteThreadRecord(
          ref,
          new Set(
            targets.flatMap((target) =>
              target.environmentId === ref.environmentId ? [target.threadId] : [],
            ),
          ),
        );
        attempted.push(result);
        return result;
      },
    });

    if (shouldRemoveWorktrees) {
      await removeOrphanedWorktrees(
        orphanedWorktrees.filter((worktree) =>
          worktree.ownerKeys.every((key) => deletedThreadKeys.has(key)),
        ),
      );
    }
    return { deletedThreadKeys, firstFailure, lastResult: attempted.at(-1) ?? null };
  };

  const deleteThread = async (
    target: ScopedThreadRef,
  ): Promise<AtomCommandResult<unknown, unknown>> =>
    (await deleteThreads([target])).lastResult ?? AsyncResult.success(undefined);

  const unsettleThread = async (target: ScopedThreadRef) => {
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
    // reason "user" pins active until real activity, suppressing auto-settle.
    return unsettleThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  const setThreadAutoSettle = async (target: ScopedThreadRef, enabled: boolean) => {
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
  };

  const pinThread = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
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
    // Older servers cannot decode orderKey, so send only the pin to them.
    const orderKey = readEnvironmentSupportsPinReorder(target.environmentId)
      ? (opts.orderKey ?? topOfPinnedRunOrderKey())
      : undefined;
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return pinThreadMutation({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        ...(orderKey !== undefined ? { orderKey } : {}),
      },
    });
  };

  const unpinThread = async (target: ScopedThreadRef) => {
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
    const thread = readThreadShell(target);
    const undoPlan = ThreadUndo.planThreadUndo("unpin", thread);
    const action = ThreadUndo.begin("pin", scopedThreadKey(target));
    const result = await unpinThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Success" && action.isCurrent()) {
      showThreadUndoNotice({
        action: "Unpinned",
        claim: action,
        undo: () => runUndoPlan(target, undoPlan),
        failureTitle: "Failed to undo unpin",
      });
    } else {
      action.finish();
    }
    return result;
  };

  const settleThread = async (target: ScopedThreadRef) => {
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
    const wokeAt = resolved
      ? threadWokeAt(resolved.thread, { now: new Date().toISOString() })
      : null;
    const undoPlan = ThreadUndo.planThreadUndo("settle", resolved?.thread);
    // An older unpin/snooze Undo would re-pin or re-snooze, and the server
    // treats either as a promotion that un-settles; settling supersedes them.
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
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(target), wokeAt);
    }
    showThreadUndoNotice({
      action: "Settled",
      claim: action,
      undo: () => runUndoPlan(target, undoPlan),
      failureTitle: "Failed to undo settle",
    });
    return result;
  };

  const confirmAndUnpinThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
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
  };

  const reorderPinnedThread = async (target: ScopedThreadRef, orderKey: string) => {
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
  };

  const reorderActiveThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentSupportsActiveReorder(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadActiveReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return reorderActiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const unsnoozeThread = async (target: ScopedThreadRef) => {
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
  };

  const snoozeThread = async (target: ScopedThreadRef, snoozedUntil: string) => {
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
    const action = ThreadUndo.begin("snooze", scopedThreadKey(target));
    const result = await snoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    showThreadUndoNotice({
      action: "Snoozed",
      claim: action,
      undo: () => runUndoPlan(target, ThreadUndo.planThreadUndo("snooze")),
      failureTitle: "Failed to wake thread",
    });
    return result;
  };

  const runUndoPlan = (target: ScopedThreadRef, plan: ThreadUndo.ThreadUndoPlan) =>
    ThreadUndo.executeThreadUndo(
      plan,
      async (step) => {
        switch (step.action) {
          case "unsettle":
            return unsettleThread(target);
          case "unsnooze":
            return unsnoozeThread(target);
          case "pin":
            return pinThread(
              target,
              step.orderKey === undefined ? {} : { orderKey: step.orderKey },
            );
          case "snooze":
            return snoozeThreadMutation({
              environmentId: target.environmentId,
              input: { threadId: target.threadId, snoozedUntil: step.snoozedUntil },
            });
        }
      },
      (result) => result._tag === "Success",
    );

  const confirmAndDeleteThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
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
          { variant: "destructive" },
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
  };

  return {
    archiveThread,
    unarchiveThread,
    deleteThread,
    deleteThreads,
    confirmAndDeleteThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    setThreadAutoSettle,
  };
}
