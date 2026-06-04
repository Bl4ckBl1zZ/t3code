/**
 * WorkspaceFiles - Effect service contract for safe workspace file operations.
 *
 * Owns versioned reads/writes and explicit file mutations for the in-app editor
 * and Explorer.
 *
 * @module WorkspaceFiles
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  WorkspaceCreateDirectoryInput,
  WorkspaceCreateFileInput,
  WorkspaceDeleteInput,
  WorkspaceFileError,
  WorkspaceMutationResult,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceRenameInput,
  WorkspaceRenameResult,
  WorkspaceWriteFileInput,
  WorkspaceWriteFileResult,
} from "@t3tools/contracts";

export interface WorkspaceFilesShape {
  readonly readFile: (
    input: WorkspaceReadFileInput,
  ) => Effect.Effect<WorkspaceReadFileResult, WorkspaceFileError>;
  readonly writeFile: (
    input: WorkspaceWriteFileInput,
  ) => Effect.Effect<WorkspaceWriteFileResult, WorkspaceFileError>;
  readonly createFile: (
    input: WorkspaceCreateFileInput,
  ) => Effect.Effect<WorkspaceMutationResult, WorkspaceFileError>;
  readonly createDirectory: (
    input: WorkspaceCreateDirectoryInput,
  ) => Effect.Effect<WorkspaceMutationResult, WorkspaceFileError>;
  readonly rename: (
    input: WorkspaceRenameInput,
  ) => Effect.Effect<WorkspaceRenameResult, WorkspaceFileError>;
  readonly delete: (
    input: WorkspaceDeleteInput,
  ) => Effect.Effect<WorkspaceMutationResult, WorkspaceFileError>;
}

export class WorkspaceFiles extends Context.Service<WorkspaceFiles, WorkspaceFilesShape>()(
  "t3/workspace/Services/WorkspaceFiles",
) {}
