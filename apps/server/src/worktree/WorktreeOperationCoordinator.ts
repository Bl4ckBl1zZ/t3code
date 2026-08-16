// @effect-diagnostics nodeBuiltinImport:off

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as NodePath from "node:path";

interface LockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

export interface WorktreeOperationCoordinatorShape {
  readonly withRepositoryLock: <A, E, R>(
    repositoryRoot: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly withPathLock: <A, E, R>(
    repositoryRoot: string,
    worktreePath: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class WorktreeOperationCoordinator extends Context.Service<
  WorktreeOperationCoordinator,
  WorktreeOperationCoordinatorShape
>()("t3/worktree/WorktreeOperationCoordinator") {}

const normalizedPath = (value: string): string => NodePath.normalize(NodePath.resolve(value));

const makeKeyedLock = Effect.gen(function* () {
  const locks = yield* Ref.make(new Map<string, LockEntry>());

  const acquire = (key: string) =>
    Effect.gen(function* () {
      const candidate = yield* Semaphore.make(1);
      return yield* Ref.modify(locks, (current) => {
        const existing = current.get(key);
        const semaphore = existing?.semaphore ?? candidate;
        const next = new Map(current);
        next.set(key, { semaphore, users: (existing?.users ?? 0) + 1 });
        return [semaphore, next] as const;
      });
    });

  const release = (key: string) =>
    Ref.update(locks, (current) => {
      const existing = current.get(key);
      if (existing === undefined) return current;
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(key);
      } else {
        next.set(key, { ...existing, users: existing.users - 1 });
      }
      return next;
    });

  return <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquire(key),
      (semaphore) => semaphore.withPermit(effect),
      () => release(key),
    );
});

const make = Effect.gen(function* () {
  const withLock = yield* makeKeyedLock;

  return WorktreeOperationCoordinator.of({
    withRepositoryLock: (repositoryRoot, effect) =>
      withLock(`repository:${normalizedPath(repositoryRoot)}`, effect),
    withPathLock: (repositoryRoot, worktreePath, effect) =>
      withLock(
        `worktree:${normalizedPath(repositoryRoot)}\u0000${normalizedPath(worktreePath)}`,
        effect,
      ),
  });
});

export const layer: Layer.Layer<WorktreeOperationCoordinator> = Layer.effect(
  WorktreeOperationCoordinator,
  make,
);
