import { splitPathAndPosition } from "./terminal-links";

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function canonicalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

interface WorkspacePathParts {
  /** Basename of the workspace root, or null when there is no workspace. */
  readonly workspaceLabel: string | null;
  /**
   * The path below the workspace root, POSIX-separated. Null when the path is
   * the workspace root itself, or sits outside it — in both cases there is no
   * "inside the workspace" form to show and `fullPath` is all we have.
   */
  readonly relativePath: string | null;
  /** Normalized, workspace-label-prefixed. What callers show when there is no relative form. */
  readonly fullPath: string;
}

function resolveWorkspacePathParts(
  normalizedPath: string,
  workspaceRoot: string | undefined,
): WorkspacePathParts {
  if (!workspaceRoot) {
    return { workspaceLabel: null, relativePath: null, fullPath: normalizedPath };
  }

  const normalizedWorkspaceRoot = canonicalizeWindowsDrivePath(
    normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
  );
  const workspaceLabel = basenameOfPath(normalizedWorkspaceRoot);
  const pathForCompare = normalizedPath.toLowerCase();
  const workspaceForCompare = normalizedWorkspaceRoot.toLowerCase();
  const workspaceWithSeparator = `${workspaceForCompare}/`;
  const workspaceLabelWithSeparator = `${workspaceLabel.toLowerCase()}/`;

  if (pathForCompare === workspaceForCompare) {
    return { workspaceLabel, relativePath: null, fullPath: workspaceLabel };
  }
  if (pathForCompare.startsWith(workspaceWithSeparator)) {
    const relativePath = normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
    return { workspaceLabel, relativePath, fullPath: `${workspaceLabel}/${relativePath}` };
  }
  if (!normalizedPath.startsWith("/")) {
    const stripped = stripRelativePrefixes(normalizedPath);
    // A path the agent already reported relative to the workspace: it carries
    // the label as its first segment, so removing it yields the relative form.
    const relativePath = pathForCompare.startsWith(workspaceLabelWithSeparator)
      ? stripped.slice(workspaceLabel.length + 1)
      : stripped;
    return { workspaceLabel, relativePath, fullPath: `${workspaceLabel}/${relativePath}` };
  }
  // Absolute and outside the workspace. Trimming anything here would be a lie.
  return { workspaceLabel, relativePath: null, fullPath: normalizedPath };
}

function withPosition(displayPath: string, pathWithPosition: string): string {
  const { line, column } = splitPathAndPosition(pathWithPosition);
  if (!line) return displayPath;
  return `${displayPath}:${line}${column ? `:${column}` : ""}`;
}

/**
 * Workspace-anchored display path, e.g. `t3code/apps/web/src/main.tsx`.
 *
 * Keeps the workspace name, which is what a link target or a review comment
 * wants: those are read outside the context of one thread's working directory.
 */
export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const { path } = splitPathAndPosition(pathWithPosition);
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));
  const parts = resolveWorkspacePathParts(normalizedPath, workspaceRoot);
  return withPosition(parts.fullPath, pathWithPosition);
}

/**
 * The same path with the workspace name dropped, e.g. `apps/web/src/main.tsx`.
 *
 * For tool-call rows, where every path in the list shares one working directory
 * and repeating a worktree name like `t3code-139f72d1/` on every line costs the
 * width that the part the user is actually reading — the file — needs.
 *
 * Falls back to the full path when there is no relative form: a file outside the
 * workspace stays absolute rather than being silently presented as a local one.
 */
export function formatPathWithinWorkspace(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const { path } = splitPathAndPosition(pathWithPosition);
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));
  const parts = resolveWorkspacePathParts(normalizedPath, workspaceRoot);
  return withPosition(parts.relativePath ?? parts.fullPath, pathWithPosition);
}
