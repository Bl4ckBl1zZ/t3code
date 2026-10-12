// @effect-diagnostics nodeBuiltinImport:off
/**
 * Contained reads of files the Claude harness persisted for a workflow run:
 * the script behind the Agents surface's "{} script" affordance and each
 * member's transcript.
 *
 * The path reaching this module comes from a task's runHandles, which are
 * populated from provider output. That makes it untrusted input, and the
 * containment rules below are the whole point of the module:
 *
 * - the resolved realpath must live under the Claude projects directory
 *   (`<configDir or ~/.claude>/projects`, where the harness persists workflow
 *   files) — resolving the leaf FILE rather than just its parent directory is
 *   what defeats a symlink named like a workflow file inside an
 *   otherwise-contained directory;
 * - only the caller's expected extension is served;
 * - reads are size-capped rather than failed, with a truncation marker, so a
 *   pathological file degrades to a prefix (or, for `tail`, a suffix) instead
 *   of an error.
 *
 * @module workflowFileRead
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { HostProcessHomeDirectory } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const WorkflowFileFailureReason = Schema.Literals([
  "invalid-path",
  "root-unavailable",
  "not-found",
  "outside-root",
  "wrong-extension",
  "not-regular-file",
  "changed-during-read",
  "read-failed",
]);
export type WorkflowFileFailureReason = typeof WorkflowFileFailureReason.Type;

export class WorkflowFileError extends Schema.TaggedErrorClass<WorkflowFileError>()(
  "WorkflowFileError",
  {
    reason: WorkflowFileFailureReason,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

function workflowFilesRoot(home: string, configDir?: string): string {
  return NodePath.join(configDir?.trim() || NodePath.join(home, ".claude"), "projects");
}

export const readContainedWorkflowFile = Effect.fn("orchestrationV2.readContainedWorkflowFile")(
  function* (input: {
    readonly path: string;
    readonly extension: string;
    readonly byteCap: number;
    /** Read the end of an oversized file instead of its start. */
    readonly tail?: boolean;
    readonly configDir?: string;
  }) {
    // Cheap syntactic rejects first: no filesystem call for input that could
    // never be valid.
    if (!NodePath.isAbsolute(input.path) || NodePath.extname(input.path) !== input.extension) {
      return yield* new WorkflowFileError({ reason: "invalid-path", path: input.path });
    }

    const home = yield* HostProcessHomeDirectory;
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(workflowFilesRoot(home, input.configDir)),
      catch: (cause) =>
        new WorkflowFileError({ reason: "root-unavailable", path: input.path, cause }),
    });

    const resolved = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.path),
      catch: (cause) => new WorkflowFileError({ reason: "not-found", path: input.path, cause }),
    });

    // Compare against `${root}${sep}` and not a bare prefix: "/a/projects-evil"
    // starts with "/a/projects" but is not inside it.
    if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
      return yield* new WorkflowFileError({ reason: "outside-root", path: resolved });
    }
    if (NodePath.extname(resolved) !== input.extension) {
      return yield* new WorkflowFileError({ reason: "wrong-extension", path: resolved });
    }

    // TOCTOU-safe read: open FIRST, then verify what was actually opened via
    // the descriptor. Non-blocking, so a FIFO named like a workflow file fails
    // as not-regular-file instead of waiting for a writer. The two containment
    // failures get their own tagged reasons; read-failed stays reserved for
    // genuine platform errors with the real cause attached.
    const read = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(
          resolved,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) {
            return { failure: "not-regular-file" as const };
          }
          // The opened inode must be the one realpath resolved to. A process
          // swapping the path between realpath and open changes the inode,
          // which this comparison catches and a path re-check would not.
          const pathStat = await NodeFSP.lstat(resolved);
          if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
            return { failure: "changed-during-read" as const };
          }
          // A tail read takes one extra byte so the caller can tell whether the
          // first line it got is whole.
          const buffer = Buffer.alloc(Math.min(stat.size, input.byteCap + (input.tail ? 1 : 0)));
          const truncated = stat.size > buffer.length;
          const offset = input.tail ? stat.size - buffer.length : 0;
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          return { contents: buffer.subarray(0, bytesRead).toString("utf8"), truncated };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) => new WorkflowFileError({ reason: "read-failed", path: resolved, cause }),
    });
    if ("failure" in read) {
      return yield* new WorkflowFileError({ reason: read.failure, path: resolved });
    }

    return { path: resolved, contents: read.contents, truncated: read.truncated };
  },
);
