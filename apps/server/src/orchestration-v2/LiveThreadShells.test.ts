import { assert, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as LiveThreadShells from "./LiveThreadShells.ts";
import { OrchestratorProjectionError } from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:live-shells");

/** A store whose shell reads wait on `release` and report how many ran. */
const harness = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const started: Array<ThreadId> = [];
  let failNext = false;
  const layer = LiveThreadShells.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.suspend(() => {
            started.push(id);
            if (failNext) {
              failNext = false;
              return Effect.fail(new OrchestratorProjectionError({ threadId: id }));
            }
            return Deferred.await(release).pipe(
              Effect.as({ id, title: `read ${started.length}` } as OrchestrationV2ThreadShell),
            );
          }),
      }),
    ),
  );
  return {
    layer,
    release: Deferred.succeed(release, undefined),
    started,
    failNextRead: () => {
      failNext = true;
    },
  };
});

it.effect("subscribers share one shell read per thread change", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const shells = yield* LiveThreadShells.LiveThreadShells;
      const first = yield* Effect.forkChild(shells.read({ threadId, sequence: 5 }));
      const second = yield* Effect.forkChild(shells.read({ threadId, sequence: 5 }));
      yield* h.release;
      const [a, b] = yield* Fiber.joinAll([first, second]);
      assert.strictEqual(a, b);
      assert.lengthOf(h.started, 1);
      // A subscriber a window behind gets the newer read.
      assert.strictEqual(yield* shells.read({ threadId, sequence: 4 }), a);
      assert.lengthOf(h.started, 1);
      // A later change is read again.
      const next = yield* shells.read({ threadId, sequence: 6 });
      assert.lengthOf(h.started, 2);
      assert.equal(next?.title, "read 2");
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("a subscriber that leaves mid-read does not fail the others", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const shells = yield* LiveThreadShells.LiveThreadShells;
      const leaving = yield* Effect.forkChild(shells.read({ threadId, sequence: 1 }));
      const staying = yield* Effect.forkChild(shells.read({ threadId, sequence: 1 }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(leaving);
      yield* h.release;
      const shell = yield* Fiber.join(staying);
      assert.equal(shell?.id, threadId);
      assert.lengthOf(h.started, 1);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("a failed read is tried again by the next caller", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.release;
    h.failNextRead();
    yield* Effect.gen(function* () {
      const shells = yield* LiveThreadShells.LiveThreadShells;
      const failed = yield* Effect.exit(shells.read({ threadId, sequence: 1 }));
      assert.isTrue(Exit.isFailure(failed));
      const shell = yield* shells.read({ threadId, sequence: 1 });
      assert.equal(shell?.id, threadId);
      assert.lengthOf(h.started, 2);
    }).pipe(Effect.provide(h.layer));
  }),
);
