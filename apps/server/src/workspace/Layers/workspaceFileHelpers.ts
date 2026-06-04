// @effect-diagnostics nodeBuiltinImport:off
import type { Stats } from "node:fs";
import type { WorkspaceFileErrorCode } from "@t3tools/contracts";
import { WorkspaceFileError, type WorkspaceFileKind } from "@t3tools/contracts";

export const WORKSPACE_EDITOR_TEXT_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_BINARY_DETECTION_BYTES = 8 * 1024;

export const BUILTIN_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

export function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

export function normalizeDirectoryRelativePath(input: string | undefined): string {
  const normalized = toPosixPath((input ?? "").trim()).replace(/^\/+|\/+$/g, "");
  return normalized === "." ? "" : normalized;
}

export function basenameOf(relativePath: string): string {
  const normalized = toPosixPath(relativePath);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
}

export function parentPathOf(relativePath: string): string | undefined {
  const normalized = toPosixPath(relativePath);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : normalized.slice(0, separatorIndex);
}

export function directoryPathOf(relativePath: string): string {
  return parentPathOf(relativePath) ?? "";
}

export function childRelativePath(parentPath: string, name: string): string {
  return parentPath.length === 0 ? name : `${parentPath}/${name}`;
}

export function isHiddenEntryName(name: string): boolean {
  return name.startsWith(".");
}

export function isPathInBuiltinIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = toPosixPath(relativePath).split("/")[0];
  return firstSegment ? BUILTIN_IGNORED_DIRECTORY_NAMES.has(firstSegment) : false;
}

export function kindFromStats(stats: Stats): WorkspaceFileKind {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

export function isReadonlyMode(mode: number): boolean {
  return (mode & 0o222) === 0;
}

export function errorCodeFromCause(cause: unknown): WorkspaceFileErrorCode {
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { readonly code?: unknown }).code)
      : "";
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "EISDIR":
      return "not_file";
    case "ENOTDIR":
      return "not_directory";
    case "EEXIST":
      return "already_exists";
    default:
      return "unknown";
  }
}

export function messageFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : String(cause || fallback);
}

export function workspaceFileError(input: {
  readonly code: WorkspaceFileErrorCode;
  readonly message: string;
  readonly cwd?: string | undefined;
  readonly relativePath?: string | undefined;
  readonly cause?: unknown;
}): WorkspaceFileError {
  return new WorkspaceFileError({
    code: input.code,
    message: input.message,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.relativePath !== undefined ? { relativePath: input.relativePath } : {}),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

export function workspaceFileErrorFromCause(input: {
  readonly cause: unknown;
  readonly fallbackMessage: string;
  readonly cwd?: string | undefined;
  readonly relativePath?: string | undefined;
}): WorkspaceFileError {
  return workspaceFileError({
    code: errorCodeFromCause(input.cause),
    message: messageFromCause(input.cause, input.fallbackMessage),
    cwd: input.cwd,
    relativePath: input.relativePath,
    cause: input.cause,
  });
}
