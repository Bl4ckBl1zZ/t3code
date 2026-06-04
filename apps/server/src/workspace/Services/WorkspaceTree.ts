/**
 * WorkspaceTree - Effect service contract for bounded workspace directory listings.
 *
 * Lists one workspace-relative directory at a time and returns entry metadata
 * for Explorer-like clients. Search indexing remains owned by WorkspaceEntries.
 *
 * @module WorkspaceTree
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  WorkspaceFileError,
  WorkspaceListDirectoryInput,
  WorkspaceListDirectoryResult,
} from "@t3tools/contracts";

export interface WorkspaceTreeShape {
  readonly listDirectory: (
    input: WorkspaceListDirectoryInput,
  ) => Effect.Effect<WorkspaceListDirectoryResult, WorkspaceFileError>;
}

export class WorkspaceTree extends Context.Service<WorkspaceTree, WorkspaceTreeShape>()(
  "t3/workspace/Services/WorkspaceTree",
) {}
