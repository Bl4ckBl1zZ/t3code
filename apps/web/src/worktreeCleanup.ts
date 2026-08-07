import type { ThreadShell } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

type WorktreeOwner = Pick<ThreadShell, "id" | "worktreePath">;

/**
 * Every thread that can still be holding a worktree, across both stores.
 *
 * Archived threads live outside the main shell store but keep their
 * `worktreePath`, so leaving them out makes an active thread's delete look like
 * the last reference and takes the worktree an archived thread still needs. A
 * thread present in both lists is counted once, with the active copy winning as
 * the fresher projection.
 */
export function mergeWorktreeOwners(
  activeThreads: ReadonlyArray<WorktreeOwner>,
  archivedThreads: ReadonlyArray<WorktreeOwner>,
): ReadonlyArray<WorktreeOwner> {
  const activeIds = new Set(activeThreads.map((thread) => thread.id));
  return [...activeThreads, ...archivedThreads.filter((thread) => !activeIds.has(thread.id))];
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
