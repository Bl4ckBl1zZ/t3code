import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WorkspacePathMaxLength = 1024;
export const WorkspaceEditorTextFileLimitBytes = 2 * 1024 * 1024;

export const WorkspaceRootInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
});
export type WorkspaceRootInput = typeof WorkspaceRootInput.Type;

export const WorkspaceRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WorkspacePathMaxLength),
);
export type WorkspaceRelativePath = typeof WorkspaceRelativePath.Type;

export const WorkspaceFileKind = Schema.Literals(["file", "directory", "symlink", "other"]);
export type WorkspaceFileKind = typeof WorkspaceFileKind.Type;

export const WorkspaceEntry = Schema.Struct({
  relativePath: WorkspaceRelativePath,
  name: TrimmedNonEmptyString,
  kind: WorkspaceFileKind,
  parentPath: Schema.optional(WorkspaceRelativePath),
  sizeBytes: Schema.optional(Schema.Number),
  mtimeMs: Schema.optional(Schema.Number),
  readonly: Schema.Boolean,
  hidden: Schema.Boolean,
  ignored: Schema.Boolean,
  symlinkTarget: Schema.optional(Schema.String),
});
export type WorkspaceEntry = typeof WorkspaceEntry.Type;

export const WorkspaceListDirectoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
  relativePath: Schema.optional(Schema.String.check(Schema.isMaxLength(WorkspacePathMaxLength))),
  includeHidden: Schema.optional(Schema.Boolean),
  includeIgnored: Schema.optional(Schema.Boolean),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(5000)),
});
export type WorkspaceListDirectoryInput = typeof WorkspaceListDirectoryInput.Type;

export const WorkspaceListDirectoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.String,
  entries: Schema.Array(WorkspaceEntry),
  truncated: Schema.Boolean,
  scannedAt: Schema.String,
});
export type WorkspaceListDirectoryResult = typeof WorkspaceListDirectoryResult.Type;

export const WorkspaceReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
  relativePath: WorkspaceRelativePath,
  maxBytes: Schema.optional(PositiveInt),
});
export type WorkspaceReadFileInput = typeof WorkspaceReadFileInput.Type;

export const WorkspaceFileVersion = Schema.Struct({
  fingerprint: TrimmedNonEmptyString,
  mtimeMs: Schema.Number,
  sizeBytes: Schema.Number,
});
export type WorkspaceFileVersion = typeof WorkspaceFileVersion.Type;

export const WorkspaceReadFileResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  exists: Schema.Boolean,
  contents: Schema.NullOr(Schema.String),
  version: Schema.NullOr(WorkspaceFileVersion),
  encoding: Schema.Literals(["utf8"]),
  eol: Schema.Literals(["lf", "crlf", "mixed", "none"]),
  readonly: Schema.Boolean,
  binary: Schema.Boolean,
  tooLarge: Schema.Boolean,
});
export type WorkspaceReadFileResult = typeof WorkspaceReadFileResult.Type;

export const WorkspaceWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
  relativePath: WorkspaceRelativePath,
  contents: Schema.String,
  expectedVersion: Schema.NullOr(WorkspaceFileVersion),
  create: Schema.optional(Schema.Boolean),
  overwriteReadonly: Schema.optional(Schema.Boolean),
});
export type WorkspaceWriteFileInput = typeof WorkspaceWriteFileInput.Type;

export const WorkspaceWriteFileResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  version: WorkspaceFileVersion,
  writtenAt: Schema.String,
});
export type WorkspaceWriteFileResult = typeof WorkspaceWriteFileResult.Type;

export const WorkspaceCreateFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
  relativePath: WorkspaceRelativePath,
  contents: Schema.optional(Schema.String),
});
export type WorkspaceCreateFileInput = typeof WorkspaceCreateFileInput.Type;

export const WorkspaceCreateDirectoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
  relativePath: WorkspaceRelativePath,
});
export type WorkspaceCreateDirectoryInput = typeof WorkspaceCreateDirectoryInput.Type;

export const WorkspaceRenameInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
  fromRelativePath: WorkspaceRelativePath,
  toRelativePath: WorkspaceRelativePath,
});
export type WorkspaceRenameInput = typeof WorkspaceRenameInput.Type;

export const WorkspaceDeleteInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
  relativePath: WorkspaceRelativePath,
});
export type WorkspaceDeleteInput = typeof WorkspaceDeleteInput.Type;

export const WorkspaceMutationResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  entry: Schema.optional(WorkspaceEntry),
  changedAt: Schema.String,
});
export type WorkspaceMutationResult = typeof WorkspaceMutationResult.Type;

export const WorkspaceRenameResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  fromRelativePath: WorkspaceRelativePath,
  toRelativePath: WorkspaceRelativePath,
  entry: Schema.optional(WorkspaceEntry),
  changedAt: Schema.String,
});
export type WorkspaceRenameResult = typeof WorkspaceRenameResult.Type;

export const WorkspaceWatchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(WorkspacePathMaxLength)),
});
export type WorkspaceWatchInput = typeof WorkspaceWatchInput.Type;

export const WorkspaceFileChangeKind = Schema.Literals([
  "created",
  "updated",
  "deleted",
  "renamed",
  "unknown",
]);
export type WorkspaceFileChangeKind = typeof WorkspaceFileChangeKind.Type;

export const WorkspaceFileChangeEvent = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: WorkspaceRelativePath,
  kind: WorkspaceFileChangeKind,
  directoryPath: Schema.String,
  observedAt: Schema.String,
});
export type WorkspaceFileChangeEvent = typeof WorkspaceFileChangeEvent.Type;

export const WorkspaceFileErrorCode = Schema.Literals([
  "not_found",
  "not_directory",
  "not_file",
  "permission_denied",
  "outside_root",
  "unsafe_symlink",
  "conflict",
  "already_exists",
  "readonly",
  "too_large",
  "binary",
  "watch_unavailable",
  "unknown",
]);
export type WorkspaceFileErrorCode = typeof WorkspaceFileErrorCode.Type;

export class WorkspaceFileError extends Schema.TaggedErrorClass<WorkspaceFileError>()(
  "WorkspaceFileError",
  {
    code: WorkspaceFileErrorCode,
    message: TrimmedNonEmptyString,
    cwd: Schema.optional(Schema.String),
    relativePath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
