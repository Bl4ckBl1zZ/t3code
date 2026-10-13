/**
 * In-place upgrade for databases written by the T3 Code fork that shipped Hermes and T3 Work.
 *
 * Accepted: a migration journal whose ids from 36 are a contiguous prefix of the fork's own
 * history (`FORK_MIGRATIONS`, 36 `OrchestrationV2` through 69 `PullRequestReviewGuides`) that
 * reaches at least 44. Fork 36..44 created exactly what the first nine setup steps of this
 * build's 055 create, so from 44 on the V2 schema is complete. A journal that records the fork's
 * 36 but breaks that history in any way is refused and left unchanged. Databases without the
 * fork's 36 are not touched.
 *
 * Why it exists: the fork recorded its migrations under ids 36..69, which this build assigns to
 * different migrations. The migrator compares ids only, so a fork database would otherwise skip
 * this build's 36..61 or be refused by `assertV2MigrationsCanRun`. This upgrade runs, in one
 * transaction:
 *
 * 1. this build's 036..054, all guarded against the columns the fork already added;
 * 2. the three 055 index steps the fork never ran, 056, and 057 unless fork 064 already added it;
 * 3. one payload upcast: fork subagent workflows were written without `agents`;
 * 4. cancellation of pending `terminal.close-idle` effects, a fork-only effect type;
 * 5. removal of Hermes threads, whose provider this build does not have, and of Hermes project
 *    defaults (see `removeHermesThreads`);
 * 6. removal of fork-only tables and indexes;
 * 7. a journal rewrite to this build's 36..57, after which the migrator runs the rest.
 *
 * It only ever runs against `statev2.sqlite`: `initializeV2Database` copied `state.sqlite`
 * first, and that original stays untouched as the rollback copy. Disk: that copy doubles the
 * database, and this transaction's WAL grows by the rebuilt indexes and deleted pages (a few
 * hundred MB on a multi-GB store) until the next checkpoint truncates it.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ApplicationEventSequenceIndexes from "./Migrations/OrchestrationV2/ApplicationEventSequenceIndexes.ts";
import RecoveryIndexes from "./Migrations/OrchestrationV2/RecoveryIndexes.ts";
import ShellIndexes from "./Migrations/OrchestrationV2/ShellIndexes.ts";

const FIRST_FORK_MIGRATION_ID = 36;
const FORK_MIGRATIONS = [
  "OrchestrationV2",
  "OrchestrationV2Subagents",
  "OrchestrationV2Foundation",
  "OrchestrationV2ProviderSessionBindings",
  "OrchestrationV2ThreadLaunchWorkflows",
  "ApplicationEventSource",
  "OrchestrationV2EffectCancellation",
  "ScheduledTasks",
  "LegacyV1ImportState",
  "HermesSessionBindings",
  "HermesProactiveEvents",
  "HermesTitleBranchLineage",
  "HermesSessionImports",
  "HermesImportProjectScope",
  "HermesImportInheritedBoundary",
  "HermesCronRunWatermarks",
  "ProjectionProjectsDefaultThreadEnvMode",
  "ProjectionProjectFaviconPath",
  "WorktreeRetentionRegistry",
  "WorktreeRetentionLifecycle",
  "HermesCronRunOutcome",
  "ProjectionTurnItemsThreadRunIndex",
  "AuthSessionClientConnection",
  "ProjectionProjectIcon",
  "AgentSessionImports",
  "HermesWorkRuns",
  "HermesWorkRunResultAttempts",
  "ProjectionTurnItemsLiveCommandIndex",
  "ScheduledTaskWebhooks",
  "WebhookRelayDeliveries",
  "McpAppModelContext",
  "ProjectionMessagesThreadRunIndex",
  "OrchestrationEventCompaction",
  "PullRequestReviewGuides",
] as const;
const FORK_V2_COMPLETE_ID = 44;
/** The upgrade records this build's ids through here; the migrator runs the later ones. */
const UPGRADED_THROUGH_ID = 57;

// Children before parents, so dropping a parent never fires a foreign-key action.
const FORK_ONLY_TABLES = [
  "hermes_in_app_notifications",
  "hermes_notification_outbox",
  "hermes_proactive_work_items",
  "hermes_proactive_events",
  "hermes_proactive_sources",
  "hermes_mutation_intents",
  "hermes_session_bindings",
  "hermes_session_imports",
  "hermes_cron_run_watermarks",
  "hermes_work_runs",
  "hermes_work_sync_cursors",
  "agent_session_import_sources",
  "agent_session_imports",
  "worktree_retention_registry",
  "orchestration_event_compaction_cursors",
];
const FORK_ONLY_INDEXES = [
  "idx_orch_events_versions",
  "orchestration_v2_projection_turn_items_live_command_idx",
  "orchestration_v2_projection_messages_thread_run_idx",
];

