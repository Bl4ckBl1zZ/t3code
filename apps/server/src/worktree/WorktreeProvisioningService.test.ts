import { expect, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as WorktreeInventoryService from "./WorktreeInventoryService.ts";
import { layer as coordinatorLayer } from "./WorktreeOperationCoordinator.ts";
import {
  layer as provisioningLayer,
  WorktreeProvisioningService,
  type WorktreeRemovalOperations,
} from "./WorktreeProvisioningService.ts";
import * as WorktreeRegistry from "./WorktreeRegistry.ts";

const input = {
  git: { cwd: "/repo", refName: "main", path: null },
  projectId: "project:one",
  threadId: "thread:one",
  ownership: "t3-created" as const,
};

const registered: WorktreeRegistry.WorktreeRegistryEntry = {
  repositoryRoot: "/repo",
  worktreePath: "/server/worktrees/feature",
  projectId: input.projectId,
  threadId: input.threadId,
  branch: "feature",
  ownership: "t3-created",
  createdAtMs: 1,
  discoveredAtMs: 1,
  lastActivityAtMs: 1,
  state: "present",
  lastReason: null,
  updatedAtMs: 1,
  generation: 1,
  removalClaimedAtMs: null,
};

const makeLayer = (
  register: WorktreeInventoryService.WorktreeInventoryService["Service"]["register"],
) =>
  provisioningLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorktreeInventoryService.WorktreeInventoryService)({ register }),
        coordinatorLayer,
      ),
    ),
  );

it.effect("public provisioning owns one repository lock and records the created worktree", () => {
  const create = vi.fn(() =>
    Effect.succeed({
      worktree: { path: registered.worktreePath, refName: registered.branch!, headSha: "abc" },
    }),
  );
  const remove = vi.fn(() => Effect.void);

  return Effect.gen(function* () {
    const service = yield* WorktreeProvisioningService;
    const result = yield* service.create(input, { create, remove });

    expect(result.registry).toEqual(registered);
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  }).pipe(Effect.provide(makeLayer(() => Effect.succeed(registered))));
});

it.effect("does not delete a rollback branch when worktree removal fails", () => {
  const deleteBranch = vi.fn(() => Effect.void);
  const removeError = new GitCommandError({
    operation: "test.rollback",
    command: "git worktree remove",
    cwd: input.git.cwd,
    detail: "worktree is still checked out",
  });
  const operations: WorktreeRemovalOperations = {
    remove: () => Effect.fail(removeError),
    deleteBranch,
  };

  return Effect.gen(function* () {
    const service = yield* WorktreeProvisioningService;
    yield* service.rollback(
      {
        cwd: input.git.cwd,
        worktreePath: registered.worktreePath,
        branch: registered.branch,
        deleteBranch: true,
        reason: "test_rollback",
      },
      operations,
    );

    expect(deleteBranch).not.toHaveBeenCalled();
  }).pipe(Effect.provide(makeLayer(() => Effect.succeed(registered))));
});
