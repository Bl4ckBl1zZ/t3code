import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { GitCommandError } from "@t3tools/contracts";
import type { WorktreeRetentionRule } from "./WorktreeRetention.ts";
import * as WorktreeRegistry from "./WorktreeRegistry.ts";

export interface WorktreeRetentionPurgeOperations {
  readonly claimRemoval:
    | ((
        input: WorktreeRegistry.WorktreeRemovalClaim,
      ) => Effect.Effect<
        Option.Option<WorktreeRegistry.WorktreeRegistryEntry>,
        WorktreeRegistry.WorktreeRegistryError
      >)
    | null;
  readonly releaseRemovalClaim:
    | ((
        input: WorktreeRegistry.WorktreeRemovalClaimRelease,
      ) => Effect.Effect<void, WorktreeRegistry.WorktreeRegistryError>)
    | null;
  readonly finalizeRemoval:
    | ((
        input: WorktreeRegistry.WorktreeRemoval,
      ) => Effect.Effect<
        Option.Option<WorktreeRegistry.WorktreeRegistryEntry>,
        WorktreeRegistry.WorktreeRegistryError
      >)
    | null;
  readonly markRemoved: (
    input: WorktreeRegistry.WorktreeRemoval,
  ) => Effect.Effect<void, WorktreeRegistry.WorktreeRegistryError>;
  readonly removeWorktree: () => Effect.Effect<void, GitCommandError>;
  readonly dispatchPurged: () => Effect.Effect<boolean>;
  readonly nowMs: Effect.Effect<number>;
}

export type WorktreeRetentionPurgeResult =
  | {
      readonly status: "skipped";
      readonly reasons: ReadonlyArray<string>;
    }
  | {
      readonly status: "deleted";
      readonly matchedRules: ReadonlyArray<WorktreeRetentionRule>;
      readonly registryFailure: string | null;
    };

export const purgeWorktree = (input: {
  readonly entry: WorktreeRegistry.WorktreeRegistryEntry;
  readonly matchedRules: ReadonlyArray<WorktreeRetentionRule>;
  readonly operations: WorktreeRetentionPurgeOperations;
}): Effect.Effect<WorktreeRetentionPurgeResult> =>
  Effect.gen(function* () {
    const { entry, matchedRules, operations } = input;
    if (operations.claimRemoval !== null) {
      const claimResult = yield* Effect.result(
        operations.claimRemoval({
          repositoryRoot: entry.repositoryRoot,
          worktreePath: entry.worktreePath,
          generation: entry.generation,
          claimedAtMs: yield* operations.nowMs,
          reason: matchedRules.join(","),
        }),
      );
      if (Result.isFailure(claimResult)) {
        return { status: "skipped" as const, reasons: ["claim_failed"] };
      }
      if (Option.isNone(claimResult.success)) {
        return { status: "skipped" as const, reasons: ["removal_claim_lost"] };
      }
    }

    const removedResult = yield* Effect.result(operations.removeWorktree());
    if (Result.isFailure(removedResult)) {
      if (operations.releaseRemovalClaim !== null) {
        yield* operations
          .releaseRemovalClaim({
            repositoryRoot: entry.repositoryRoot,
            worktreePath: entry.worktreePath,
            generation: entry.generation,
            observedAtMs: yield* operations.nowMs,
            reason: "remove_failed",
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* Effect.logWarning("worktree retention could not remove a worktree", {
        worktreePath: entry.worktreePath,
        cause: removedResult.failure,
      });
      return { status: "skipped" as const, reasons: ["remove_failed"] };
    }

    const threadUpdated = yield* operations.dispatchPurged();
    const removalReason = [
      ...matchedRules,
      ...(threadUpdated ? [] : ["thread_metadata_update_failed"]),
    ].join(",");
    if (operations.finalizeRemoval !== null) {
      const finalized = yield* Effect.result(
        operations.finalizeRemoval({
          repositoryRoot: entry.repositoryRoot,
          worktreePath: entry.worktreePath,
          removedAtMs: yield* operations.nowMs,
          reason: removalReason,
          generation: entry.generation,
        }),
      );
      const finalizedSuccessfully = Result.isSuccess(finalized) && Option.isSome(finalized.success);
      return {
        status: "deleted" as const,
        matchedRules,
        registryFailure: finalizedSuccessfully ? null : "registry_finalize_failed",
      };
    }

    const registryResult = yield* Effect.result(
      operations.markRemoved({
        repositoryRoot: entry.repositoryRoot,
        worktreePath: entry.worktreePath,
        removedAtMs: yield* operations.nowMs,
        reason: removalReason,
        generation: entry.generation,
      }),
    );
    return {
      status: "deleted" as const,
      matchedRules,
      registryFailure: Result.isFailure(registryResult) ? "registry_update_failed" : null,
    };
  });
