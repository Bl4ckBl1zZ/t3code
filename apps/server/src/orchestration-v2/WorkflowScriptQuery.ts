// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance.
 *
 * The path reaching this module comes from a task's runHandles, which are
 * populated from provider output. That makes it untrusted input, and the
 * containment rules below are the whole point of the module:
 *
 * - the resolved realpath must live under ~/.claude/projects (where the
 *   harness persists workflow scripts) — resolving the leaf FILE rather than
 *   just its parent directory is what defeats a symlink named like a script
 *   inside an otherwise-contained directory;
 * - only .js leaf files are served;
 * - reads are size-capped rather than failed, with a truncation marker, so a
 *   pathological script degrades to a prefix instead of an error.
 *
 * @module WorkflowScriptQuery
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationV2GetWorkflowScriptError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const SCRIPT_BYTE_CAP = 256 * 1024;

function scriptsRoot(): string {
  return NodePath.join(NodeOS.homedir(), ".claude", "projects");
}

export const readWorkflowScript = Effect.fn("orchestrationV2.readWorkflowScript")(
  function* (input: { readonly scriptPath: string }) {
    const requested = input.scriptPath;

    // Cheap syntactic rejects first: no filesystem call for input that could
    // never be valid.
    if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== ".js") {
      return yield* Effect.fail(
        new OrchestrationV2GetWorkflowScriptError({
          reason: "invalid-path",
          scriptPath: requested,
        }),
      );
    }

    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(scriptsRoot()),
      catch: (cause) =>
        new OrchestrationV2GetWorkflowScriptError({
          reason: "root-unavailable",
          scriptPath: requested,
          cause,
        }),
    });

    const resolved = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(requested),
      catch: (cause) =>
        new OrchestrationV2GetWorkflowScriptError({
          reason: "not-found",
          scriptPath: requested,
          cause,
        }),
    });

    // Compare against `${root}${sep}` and not a bare prefix: "/a/projects-evil"
    // starts with "/a/projects" but is not inside it.
    if (resolved !== root && !resolved.startsWith(`${root}${NodePath.sep}`)) {
      return yield* Effect.fail(
        new OrchestrationV2GetWorkflowScriptError({ reason: "outside-root", scriptPath: resolved }),
      );
    }
    if (NodePath.extname(resolved) !== ".js") {
      return yield* Effect.fail(
        new OrchestrationV2GetWorkflowScriptError({ reason: "not-js", scriptPath: resolved }),
      );
    }

    // TOCTOU-safe read: open FIRST, then verify what was actually opened via the
    // descriptor. Re-checking the path after open would race against a swap;
    // fstat on the handle cannot. The two containment failures get their own
    // tagged reasons rather than being folded into read-failed, which stays
    // reserved for genuine platform errors with the real cause attached.
    const read = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(resolved, "r");
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
          const truncated = stat.size > SCRIPT_BYTE_CAP;
          const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return { contents: buffer.subarray(0, bytesRead).toString("utf8"), truncated };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new OrchestrationV2GetWorkflowScriptError({
          reason: "read-failed",
          scriptPath: resolved,
          cause,
        }),
    });
    if ("failure" in read) {
      return yield* new OrchestrationV2GetWorkflowScriptError({
        reason: read.failure,
        scriptPath: resolved,
      });
    }

    return { scriptPath: resolved, contents: read.contents, truncated: read.truncated };
  },
);
