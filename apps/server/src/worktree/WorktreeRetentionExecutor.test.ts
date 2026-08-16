import { expect, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import {
  purgeWorktree,
  type WorktreeRetentionPurgeOperations,
} from "./WorktreeRetentionExecutor.ts";
import type { WorktreeRegistryEntry } from "./WorktreeRegistry.ts";

const entry: WorktreeRegistryEntry = {
  repositoryRoot: "/repo",
  worktreePath: "/server/worktrees/feature",
  projectId: null,
  threadId: null,
  branch: "feature",
  ownership: "t3-created",
  createdAtMs: 1,
  discoveredAtMs: 1,
  lastActivityAtMs: 1,
  state: "present",
  lastReason: null,
  updatedAtMs: 1,
  generation: 4,
  removalClaimedAtMs: null,
};

const removeError = new GitCommandError({
  operation: "test.remove",
  command: "git worktree remove",
  cwd: "/repo",
  detail: "remove failed",
});

const baseOperations = (): WorktreeRetentionPurgeOperations => ({
  claimRemoval: () => Effect.succeed(Option.some(entry)),
  releaseRemovalClaim: () => Effect.void,
  finalizeRemoval: () => Effect.succeed(Option.some({ ...entry, state: "removed" })),
  markRemoved: () => Effect.void,
  removeWorktree: () => Effect.void,
  dispatchPurged: () => Effect.succeed(true),
  nowMs: Effect.succeed(100),
});

it.effect("does not touch disk when the removal claim is lost", () =>
  Effect.gen(function* () {
    const removeWorktree = vi.fn(() => Effect.void);
    const result = yield* purgeWorktree({
      entry,
      matchedRules: ["staleAfter"],
      operations: {
        ...baseOperations(),
        claimRemoval: () => Effect.succeed(Option.none()),
        removeWorktree,
      },
    });

    expect(result).toEqual({ status: "skipped", reasons: ["removal_claim_lost"] });
    expect(removeWorktree).not.toHaveBeenCalled();
  }),
);

it.effect("releases a claim when physical removal fails", () =>
  Effect.gen(function* () {
    const releaseRemovalClaim = vi.fn(() => Effect.void);
    const result = yield* purgeWorktree({
      entry,
      matchedRules: ["maxAge"],
      operations: {
        ...baseOperations(),
        releaseRemovalClaim,
        removeWorktree: () => Effect.fail(removeError),
      },
    });

    expect(result).toEqual({ status: "skipped", reasons: ["remove_failed"] });
    expect(releaseRemovalClaim).toHaveBeenCalledWith(
      expect.objectContaining({ generation: entry.generation, reason: "remove_failed" }),
    );
  }),
);

it.effect("reports registry finalization failure after physical removal", () =>
  Effect.gen(function* () {
    const result = yield* purgeWorktree({
      entry,
      matchedRules: ["pullRequestMerged"],
      operations: {
        ...baseOperations(),
        finalizeRemoval: () => Effect.succeed(Option.none()),
      },
    });

    expect(result).toEqual({
      status: "deleted",
      matchedRules: ["pullRequestMerged"],
      registryFailure: "registry_finalize_failed",
    });
  }),
);
