import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type { OrchestratorV2Error } from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

/** Threads whose latest shell read is kept for subscribers that are a window behind. */
const RETAINED_THREADS = 256;

/**
 * Thread shells for the live shell streams, read once per thread change and shared by every
 * subscription on this environment. A shell read is a transaction with a dozen per-thread
 * lookups on the single SQLite connection; each connected client used to run its own for every
 * changed thread in every 50 ms window.
 */
export class LiveThreadShells extends Context.Service<
  LiveThreadShells,
  {
    /**
     * The thread's shell, read after the stored event at `sequence` committed. A read already
     * started for that event or a later one is shared instead of repeated. Null when the thread
     * is deleted or unknown.
     */
    readonly read: (input: {
      readonly threadId: ThreadId;
      readonly sequence: number;
    }) => Effect.Effect<OrchestrationV2ThreadShell | null, OrchestratorV2Error>;
  }
>()("t3/orchestration-v2/LiveThreadShells") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  // Reads run in the service's scope, so a subscriber that disconnects mid-read does not
  // fail the others waiting on it.
  const scope = yield* Effect.scope;
  // Insertion order is recency: a new read moves its thread to the end, and the oldest
  // thread is dropped past the limit.
  const latest = new Map<
    ThreadId,
    {
      readonly sequence: number;
      readonly shell: Deferred.Deferred<OrchestrationV2ThreadShell | null, OrchestratorV2Error>;
    }
  >();

  const read: LiveThreadShells["Service"]["read"] = ({ threadId, sequence }) =>
    Effect.suspend(() => {
      const current = latest.get(threadId);
      if (current !== undefined && current.sequence >= sequence) {
        return Deferred.await(current.shell);
      }
      const shell = Deferred.makeUnsafe<OrchestrationV2ThreadShell | null, OrchestratorV2Error>();
      const entry = { sequence, shell };
      latest.delete(threadId);
      latest.set(threadId, entry);
      if (latest.size > RETAINED_THREADS) latest.delete(latest.keys().next().value!);
      return threads.getThreadShell(threadId).pipe(
        // A failed read is not an answer; the next caller tries again.
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit) && latest.get(threadId) === entry) latest.delete(threadId);
          }),
        ),
        Deferred.into(shell),
        Effect.forkIn(scope),
        Effect.andThen(Deferred.await(shell)),
      );
    });

  return LiveThreadShells.of({ read });
});

export const layer = Layer.effect(LiveThreadShells, make);
