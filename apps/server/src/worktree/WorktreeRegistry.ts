// @effect-diagnostics nodeBuiltinImport:off

import {
  WorktreeRetentionRegistryOwnership,
  WorktreeRetentionRegistryState,
  WorktreeThreadPathLookup,
} from "./WorktreeRegistrySchemas.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as NodePath from "node:path";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export const WorktreeRegistryEntry = Schema.Struct({
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  ownership: WorktreeRetentionRegistryOwnership,
  createdAtMs: Schema.NullOr(Schema.Int),
  discoveredAtMs: Schema.Int,
  lastActivityAtMs: Schema.NullOr(Schema.Int),
  state: WorktreeRetentionRegistryState,
  lastReason: Schema.NullOr(Schema.String),
  updatedAtMs: Schema.Int,
  generation: Schema.Int,
  removalClaimedAtMs: Schema.NullOr(Schema.Int),
});
export type WorktreeRegistryEntry = typeof WorktreeRegistryEntry.Type;

export const WorktreeRegistration = Schema.Struct({
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  ownership: WorktreeRetentionRegistryOwnership,
  createdAtMs: Schema.NullOr(Schema.Int),
  discoveredAtMs: Schema.Int,
  lastActivityAtMs: Schema.NullOr(Schema.Int),
  observedAtMs: Schema.Int,
});
export type WorktreeRegistration = typeof WorktreeRegistration.Type;

export const WorktreeRegistryLookup = Schema.Struct({
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
});
export type WorktreeRegistryLookup = typeof WorktreeRegistryLookup.Type;

export const WorktreeRemoval = Schema.Struct({
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
  removedAtMs: Schema.Int,
  reason: Schema.String,
  generation: Schema.optional(Schema.Int),
});
export type WorktreeRemoval = typeof WorktreeRemoval.Type;

export const WorktreeRemovalClaim = Schema.Struct({
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
  generation: Schema.Int,
  claimedAtMs: Schema.Int,
  reason: Schema.String,
});
export type WorktreeRemovalClaim = typeof WorktreeRemovalClaim.Type;

export const WorktreeRemovalClaimRelease = Schema.Struct({
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
  generation: Schema.Int,
  observedAtMs: Schema.Int,
  reason: Schema.String,
});
export type WorktreeRemovalClaimRelease = typeof WorktreeRemovalClaimRelease.Type;

export const WorktreeActivity = Schema.Struct({
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
  lastActivityAtMs: Schema.Int,
  observedAtMs: Schema.Int,
});
export type WorktreeActivity = typeof WorktreeActivity.Type;

export const WorktreeThreadActivity = Schema.Struct({
  threadId: Schema.String,
  lastActivityAtMs: Schema.Int,
  observedAtMs: Schema.Int,
});
export type WorktreeThreadActivity = typeof WorktreeThreadActivity.Type;

export type WorktreeRegistryError = PersistenceSqlError;

export interface WorktreeRegistryShape {
  readonly register: (
    input: WorktreeRegistration,
  ) => Effect.Effect<WorktreeRegistryEntry, WorktreeRegistryError>;
  readonly get: (
    input: WorktreeRegistryLookup,
  ) => Effect.Effect<Option.Option<WorktreeRegistryEntry>, WorktreeRegistryError>;
  readonly getRemovedForThreadPath: (
    input: WorktreeThreadPathLookup,
  ) => Effect.Effect<Option.Option<WorktreeRegistryEntry>, WorktreeRegistryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<WorktreeRegistryEntry>,
    WorktreeRegistryError
  >;
  readonly markRemoved: (input: WorktreeRemoval) => Effect.Effect<void, WorktreeRegistryError>;
  readonly claimRemoval: (
    input: WorktreeRemovalClaim,
  ) => Effect.Effect<Option.Option<WorktreeRegistryEntry>, WorktreeRegistryError>;
  readonly releaseRemovalClaim: (
    input: WorktreeRemovalClaimRelease,
  ) => Effect.Effect<void, WorktreeRegistryError>;
  readonly finalizeRemoval: (
    input: WorktreeRemoval,
  ) => Effect.Effect<Option.Option<WorktreeRegistryEntry>, WorktreeRegistryError>;
  readonly touch: (input: WorktreeActivity) => Effect.Effect<void, WorktreeRegistryError>;
  readonly touchThread: (
    input: WorktreeThreadActivity,
  ) => Effect.Effect<void, WorktreeRegistryError>;
}

