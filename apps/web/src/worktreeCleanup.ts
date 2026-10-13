import type { ThreadShell } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

/**
 * Worktrees that deleting `deletingThreadIds` together leaves with no thread,
 * each mapped to the deleting threads that hold it. A single delete is a batch
 * of one; a worktree any other thread still points at is never included.
 */
export function getWorktreesOrphanedByDeletion(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  deletingThreadIds: ReadonlySet<ThreadShell["id"]>,
): ReadonlyMap<string, ReadonlyArray<ThreadShell["id"]>> {
  const ownersByPath = new Map<string, ThreadShell["id"][]>();
  for (const thread of threads) {
    const worktreePath = normalizeWorktreePath(thread.worktreePath);
    if (!worktreePath) continue;
    const owners = ownersByPath.get(worktreePath);
    if (owners) owners.push(thread.id);
    else ownersByPath.set(worktreePath, [thread.id]);
  }

  const orphaned = new Map<string, ReadonlyArray<ThreadShell["id"]>>();
  for (const [worktreePath, owners] of ownersByPath) {
    if (owners.every((id) => deletingThreadIds.has(id))) {
      orphaned.set(worktreePath, owners);
    }
  }
  return orphaned;
}

const MAX_LISTED_WORKTREES = 5;

/** The one question asked before removing the worktrees a delete leaves unused. */
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
