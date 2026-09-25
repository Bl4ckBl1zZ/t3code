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

/**
 * Worktrees that deleting `deletingThreadIds` together leaves with no owner,
 * each mapped to the deleting threads that hold it. A single delete is a batch
 * of one; a worktree any other thread still points at is never included.
 */
export function getWorktreesOrphanedByDeletion(
  owners: ReadonlyArray<WorktreeOwner>,
  deletingThreadIds: ReadonlySet<ThreadShell["id"]>,
): ReadonlyMap<string, ReadonlyArray<ThreadShell["id"]>> {
  const ownersByPath = new Map<string, ThreadShell["id"][]>();
  for (const owner of owners) {
    const worktreePath = normalizeWorktreePath(owner.worktreePath);
    if (!worktreePath) continue;
    const pathOwners = ownersByPath.get(worktreePath);
    if (pathOwners) pathOwners.push(owner.id);
    else ownersByPath.set(worktreePath, [owner.id]);
  }

  const orphaned = new Map<string, ReadonlyArray<ThreadShell["id"]>>();
  for (const [worktreePath, pathOwners] of ownersByPath) {
    if (pathOwners.every((id) => deletingThreadIds.has(id))) {
      orphaned.set(worktreePath, pathOwners);
    }
  }
  return orphaned;
}

const MAX_LISTED_WORKTREES = 5;

/** The one question asked before removing worktrees a delete leaves unused. */
export function formatOrphanedWorktreeRemovalMessage(input: {
  readonly threadCount: number;
  readonly worktreePaths: ReadonlyArray<string>;
}): string {
  const { threadCount, worktreePaths } = input;
  const single = worktreePaths.length === 1;
  const listed = worktreePaths.slice(0, MAX_LISTED_WORKTREES).map(formatWorktreePathForDisplay);
  const unlisted = worktreePaths.length - listed.length;
  return [
    `${threadCount === 1 ? "This thread is the only one" : "These threads are the only ones"} linked to ${single ? "this worktree" : `${worktreePaths.length} worktrees`}:`,
    ...listed,
    ...(unlisted > 0 ? [`and ${unlisted} more`] : []),
    "",
    single ? "Delete the worktree too?" : "Delete the worktrees too?",
  ].join("\n");
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
