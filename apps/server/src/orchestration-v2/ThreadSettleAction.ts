/**
 * Runs the project's settle action (the script flagged `runOnSettle`) in a
 * settled thread's own worktree, for example to delete build output. The
 * effect worker calls it after a settle closed the thread's idle shells.
 *
 * @module ThreadSettleAction
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

export class ThreadSettleActionRunner extends Context.Reference<{
  /**
   * Starts the settle action for a thread that is still settled and has a
   * worktree of its own. A thread in the project's main checkout skips it,
   * because other threads may still be working there.
   */
  readonly run: (threadId: ThreadId) => Effect.Effect<void>;
}>("t3/orchestration-v2/ThreadSettleActionRunner", {
  defaultValue: () => ({ run: () => Effect.void }),
}) {}

/** @public Canonical Effect service construction. */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  // Settling a settled thread runs the settle command again with the same
  // settledAt, so this keeps the action to one run per settlement.
  const settleActionRunAt = new Map<ThreadId, number>();

  const run = Effect.fn("ThreadSettleAction.run")(
    function* (threadId: ThreadId) {
      const settled = yield* projections.getThreadShell(threadId);
      if (settled === null || settled.settledOverride !== "settled") return;
      const worktreePath = settled.worktreePath;
      if (worktreePath === null || !(yield* fileSystem.exists(worktreePath))) return;
      // The worktree check waits on I/O. A thread re-engaged meanwhile is
      // working again, so its worktree is no place for cleanup.
      const thread = yield* projections.getThreadShell(threadId);
      if (thread === null || thread.settledOverride !== "settled" || thread.settledAt === null) {
        return;
      }
      const settledAtMs = DateTime.toEpochMillis(thread.settledAt);
      if (settleActionRunAt.get(threadId) === settledAtMs) return;
      const started = yield* projectScripts.runForThread({
        threadId,
        projectId: thread.projectId,
        worktreePath,
        trigger: "settle",
        // A clean exit closes the script's shell so it does not hold the worktree.
        observeCompletion: true,
      });
      // Recorded after a successful start, so a failed start retries on the next settle.
      settleActionRunAt.set(threadId, settledAtMs);
      if (started.status === "started" && started.completion) {
        yield* started.completion.pipe(Effect.forkDetach);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("running the settle action failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  return { run };
});

export const layer = Layer.effect(ThreadSettleActionRunner, make);
