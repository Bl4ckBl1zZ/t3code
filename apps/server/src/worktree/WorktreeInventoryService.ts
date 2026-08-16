import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";

import * as WorktreeRegistry from "./WorktreeRegistry.ts";
import type { WorktreeThreadPathLookup } from "./WorktreeRegistrySchemas.ts";

export interface WorktreeInventoryServiceShape {
  readonly canonicalize: (value: string) => Effect.Effect<string>;
  readonly register: (
    input: WorktreeRegistry.WorktreeRegistration,
  ) => Effect.Effect<
    WorktreeRegistry.WorktreeRegistryEntry,
    WorktreeRegistry.WorktreeRegistryError
  >;
  readonly get: (
    input: WorktreeRegistry.WorktreeRegistryLookup,
  ) => Effect.Effect<
    Option.Option<WorktreeRegistry.WorktreeRegistryEntry>,
    WorktreeRegistry.WorktreeRegistryError
  >;
  readonly getRemovedForThreadPath: (
    input: WorktreeThreadPathLookup,
  ) => Effect.Effect<
    Option.Option<WorktreeRegistry.WorktreeRegistryEntry>,
    WorktreeRegistry.WorktreeRegistryError
  >;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<WorktreeRegistry.WorktreeRegistryEntry>,
    WorktreeRegistry.WorktreeRegistryError
  >;
  readonly markRemoved: (
    input: WorktreeRegistry.WorktreeRemoval,
  ) => Effect.Effect<void, WorktreeRegistry.WorktreeRegistryError>;
  readonly claimRemoval: (
    input: WorktreeRegistry.WorktreeRemovalClaim,
  ) => Effect.Effect<
    Option.Option<WorktreeRegistry.WorktreeRegistryEntry>,
    WorktreeRegistry.WorktreeRegistryError
  >;
  readonly releaseRemovalClaim: (
    input: WorktreeRegistry.WorktreeRemovalClaimRelease,
  ) => Effect.Effect<void, WorktreeRegistry.WorktreeRegistryError>;
  readonly finalizeRemoval: (
    input: WorktreeRegistry.WorktreeRemoval,
  ) => Effect.Effect<
    Option.Option<WorktreeRegistry.WorktreeRegistryEntry>,
    WorktreeRegistry.WorktreeRegistryError
  >;
  readonly touch: (
    input: WorktreeRegistry.WorktreeActivity,
  ) => Effect.Effect<void, WorktreeRegistry.WorktreeRegistryError>;
  readonly touchThread: (
    input: WorktreeRegistry.WorktreeThreadActivity,
  ) => Effect.Effect<void, WorktreeRegistry.WorktreeRegistryError>;
}

export class WorktreeInventoryService extends Context.Service<
  WorktreeInventoryService,
  WorktreeInventoryServiceShape
>()("t3/worktree/WorktreeInventoryService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* WorktreeRegistry.WorktreeRegistry;

  const lexical = (value: string) => path.normalize(path.resolve(value));
  const canonicalize = (value: string) =>
    fileSystem.realPath(lexical(value)).pipe(
      Effect.map((resolved) => path.normalize(resolved)),
      Effect.catchCause(() => Effect.succeed(lexical(value))),
    );

  const canonicalizeKey = <A>(
    input: { readonly repositoryRoot: string; readonly worktreePath: string },
    run: (key: {
      readonly repositoryRoot: string;
      readonly worktreePath: string;
    }) => Effect.Effect<A, WorktreeRegistry.WorktreeRegistryError>,
  ) =>
    Effect.all({
      repositoryRoot: canonicalize(input.repositoryRoot),
      worktreePath: canonicalize(input.worktreePath),
    }).pipe(Effect.flatMap(run));

  return WorktreeInventoryService.of({
    canonicalize,
    register: (input) => canonicalizeKey(input, (key) => registry.register({ ...input, ...key })),
    get: (input) => canonicalizeKey(input, (key) => registry.get(key)),
    getRemovedForThreadPath: (input) =>
      canonicalize(input.worktreePath).pipe(
        Effect.flatMap((worktreePath) =>
          registry.getRemovedForThreadPath({ ...input, worktreePath }),
        ),
      ),
    listAll: registry.listAll,
    markRemoved: (input) =>
      canonicalizeKey(input, (key) => registry.markRemoved({ ...input, ...key })),
    claimRemoval: (input) =>
      canonicalizeKey(input, (key) => registry.claimRemoval({ ...input, ...key })),
    releaseRemovalClaim: (input) =>
      canonicalizeKey(input, (key) => registry.releaseRemovalClaim({ ...input, ...key })),
    finalizeRemoval: (input) =>
      canonicalizeKey(input, (key) => registry.finalizeRemoval({ ...input, ...key })),
    touch: (input) => canonicalizeKey(input, (key) => registry.touch({ ...input, ...key })),
    touchThread: registry.touchThread,
  });
});

export const layer: Layer.Layer<
  WorktreeInventoryService,
  never,
  WorktreeRegistry.WorktreeRegistry | FileSystem.FileSystem | Path.Path
> = Layer.effect(WorktreeInventoryService, make);