// Every table that keys rows by a removed thread, with its thread column.
const THREAD_ROWS = [
  ["orchestration_v2_projection_threads", "thread_id"],
  ["orchestration_v2_projection_runs", "thread_id"],
  ["orchestration_v2_projection_run_attempts", "thread_id"],
  ["orchestration_v2_projection_nodes", "thread_id"],
  ["orchestration_v2_projection_provider_sessions", "thread_id"],
  ["orchestration_v2_projection_provider_session_bindings", "thread_id"],
  ["orchestration_v2_projection_provider_threads", "thread_id"],
  ["orchestration_v2_projection_provider_turns", "thread_id"],
  ["orchestration_v2_projection_runtime_requests", "thread_id"],
  ["orchestration_v2_projection_messages", "thread_id"],
  ["orchestration_v2_projection_plans", "thread_id"],
  ["orchestration_v2_projection_turn_items", "thread_id"],
  ["orchestration_v2_projection_checkpoint_scopes", "thread_id"],
  ["orchestration_v2_projection_checkpoints", "thread_id"],
  ["orchestration_v2_projection_context_handoffs", "thread_id"],
  ["orchestration_v2_projection_context_transfers", "source_thread_id"],
  ["orchestration_v2_projection_context_transfers", "target_thread_id"],
  ["orchestration_v2_projection_subagents", "thread_id"],
  ["orchestration_v2_projection_subagents", "child_thread_id"],
  ["orchestration_v2_turn_item_positions", "thread_id"],
  ["orchestration_v2_thread_launch_workflows", "thread_id"],
  ["orchestration_v2_effect_outbox", "thread_id"],
  ["orchestration_v2_legacy_imports", "thread_id"],
  ["orchestration_v2_events", "thread_id"],
  ["orchestration_v2_command_receipts", "thread_id"],
  ["mcp_app_model_context", "thread_id"],
  // A V1 row without its import record would be imported again as a new V2 thread.
  ["projection_threads", "thread_id"],
  ["projection_thread_messages", "thread_id"],
  ["projection_thread_activities", "thread_id"],
  ["projection_thread_proposed_plans", "thread_id"],
  ["projection_thread_sessions", "thread_id"],
  ["projection_thread_pull_requests", "thread_id"],
  ["projection_turns", "thread_id"],
  ["projection_pending_approvals", "thread_id"],
  ["checkpoint_diff_blobs", "thread_id"],
  ["provider_session_runtime", "thread_id"],
] as const;

/** The fork's highest recorded migration id, or undefined for a database the fork never wrote. */
const readForkMigrationId = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return undefined;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
    WHERE migration_id >= ${FIRST_FORK_MIGRATION_ID}
    ORDER BY migration_id
  `;
  // No other build records 36 under this name: main's 36 is ProjectionThreadsPinned and the
  // V2 previews recorded OrchestrationV2 at 53 or 54.
  if (rows[0]?.migration_id !== FIRST_FORK_MIGRATION_ID || rows[0].name !== FORK_MIGRATIONS[0]) {
    return undefined;
  }
  const latest = rows.at(-1)!.migration_id;
  const contiguous = rows.every(
    (row, index) =>
      row.migration_id === FIRST_FORK_MIGRATION_ID + index && row.name === FORK_MIGRATIONS[index],
  );
  if (!contiguous || latest < FORK_V2_COMPLETE_ID) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `This database was written by the Hermes fork, but its migration history (ids ${FIRST_FORK_MIGRATION_ID}..${latest}) is not a contiguous fork history through at least ${FORK_V2_COMPLETE_ID}. Start a fork build at ${FORK_V2_COMPLETE_ID} or later once, then this build.`,
    });
  }
  return latest;
});

const hasColumn = (table: string, column: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT 1 FROM pragma_table_info(${table}) WHERE name = ${column}`;
    return rows.length > 0;
  });

/**
 * Deletes every Hermes thread and every thread below one in its lineage, with their event
 * streams, receipts, effects, projections, and import state. Links from surviving threads
 * (context transfers, subagent rows) to a removed thread go too. A thread the user already
 * deleted that linked to a removed thread is removed with it, so a projection rebuild cannot
 * bring those links back, unless a thread below it is still live. Surviving threads' own events
 * keep any mention of a removed thread id, and a thread that started on Hermes and moved to
 * another provider stays. Project defaults that name Hermes are cleared. Git worktrees and files on disk are
 * not touched.
 *
 * A thread is a Hermes thread when its provider instance is `hermes` or any instance a stored
 * provider session or thread recorded with the `hermes` driver.
 */
const removeHermesThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TEMP TABLE fork_hermes_instances (instance_id TEXT PRIMARY KEY)`;
  yield* sql`
    INSERT OR IGNORE INTO fork_hermes_instances (instance_id)
    SELECT 'hermes'
    UNION
    SELECT json_extract(payload_json, '$.providerInstanceId')
    FROM orchestration_v2_projection_provider_sessions
    WHERE json_extract(payload_json, '$.driver') = 'hermes'
    UNION
    SELECT json_extract(payload_json, '$.providerInstanceId')
    FROM orchestration_v2_projection_provider_threads
    WHERE json_extract(payload_json, '$.driver') = 'hermes'
  `;
  yield* sql`CREATE TEMP TABLE fork_removed_threads (thread_id TEXT PRIMARY KEY, hermes INTEGER)`;
  yield* sql`
    WITH RECURSIVE
      removed(thread_id, hermes) AS (
        SELECT thread_id, 1 FROM orchestration_v2_projection_threads
        WHERE default_provider IN (SELECT instance_id FROM fork_hermes_instances)
        UNION
        SELECT child.thread_id, 0
        FROM orchestration_v2_projection_threads AS child
        JOIN removed
          ON json_extract(child.payload_json, '$.lineage.parentThreadId') = removed.thread_id
      )
    INSERT INTO fork_removed_threads (thread_id, hermes)
    SELECT thread_id, MAX(hermes) FROM removed GROUP BY thread_id
  `;
  // Deleted threads linked to a removed one go too, unless a thread below them is still live.
  yield* sql`
    WITH RECURSIVE
      tree(root_id, thread_id, live) AS (
        SELECT thread.thread_id, thread.thread_id, 0
        FROM orchestration_v2_projection_threads AS thread
        WHERE thread.deleted_at IS NOT NULL
          AND thread.thread_id NOT IN (SELECT thread_id FROM fork_removed_threads)
          AND (
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_subagents AS subagent
              WHERE subagent.thread_id = thread.thread_id
                AND subagent.child_thread_id IN (SELECT thread_id FROM fork_removed_threads)
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_context_transfers AS transfer
              WHERE (
                  transfer.source_thread_id = thread.thread_id
                  AND transfer.target_thread_id IN (SELECT thread_id FROM fork_removed_threads)
                )
                OR (
                  transfer.target_thread_id = thread.thread_id
                  AND transfer.source_thread_id IN (SELECT thread_id FROM fork_removed_threads)
                )
            )
          )
        UNION
        SELECT tree.root_id, child.thread_id, child.deleted_at IS NULL
        FROM orchestration_v2_projection_threads AS child
        JOIN tree ON json_extract(child.payload_json, '$.lineage.parentThreadId') = tree.thread_id
      )
    INSERT OR IGNORE INTO fork_removed_threads (thread_id, hermes)
    SELECT thread_id, 0 FROM tree
    WHERE root_id NOT IN (SELECT root_id FROM tree WHERE live)
  `;
  const [threads] = yield* sql<{ readonly hermes: number; readonly linked: number }>`
    SELECT COALESCE(SUM(hermes), 0) AS hermes, COUNT(*) - COALESCE(SUM(hermes), 0) AS linked
    FROM fork_removed_threads
  `;

  // Count per table for the upgrade log; the thread rows themselves are counted above.
  const removedRows: Record<string, number> = {};
  const countRemoved = (label: string) =>
    sql<{ readonly count: number }>`SELECT changes() AS count`.pipe(
      Effect.map(([row]) => {
        if (row !== undefined && row.count > 0) removedRows[label] = row.count;
      }),
    );

  // Keep projection metadata current when the removed events include the newest one.
  const [latest] = yield* sql<{ readonly sequence: number | null }>`
    SELECT MAX(sequence) AS sequence FROM orchestration_events
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
  `;
  yield* sql`
    DELETE FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM fork_removed_threads)
  `;
  yield* countRemoved("orchestration_events");
  yield* sql`
    UPDATE orchestration_v2_projection_metadata
    SET last_sequence = (
      SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
    )
    WHERE projection_name = 'thread-projections' AND last_sequence = ${latest?.sequence ?? 0}
  `;
  yield* sql`
    DELETE FROM orchestration_command_receipts
    WHERE aggregate_kind = 'thread' AND aggregate_id IN (SELECT thread_id FROM fork_removed_threads)
  `;
  yield* countRemoved("orchestration_command_receipts");

  const tables = new Set(
    (yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name),
  );
  for (const [table, column] of THREAD_ROWS) {
    // Tables a short fork history never created are created empty by later migrations.
    if (!tables.has(table)) continue;
    yield* sql`
      DELETE FROM ${sql(table)} WHERE ${sql(column)} IN (SELECT thread_id FROM fork_removed_threads)
    `;
    yield* countRemoved(`${table}.${column}`);
  }

  // Like 044, rewrite the events too, so a projection rebuild keeps the default cleared.
  yield* sql`
    UPDATE projection_projects SET default_model_selection_json = NULL
    WHERE json_extract(default_model_selection_json, '$.instanceId')
      IN (SELECT instance_id FROM fork_hermes_instances)
  `;
  yield* countRemoved("projection_projects (Hermes default cleared)");
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.defaultModelSelection', json('null'))
    WHERE aggregate_kind = 'project'
      AND event_type IN ('project.created', 'project.meta-updated')
      AND json_extract(payload_json, '$.defaultModelSelection.instanceId')
        IN (SELECT instance_id FROM fork_hermes_instances)
  `;

  yield* sql`DROP TABLE temp.fork_removed_threads`;
  yield* sql`DROP TABLE temp.fork_hermes_instances`;
  return {
    hermesThreads: threads?.hermes ?? 0,
    linkedThreads: threads?.linked ?? 0,
    removedRows,
  };
});

