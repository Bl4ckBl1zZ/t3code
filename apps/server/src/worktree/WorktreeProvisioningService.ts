import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorktreeInventoryService from "./WorktreeInventoryService.ts";
import * as WorktreeOperationCoordinator from "./WorktreeOperationCoordinator.ts";
import * as WorktreeRegistry from "./WorktreeRegistry.ts";

export interface WorktreeProvisioningInput {
  readonly git: VcsCreateWorktreeInput;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly ownership: "t3-created" | "unmanaged";
}

export interface WorktreeProvisioningOperations {
  readonly create: () => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  readonly remove: (path: string) => Effect.Effect<void, GitCommandError>;
  readonly deleteBranch?: (branch: string) => Effect.Effect<void, GitCommandError>;
}

export type WorktreeRemovalOperations = Pick<
  WorktreeProvisioningOperations,
  "remove" | "deleteBranch"
>;

export interface WorktreeProvisioned {
  readonly worktree: VcsCreateWorktreeResult["worktree"];
  readonly registry: WorktreeRegistry.WorktreeRegistryEntry;
}

export class WorktreeProvisioningService extends Context.Service<
  WorktreeProvisioningService,
  {
    readonly create: (
      input: WorktreeProvisioningInput,
      operations: WorktreeProvisioningOperations,
    ) => Effect.Effect<
      WorktreeProvisioned,
      GitCommandError | WorktreeRegistry.WorktreeRegistryError
    >;
    /** Must only be used while the caller holds the repository coordinator lock. */
    readonly createWithinRepositoryLock: (
      input: WorktreeProvisioningInput,
      operations: WorktreeProvisioningOperations,
    ) => Effect.Effect<
      WorktreeProvisioned,
      GitCommandError | WorktreeRegistry.WorktreeRegistryError
    >;
    readonly rollback: (
      input: {
        readonly cwd: string;
        readonly worktreePath: string;
        readonly reason: string;
        readonly deleteBranch?: boolean;
        readonly branch?: string | null;
      },
      operations: WorktreeRemovalOperations,
    ) => Effect.Effect<void>;
    /** Must only be used while the caller holds the repository coordinator lock. */
    readonly rollbackWithinRepositoryLock: (
      input: {
        readonly cwd: string;
        readonly worktreePath: string;
        readonly reason: string;
        readonly deleteBranch?: boolean;
        readonly branch?: string | null;
      },
      operations: WorktreeRemovalOperations,
    ) => Effect.Effect<void>;
  }
>()("t3/worktree/WorktreeProvisioningService") {}

const make = Effect.gen(function* () {
  const inventory = yield* WorktreeInventoryService.WorktreeInventoryService;
  const coordinator = yield* WorktreeOperationCoordinator.WorktreeOperationCoordinator;

  const createWithinRepositoryLock = Effect.fn(
    "WorktreeProvisioningService.createWithinRepositoryLock",
  )(function* (input: WorktreeProvisioningInput, operations: WorktreeProvisioningOperations) {
    let createdPath: string | null = null;
    const provision = Effect.gen(function* () {
      const created = yield* operations.create();
      createdPath = created.worktree.path;
      const observedAtMs = yield* Clock.currentTimeMillis;
      const registry = yield* inventory.register({
        repositoryRoot: input.git.cwd,
        worktreePath: createdPath,
        projectId: input.projectId,
        threadId: input.threadId,
        branch: created.worktree.refName,
        ownership: input.ownership,
        createdAtMs: input.ownership === "t3-created" ? observedAtMs : null,
        discoveredAtMs: observedAtMs,
        lastActivityAtMs: observedAtMs,
        observedAtMs,
      });
      return {
        worktree: {
          ...created.worktree,
          path: registry.worktreePath,
        },
        registry,
      } satisfies WorktreeProvisioned;
    });

    return yield* provision.pipe(
      Effect.onError(() =>
        createdPath === null ? Effect.void : operations.remove(createdPath).pipe(Effect.ignore),
      ),
    );
  });

  const rollbackWithinRepositoryLock = Effect.fn(
    "WorktreeProvisioningService.rollbackWithinRepositoryLock",
  )(function* (
    input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly reason: string;
      readonly deleteBranch?: boolean;
      readonly branch?: string | null;
    },
    operations: WorktreeRemovalOperations,
  ) {
    const removed = yield* Effect.result(operations.remove(input.worktreePath));
    if (removed._tag === "Failure") {
      yield* Effect.logWarning("worktree rollback could not remove the worktree", {
        repositoryRoot: input.cwd,
        worktreePath: input.worktreePath,
        reason: input.reason,
        cause: removed.failure,
      });
      return;
    }

    yield* inventory
      .markRemoved({
        repositoryRoot: input.cwd,
        worktreePath: input.worktreePath,
        removedAtMs: yield* Clock.currentTimeMillis,
        reason: input.reason,
      })
      .pipe(Effect.ignore);

    if (
      input.deleteBranch === true &&
      input.branch !== null &&
      input.branch !== undefined &&
      operations.deleteBranch !== undefined
    ) {
      yield* operations.deleteBranch(input.branch).pipe(Effect.ignore);
    }
  });

  return WorktreeProvisioningService.of({
    create: (input, operations) =>
      coordinator.withRepositoryLock(input.git.cwd, createWithinRepositoryLock(input, operations)),
    createWithinRepositoryLock,
    rollback: (input, operations) =>
      coordinator.withRepositoryLock(input.cwd, rollbackWithinRepositoryLock(input, operations)),
    rollbackWithinRepositoryLock,
  });
});

export const layer: Layer.Layer<
  WorktreeProvisioningService,
  never,
  | WorktreeInventoryService.WorktreeInventoryService
  | WorktreeOperationCoordinator.WorktreeOperationCoordinator
> = Layer.effect(WorktreeProvisioningService, make);
