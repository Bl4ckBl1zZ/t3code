import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  WorktreeRegistry,
  layer as worktreeRegistryLayer,
  type WorktreeRegistration,
} from "./WorktreeRegistry.ts";

const layer = worktreeRegistryLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const registration: WorktreeRegistration = {
  repositoryRoot: "/repo",
  worktreePath: "/server/worktrees/feature",
  projectId: "project:one",
  threadId: "thread:one",
  branch: "feature",
  ownership: "t3-created",
  createdAtMs: 1_000,
  discoveredAtMs: 1_000,
  lastActivityAtMs: 2_000,
  observedAtMs: 2_000,
};

it.effect("registers and retrieves a managed worktree", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const registry = yield* WorktreeRegistry;

    const entry = yield* registry.register(registration);
    assert.deepStrictEqual(entry, {
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      projectId: registration.projectId,
      threadId: registration.threadId,
      branch: registration.branch,
      ownership: registration.ownership,
      createdAtMs: registration.createdAtMs,
      discoveredAtMs: registration.discoveredAtMs,
      lastActivityAtMs: registration.lastActivityAtMs,
      state: "present",
      lastReason: null,
      updatedAtMs: 2_000,
      generation: 1,
      removalClaimedAtMs: null,
    });
    assert.deepStrictEqual(
      yield* registry.get({
        repositoryRoot: registration.repositoryRoot,
        worktreePath: registration.worktreePath,
      }),
      Option.some(entry),
    );
    assert.deepStrictEqual(
      yield* registry.getRemovedForThreadPath({
        threadId: registration.threadId!,
        worktreePath: registration.worktreePath,
      }),
      Option.none(),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("upserts by canonical repository and path without losing creation time", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const registry = yield* WorktreeRegistry;

    yield* registry.register(registration);
    const updated = yield* registry.register({
      ...registration,
      createdAtMs: null,
      lastActivityAtMs: 4_000,
      observedAtMs: 5_000,
    });

    assert.equal(updated.createdAtMs, 1_000);
    assert.equal(updated.lastActivityAtMs, 4_000);
    assert.equal(updated.updatedAtMs, 5_000);
    assert.equal((yield* registry.listAll()).length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("does not upgrade an explicitly unmanaged worktree", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const registry = yield* WorktreeRegistry;

    yield* registry.register({
      ...registration,
      ownership: "unmanaged",
      createdAtMs: null,
    });
    const updated = yield* registry.register(registration);

    assert.equal(updated.ownership, "unmanaged");
    assert.equal(updated.createdAtMs, null);
  }).pipe(Effect.provide(layer)),
);

it.effect("marks a worktree removed idempotently and retains the reason", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const registry = yield* WorktreeRegistry;

    yield* registry.register(registration);
    yield* registry.markRemoved({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      removedAtMs: 7_000,
      reason: "staleAfter",
    });
    const removedByThread = yield* registry.getRemovedForThreadPath({
      threadId: registration.threadId!,
      worktreePath: registration.worktreePath,
    });
    assert.deepStrictEqual(
      removedByThread.pipe(Option.map((row) => [row.state, row.worktreePath] as const)),
      Option.some(["removed", registration.worktreePath] as const),
    );
    yield* registry.markRemoved({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      removedAtMs: 8_000,
      reason: "staleAfter",
    });

    const entry = yield* registry.get({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
    });
    assert.deepStrictEqual(entry.pipe(Option.map((row) => row.state)), Option.some("removed"));
    assert.deepStrictEqual(
      entry.pipe(Option.map((row) => [row.updatedAtMs, row.lastReason] as const)),
      Option.some([8_000, "staleAfter"] as const),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("records qualifying activity without reviving a removed worktree", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const registry = yield* WorktreeRegistry;

    yield* registry.register(registration);
    yield* registry.touch({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      lastActivityAtMs: 9_000,
      observedAtMs: 9_000,
    });
    const touched = yield* registry.get({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
    });
    assert.deepStrictEqual(
      touched.pipe(Option.map((row) => row.lastActivityAtMs)),
      Option.some(9_000),
    );

    yield* registry.markRemoved({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      removedAtMs: 10_000,
      reason: "purged",
    });
    yield* registry.touch({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      lastActivityAtMs: 11_000,
      observedAtMs: 11_000,
    });
    const removed = yield* registry.get({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
    });
    assert.deepStrictEqual(
      removed.pipe(Option.map((row) => [row.state, row.lastActivityAtMs] as const)),
      Option.some(["removed", 9_000] as const),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("claims removal with compare-and-set semantics and finalizes once", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const registry = yield* WorktreeRegistry;

    const registered = yield* registry.register(registration);
    const claim = yield* registry.claimRemoval({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      generation: registered.generation,
      claimedAtMs: 12_000,
      reason: "staleAfter",
    });
    assert.deepStrictEqual(
      claim.pipe(Option.map((row) => row.removalClaimedAtMs)),
      Option.some(12_000),
    );
    assert.deepStrictEqual(
      yield* registry.claimRemoval({
        repositoryRoot: registration.repositoryRoot,
        worktreePath: registration.worktreePath,
        generation: registered.generation,
        claimedAtMs: 13_000,
        reason: "staleAfter",
      }),
      Option.none(),
    );
    assert.deepStrictEqual(
      yield* registry
        .getRemovedForThreadPath({
          threadId: registration.threadId!,
          worktreePath: registration.worktreePath,
        })
        .pipe(Effect.map((row) => row.pipe(Option.map((entry) => entry.state)))),
      Option.some("present"),
    );

    const finalized = yield* registry.finalizeRemoval({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      removedAtMs: 14_000,
      reason: "purged",
      generation: registered.generation,
    });
    assert.deepStrictEqual(
      finalized.pipe(Option.map((row) => [row.state, row.removalClaimedAtMs] as const)),
      Option.some(["removed", null] as const),
    );
    assert.deepStrictEqual(
      yield* registry.finalizeRemoval({
        repositoryRoot: registration.repositoryRoot,
        worktreePath: registration.worktreePath,
        removedAtMs: 15_000,
        reason: "purged",
        generation: registered.generation,
      }),
      Option.none(),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves an active removal claim when a present ref is re-registered", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const registry = yield* WorktreeRegistry;

    const registered = yield* registry.register(registration);
    yield* registry.claimRemoval({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      generation: registered.generation,
      claimedAtMs: 12_000,
      reason: "staleAfter",
    });

    const refreshed = yield* registry.register({
      ...registration,
      lastActivityAtMs: 13_000,
      observedAtMs: 13_000,
    });

    assert.equal(refreshed.generation, registered.generation);
    assert.equal(refreshed.removalClaimedAtMs, 12_000);
    assert.equal(refreshed.lastReason, "staleAfter");
  }).pipe(Effect.provide(layer)),
);

it.effect("starts a new generation when a removed path is reused", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 55 });
    const registry = yield* WorktreeRegistry;

    const first = yield* registry.register(registration);
    yield* registry.markRemoved({
      repositoryRoot: registration.repositoryRoot,
      worktreePath: registration.worktreePath,
      removedAtMs: 20_000,
      reason: "purged",
      generation: first.generation,
    });
    const second = yield* registry.register({
      ...registration,
      createdAtMs: 21_000,
      discoveredAtMs: 21_000,
      lastActivityAtMs: 21_000,
      observedAtMs: 21_000,
    });

    assert.equal(second.generation, first.generation + 1);
    assert.equal(second.createdAtMs, 21_000);
    assert.equal(second.state, "present");
    assert.equal(second.removalClaimedAtMs, null);
  }).pipe(Effect.provide(layer)),
);