/**
 * Upgrades a fork database in place and returns the migrations it recorded, or nothing for any
 * other database. `migrations` is this build's manifest.
 */
export const upgradeForkDatabase = Effect.fn("upgradeForkDatabase")(function* <E>(
  migrations: ReadonlyArray<
    readonly [number, string, Effect.Effect<unknown, E, SqlClient.SqlClient>]
  >,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const forkMigrationId = yield* readForkMigrationId;
      if (forkMigrationId === undefined) return [];
      // Like the migrator, a failing migration is a defect naming that migration.
      const run = (id: number) => {
        const [, name, effect] = migrations.find(([entryId]) => entryId === id)!;
        return Effect.catch(effect, (cause) =>
          Effect.die(
            new Migrator.MigrationError({
              kind: "Failed",
              cause,
              message: `Migration "${id}_${name}" failed during the fork database upgrade`,
            }),
          ),
        );
      };

      for (let id = FIRST_FORK_MIGRATION_ID; id <= 54; id++) yield* run(id);
      yield* ApplicationEventSequenceIndexes;
      yield* RecoveryIndexes;
      // Fork 057 created ShellIndexes' first index under the same name.
      yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_thread_run_idx`;
      yield* ShellIndexes;
      yield* run(56);
      // Fork 064 is this build's 057 with guards.
      if (!(yield* hasColumn("scheduled_tasks", "webhook_token"))) yield* run(57);

      yield* sql`
        UPDATE orchestration_v2_projection_subagents
        SET payload_json = json_set(payload_json, '$.workflow.agents', json('[]'))
        WHERE json_type(payload_json, '$.workflow') = 'object'
          AND json_type(payload_json, '$.workflow.agents') IS NULL
      `;
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.workflow.agents', json('[]'))
        WHERE event_type = 'subagent.updated'
          AND json_type(payload_json, '$.workflow') = 'object'
          AND json_type(payload_json, '$.workflow.agents') IS NULL
      `;
      yield* sql`
        UPDATE orchestration_v2_effect_outbox
        SET status = 'cancelled',
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          last_error = 'Cancelled by the fork database upgrade: unsupported effect type'
        WHERE effect_type = 'terminal.close-idle' AND status IN ('pending', 'running')
      `;

      const removed = yield* removeHermesThreads;

      for (const index of FORK_ONLY_INDEXES) yield* sql`DROP INDEX IF EXISTS ${sql(index)}`;
      for (const table of FORK_ONLY_TABLES) yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;

      const recorded = migrations
        .filter(([id]) => id >= FIRST_FORK_MIGRATION_ID && id <= UPGRADED_THROUGH_ID)
        .map(([id, name]) => [id, name] as const);
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${FIRST_FORK_MIGRATION_ID}`;
      for (const [id, name] of recorded) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      yield* Effect.log("Upgraded fork database in place").pipe(
        Effect.annotateLogs({
          forkMigrationId,
          removedHermesThreads: removed.hermesThreads,
          removedLinkedThreads: removed.linkedThreads,
          removedRows: removed.removedRows,
        }),
      );
      return recorded;
    }),
  );
});
