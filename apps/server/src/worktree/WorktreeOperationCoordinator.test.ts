import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { WorktreeOperationCoordinator, layer } from "./WorktreeOperationCoordinator.ts";

const service = Effect.gen(function* () {
  return yield* WorktreeOperationCoordinator;
}).pipe(Effect.provide(layer));

describe("WorktreeOperationCoordinator", () => {
  it.effect("serializes operations for one repository", () =>
    Effect.gen(function* () {
      const coordinator = yield* service;
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Ref.make(false);

      const first = yield* coordinator
        .withRepositoryLock(
          "/repo",
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);

      const second = yield* coordinator
        .withRepositoryLock("/repo/./", Ref.set(secondEntered, true))
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(secondEntered)).toBe(false);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Ref.get(secondEntered)).toBe(true);
    }),
  );

  it.effect("allows independent repositories to proceed concurrently", () =>
    Effect.gen(function* () {
      const coordinator = yield* service;
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();

      const first = yield* coordinator
        .withRepositoryLock(
          "/repo-a",
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);

      const second = yield* coordinator
        .withRepositoryLock("/repo-b", Deferred.succeed(secondEntered, undefined))
        .pipe(Effect.forkChild);
      yield* Deferred.await(secondEntered);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }),
  );
});
