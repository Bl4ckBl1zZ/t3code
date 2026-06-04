/**
 * WorkspaceFileWatcher - Effect service contract for workspace change hints.
 *
 * Watch events are invalidation hints only. Fresh reads and optimistic
 * concurrency remain the source of correctness.
 *
 * @module WorkspaceFileWatcher
 */
import * as Context from "effect/Context";
import type * as Stream from "effect/Stream";

import type {
  WorkspaceFileChangeEvent,
  WorkspaceFileError,
  WorkspaceWatchInput,
} from "@t3tools/contracts";

export interface WorkspaceFileWatcherShape {
  readonly subscribeChanges: (
    input: WorkspaceWatchInput,
  ) => Stream.Stream<WorkspaceFileChangeEvent, WorkspaceFileError>;
}

export class WorkspaceFileWatcher extends Context.Service<
  WorkspaceFileWatcher,
  WorkspaceFileWatcherShape
>()("t3/workspace/Services/WorkspaceFileWatcher") {}