export class WorktreeRegistry extends Context.Service<WorktreeRegistry, WorktreeRegistryShape>()(
  "t3/worktree/WorktreeRegistry",
) {}

const makeWorktreeRegistry = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const normalizePath = (value: string): string => NodePath.normalize(NodePath.resolve(value));
  const normalizeKey = <
    Input extends { readonly repositoryRoot: string; readonly worktreePath: string },
  >(
    input: Input,
  ): Input => ({
    ...input,
    repositoryRoot: normalizePath(input.repositoryRoot),
    worktreePath: normalizePath(input.worktreePath),
  });

  const registerEntry = SqlSchema.findOne({
    Request: WorktreeRegistration,
    Result: WorktreeRegistryEntry,
    execute: (rawInput) => {
      const input = normalizeKey(rawInput);
      return sql`
        INSERT INTO worktree_retention_registry (
          repository_root,
          worktree_path,
          project_id,
          thread_id,
          branch,
          ownership,
          created_at_ms,
          discovered_at_ms,
          last_activity_at_ms,
          state,
          last_reason,
          updated_at_ms,
          generation,
          removal_claimed_at_ms
        )
        VALUES (
          ${input.repositoryRoot},
          ${input.worktreePath},
          ${input.projectId},
          ${input.threadId},
          ${input.branch},
          ${input.ownership},
          ${input.createdAtMs},
          ${input.discoveredAtMs},
          ${input.lastActivityAtMs},
          'present',
          NULL,
          ${input.observedAtMs},
          1,
          NULL
        )
        ON CONFLICT (repository_root, worktree_path)
        DO UPDATE SET
          project_id = COALESCE(excluded.project_id, worktree_retention_registry.project_id),
          thread_id = COALESCE(excluded.thread_id, worktree_retention_registry.thread_id),
          branch = COALESCE(excluded.branch, worktree_retention_registry.branch),
          ownership = CASE
            WHEN worktree_retention_registry.ownership IN ('t3-created', 'unmanaged')
              THEN worktree_retention_registry.ownership
            ELSE excluded.ownership
          END,
          created_at_ms = CASE
            WHEN worktree_retention_registry.state = 'removed'
              THEN excluded.created_at_ms
            WHEN worktree_retention_registry.ownership = 'unmanaged' THEN NULL
            ELSE COALESCE(
              worktree_retention_registry.created_at_ms,
              excluded.created_at_ms
            )
          END,
          discovered_at_ms = CASE
            WHEN worktree_retention_registry.state = 'removed' THEN excluded.discovered_at_ms
            ELSE MIN(
              worktree_retention_registry.discovered_at_ms,
              excluded.discovered_at_ms
            )
          END,
          last_activity_at_ms = COALESCE(
            excluded.last_activity_at_ms,
            worktree_retention_registry.last_activity_at_ms
          ),
          state = 'present',
          last_reason = CASE
            WHEN worktree_retention_registry.removal_claimed_at_ms IS NOT NULL
              THEN worktree_retention_registry.last_reason
            ELSE NULL
          END,
          updated_at_ms = CASE
            WHEN worktree_retention_registry.removal_claimed_at_ms IS NOT NULL
              THEN MAX(worktree_retention_registry.updated_at_ms, excluded.updated_at_ms)
            ELSE excluded.updated_at_ms
          END,
          generation = CASE
            WHEN worktree_retention_registry.state = 'removed' THEN
              worktree_retention_registry.generation + 1
            ELSE worktree_retention_registry.generation
          END,
          removal_claimed_at_ms = CASE
            WHEN worktree_retention_registry.state = 'removed' THEN NULL
            ELSE worktree_retention_registry.removal_claimed_at_ms
          END
        RETURNING
          repository_root AS "repositoryRoot",
          worktree_path AS "worktreePath",
          project_id AS "projectId",
          thread_id AS "threadId",
          branch,
          ownership,
          created_at_ms AS "createdAtMs",
          discovered_at_ms AS "discoveredAtMs",
          last_activity_at_ms AS "lastActivityAtMs",
          state,
          last_reason AS "lastReason",
          updated_at_ms AS "updatedAtMs",
          generation,
          removal_claimed_at_ms AS "removalClaimedAtMs"
      `;
    },
  });

  const getEntry = SqlSchema.findOneOption({
    Request: WorktreeRegistryLookup,
    Result: WorktreeRegistryEntry,
    execute: (rawInput) => {
      const input = normalizeKey(rawInput);
      return sql`
        SELECT
          repository_root AS "repositoryRoot",
          worktree_path AS "worktreePath",
          project_id AS "projectId",
          thread_id AS "threadId",
          branch,
          ownership,
          created_at_ms AS "createdAtMs",
          discovered_at_ms AS "discoveredAtMs",
          last_activity_at_ms AS "lastActivityAtMs",
          state,
          last_reason AS "lastReason",
          updated_at_ms AS "updatedAtMs",
          generation,
          removal_claimed_at_ms AS "removalClaimedAtMs"
        FROM worktree_retention_registry
        WHERE repository_root = ${input.repositoryRoot}
          AND worktree_path = ${input.worktreePath}
      `;
    },
  });

  const listEntries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorktreeRegistryEntry,
    execute: () =>
      sql`
        SELECT
          repository_root AS "repositoryRoot",
          worktree_path AS "worktreePath",
          project_id AS "projectId",
          thread_id AS "threadId",
          branch,
          ownership,
          created_at_ms AS "createdAtMs",
          discovered_at_ms AS "discoveredAtMs",
          last_activity_at_ms AS "lastActivityAtMs",
          state,
          last_reason AS "lastReason",
          updated_at_ms AS "updatedAtMs",
          generation,
          removal_claimed_at_ms AS "removalClaimedAtMs"
        FROM worktree_retention_registry
        ORDER BY repository_root ASC, worktree_path ASC
      `,
  });

  const getRemovedForThreadPathEntry = SqlSchema.findOneOption({
    Request: WorktreeThreadPathLookup,
    Result: WorktreeRegistryEntry,
    execute: (rawInput) => {
      const input = rawInput;
      return sql`
        SELECT
          repository_root AS "repositoryRoot",
          worktree_path AS "worktreePath",
          project_id AS "projectId",
          thread_id AS "threadId",
          branch,
          ownership,
          created_at_ms AS "createdAtMs",
          discovered_at_ms AS "discoveredAtMs",
          last_activity_at_ms AS "lastActivityAtMs",
          state,
          last_reason AS "lastReason",
          updated_at_ms AS "updatedAtMs",
          generation,
          removal_claimed_at_ms AS "removalClaimedAtMs"
        FROM worktree_retention_registry
        WHERE thread_id = ${input.threadId}
          AND worktree_path = ${normalizePath(input.worktreePath)}
          AND ownership = 't3-created'
          AND (state = 'removed' OR removal_claimed_at_ms IS NOT NULL)
      `;
    },
  });

  const removeEntry = SqlSchema.void({
    Request: WorktreeRemoval,
    execute: (rawInput) => {
      const input = normalizeKey(rawInput);
      const generation = input.generation ?? null;
      return sql`
        UPDATE worktree_retention_registry
        SET
          state = 'removed',
          last_reason = ${input.reason},
          updated_at_ms = ${input.removedAtMs},
          removal_claimed_at_ms = NULL
        WHERE repository_root = ${input.repositoryRoot}
          AND worktree_path = ${input.worktreePath}
          AND (${generation} IS NULL OR generation = ${generation})
      `;
    },
  });

  const claimRemovalEntry = SqlSchema.findOneOption({
    Request: WorktreeRemovalClaim,
    Result: WorktreeRegistryEntry,
    execute: (rawInput) => {
      const input = normalizeKey(rawInput);
      return sql`
        UPDATE worktree_retention_registry
        SET
          removal_claimed_at_ms = ${input.claimedAtMs},
          last_reason = ${input.reason},
          updated_at_ms = MAX(updated_at_ms, ${input.claimedAtMs})
        WHERE repository_root = ${input.repositoryRoot}
          AND worktree_path = ${input.worktreePath}
          AND generation = ${input.generation}
          AND state = 'present'
          AND removal_claimed_at_ms IS NULL
        RETURNING
          repository_root AS "repositoryRoot",
          worktree_path AS "worktreePath",
          project_id AS "projectId",
          thread_id AS "threadId",
          branch,
          ownership,
          created_at_ms AS "createdAtMs",
          discovered_at_ms AS "discoveredAtMs",
          last_activity_at_ms AS "lastActivityAtMs",
          state,
          last_reason AS "lastReason",
          updated_at_ms AS "updatedAtMs",
          generation,
          removal_claimed_at_ms AS "removalClaimedAtMs"
      `;
    },
  });

  const releaseRemovalClaimEntry = SqlSchema.void({
    Request: WorktreeRemovalClaimRelease,
    execute: (rawInput) => {
      const input = normalizeKey(rawInput);
      return sql`
        UPDATE worktree_retention_registry
        SET
          removal_claimed_at_ms = NULL,
          last_reason = ${input.reason},
          updated_at_ms = MAX(updated_at_ms, ${input.observedAtMs})
        WHERE repository_root = ${input.repositoryRoot}
          AND worktree_path = ${input.worktreePath}
          AND generation = ${input.generation}
          AND state = 'present'
          AND removal_claimed_at_ms IS NOT NULL
      `;
    },
  });

  const finalizeRemovalEntry = SqlSchema.findOneOption({
    Request: WorktreeRemoval,
    Result: WorktreeRegistryEntry,
    execute: (rawInput) => {
      const input = normalizeKey(rawInput);
      const generation = input.generation ?? null;
      return sql`
        UPDATE worktree_retention_registry
        SET
          state = 'removed',
          removal_claimed_at_ms = NULL,
          last_reason = ${input.reason},
          updated_at_ms = ${input.removedAtMs}
        WHERE repository_root = ${input.repositoryRoot}
          AND worktree_path = ${input.worktreePath}
          AND (${generation} IS NULL OR generation = ${generation})
          AND state = 'present'
          AND removal_claimed_at_ms IS NOT NULL
        RETURNING
          repository_root AS "repositoryRoot",
          worktree_path AS "worktreePath",
          project_id AS "projectId",
          thread_id AS "threadId",
          branch,
          ownership,
          created_at_ms AS "createdAtMs",
          discovered_at_ms AS "discoveredAtMs",
          last_activity_at_ms AS "lastActivityAtMs",
          state,
          last_reason AS "lastReason",
          updated_at_ms AS "updatedAtMs",
          generation,
          removal_claimed_at_ms AS "removalClaimedAtMs"
      `;
    },
  });

  const touchEntry = SqlSchema.void({
    Request: WorktreeActivity,
    execute: (rawInput) => {
      const input = normalizeKey(rawInput);
      return sql`
        UPDATE worktree_retention_registry
        SET
          last_activity_at_ms = MAX(COALESCE(last_activity_at_ms, 0), ${input.lastActivityAtMs}),
          updated_at_ms = MAX(updated_at_ms, ${input.observedAtMs})
        WHERE repository_root = ${input.repositoryRoot}
          AND worktree_path = ${input.worktreePath}
          AND state = 'present'
          AND removal_claimed_at_ms IS NULL
      `;
    },
  });

  const touchThreadEntry = SqlSchema.void({
    Request: WorktreeThreadActivity,
    execute: (input) =>
      sql`
        UPDATE worktree_retention_registry
        SET
          last_activity_at_ms = MAX(COALESCE(last_activity_at_ms, 0), ${input.lastActivityAtMs}),
          updated_at_ms = MAX(updated_at_ms, ${input.observedAtMs})
        WHERE thread_id = ${input.threadId}
          AND state = 'present'
          AND removal_claimed_at_ms IS NULL
      `,
  });

  return {
    register: (input) =>
      registerEntry(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeRegistry.register:query")),
      ),
    get: (input) =>
      getEntry(input).pipe(Effect.mapError(toPersistenceSqlError("WorktreeRegistry.get:query"))),
    getRemovedForThreadPath: (input) =>
      getRemovedForThreadPathEntry(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeRegistry.getRemovedForThreadPath:query")),
      ),
    listAll: () =>
      listEntries().pipe(Effect.mapError(toPersistenceSqlError("WorktreeRegistry.listAll:query"))),
    markRemoved: (input) =>
      removeEntry(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeRegistry.markRemoved:query")),
      ),
    claimRemoval: (input) =>
      claimRemovalEntry(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeRegistry.claimRemoval:query")),
      ),
    releaseRemovalClaim: (input) =>
      releaseRemovalClaimEntry(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeRegistry.releaseRemovalClaim:query")),
      ),
    finalizeRemoval: (input) =>
      finalizeRemovalEntry(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeRegistry.finalizeRemoval:query")),
      ),
    touch: (input) =>
      touchEntry(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeRegistry.touch:query")),
      ),
    touchThread: (input) =>
      touchThreadEntry(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeRegistry.touchThread:query")),
      ),
  } satisfies WorktreeRegistryShape;
});

export const layer: Layer.Layer<WorktreeRegistry, never, SqlClient.SqlClient> = Layer.effect(
  WorktreeRegistry,
  makeWorktreeRegistry,
);
