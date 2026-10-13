import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import ProjectionProjectsDefaultThreadEnvMode from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import ProjectionProjectFaviconPath from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import AuthSessionClientConnection from "./Migrations/041_AuthSessionClientConnection.ts";
import ProjectionProjectIcon from "./Migrations/047_ProjectionProjectIcon.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import ScheduledTaskWebhooks from "./Migrations/057_ScheduledTaskWebhooks.ts";
import WebhookRelayDeliveries from "./Migrations/058_WebhookRelayDeliveries.ts";
import McpAppModelContext from "./Migrations/059_McpAppModelContext.ts";
import PullRequestReviewGuides from "./Migrations/061_PullRequestReviewGuides.ts";

// The fork's journal from 36. Its 36..44 are this build's 055 setup steps without the last three.
const FORK_HISTORY = [
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
];

const exec = (statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(statement);
  });

// Fork schema changes after 44. Fork-only tables keep only their keys and foreign keys.
const FORK_STEPS: Record<number, Effect.Effect<unknown, SqlError, SqlClient.SqlClient>> = {
  45: Effect.all([
    exec(`CREATE TABLE hermes_session_bindings (
      binding_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
      parent_binding_id TEXT REFERENCES hermes_session_bindings(binding_id))`),
    exec(`CREATE TABLE hermes_mutation_intents (
      operation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
      binding_id TEXT REFERENCES hermes_session_bindings(binding_id) ON DELETE CASCADE)`),
  ]),
  46: Effect.all([
    exec(`CREATE TABLE hermes_proactive_sources (source_id TEXT PRIMARY KEY)`),
    exec(`CREATE TABLE hermes_proactive_events (
      event_id TEXT PRIMARY KEY, thread_id TEXT,
      source_id TEXT NOT NULL REFERENCES hermes_proactive_sources(source_id) ON DELETE CASCADE)`),
    exec(`CREATE TABLE hermes_proactive_work_items (
      work_item_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES hermes_proactive_events(event_id) ON DELETE CASCADE)`),
    exec(`CREATE TABLE hermes_in_app_notifications (
      notification_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES hermes_proactive_events(event_id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL REFERENCES hermes_proactive_work_items(work_item_id) ON DELETE CASCADE)`),
    exec(`CREATE TABLE hermes_notification_outbox (
      outbox_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES hermes_proactive_events(event_id) ON DELETE CASCADE)`),
  ]),
  48: exec(
    `CREATE TABLE hermes_session_imports (import_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL)`,
  ),
  51: exec(
    `CREATE TABLE hermes_cron_run_watermarks (job_identity TEXT PRIMARY KEY, thread_id TEXT)`,
  ),
  52: ProjectionProjectsDefaultThreadEnvMode,
  53: ProjectionProjectFaviconPath,
  54: exec(
    `CREATE TABLE worktree_retention_registry (worktree_path TEXT PRIMARY KEY, thread_id TEXT)`,
  ),
  57: exec(`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_thread_run_idx
      ON orchestration_v2_projection_turn_items(thread_id, run_id)`),
  58: AuthSessionClientConnection,
  59: ProjectionProjectIcon,
  60: Effect.all([
    exec(
      `CREATE TABLE agent_session_imports (thread_id TEXT PRIMARY KEY, provider_thread_id TEXT NOT NULL)`,
    ),
    exec(`CREATE TABLE agent_session_import_sources (
      thread_id TEXT NOT NULL REFERENCES agent_session_imports(thread_id), file_path TEXT NOT NULL,
      PRIMARY KEY (thread_id, file_path))`),
  ]),
  61: Effect.all([
    exec(`CREATE TABLE hermes_work_runs (session_id TEXT PRIMARY KEY)`),
    exec(`CREATE TABLE hermes_work_sync_cursors (profile TEXT PRIMARY KEY)`),
  ]),
  63: exec(`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_live_command_idx
      ON orchestration_v2_projection_turn_items(thread_id)
      WHERE type = 'command_execution'
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`),
  64: ScheduledTaskWebhooks,
  65: WebhookRelayDeliveries,
  66: McpAppModelContext,
  67: exec(`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_thread_run_idx
      ON orchestration_v2_projection_messages(thread_id, run_id)`),
  68: Effect.all([
    exec(`CREATE INDEX IF NOT EXISTS idx_orch_events_versions
      ON orchestration_events(event_type, json_extract(payload_json, '$.id'), sequence)
      WHERE application_event_version = 2 AND event_type IN ('turn-item.updated', 'message.updated')`),
    exec(`CREATE TABLE IF NOT EXISTS orchestration_event_compaction_cursors (
      pass TEXT PRIMARY KEY, through_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL)`),
  ]),
  69: PullRequestReviewGuides,
};

const seedForkSchema = (throughId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // layerSetup enables foreign keys before migrating.
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 35 });
    yield* OrchestrationV2;
    for (const index of [
      "idx_orchestration_events_application_high_water",
      "idx_orchestration_events_agent_stream_sequence",
      "orchestration_events_v2_created_threads_idx",
      "orchestration_v2_projection_runs_recovery_idx",
      "orchestration_v2_projection_requests_recovery_idx",
      "orchestration_v2_projection_turn_items_recovery_idx",
      "orchestration_v2_projection_turn_items_thread_run_idx",
      "orchestration_v2_projection_turn_items_shell_pending_idx",
      "orchestration_v2_projection_messages_latest_user_idx",
    ]) {
      yield* sql`DROP INDEX ${sql(index)}`;
    }
    for (const [offset, name] of FORK_HISTORY.entries()) {
      const id = 36 + offset;
      if (id > throughId) break;
      const step = FORK_STEPS[id];
      if (step !== undefined) yield* step;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
  });

const NOW = "2026-10-01T00:00:00.000Z";

const insertThread = (input: {
  readonly id: string;
  readonly instance: string;
  readonly parentThreadId?: string;
  readonly payload?: Record<string, unknown>;
  readonly deletedAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      id: input.id,
      providerInstanceId: input.instance,
      lineage: { parentThreadId: input.parentThreadId ?? null, rootThreadId: input.id },
      ...input.payload,
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      )
      VALUES (${input.id}, 'project-1', ${input.id}, ${input.instance}, 'full-access', 'default',
        ${NOW}, ${NOW}, ${input.deletedAt ?? null}, ${payload})
    `;
    yield* insertEvent(input.id, "thread.created", {
      id: input.id,
      providerInstanceId: input.instance,
    });
    yield* sql`
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
      )
      VALUES (${`command:${input.id}`}, 'thread', ${input.id}, ${NOW},
        (SELECT MAX(sequence) FROM orchestration_events), 'accepted', 'thread.create')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status, available_at,
        created_at, updated_at
      )
      VALUES (${`effect:${input.id}`}, ${`command:${input.id}`}, ${input.id}, 'checkpoint.capture',
        '{}', 'succeeded', ${NOW}, ${NOW}, ${NOW})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      VALUES (${input.id}, ${`item:${input.id}`}, 1)
    `;
  });

const insertEvent = (threadId: string, type: string, payload: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      )
      VALUES (${`${threadId}:${type}`}, 'thread', ${threadId},
        (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${threadId}),
        ${type}, ${NOW}, 'server', ${JSON.stringify(payload)}, '{"applicationEventVersion":2}', 2)
    `;
  });

const insertSubagent = (input: {
  readonly id: string;
  readonly threadId: string;
  readonly childThreadId: string;
  readonly payload: unknown;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents (
        subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status,
        updated_at, payload_json
      )
      VALUES (${input.id}, ${input.threadId}, 'node-1', 'claudeAgent', ${input.childThreadId},
        'app_owned', 'completed', ${NOW}, ${JSON.stringify(input.payload)})
    `;
  });

const SURVIVING_THREADS = [
  "thread-pinned",
  "thread-prs",
  "thread-deleted-with-live-child",
  "thread-live-child",
];
const HERMES_THREADS = [
  "thread-hermes",
  "thread-hermes-child",
  "thread-hermes-custom",
  "thread-deleted-hermes-parent",
];
const WORKFLOW = { name: "review", description: "Review", phases: [] };

const seedForkData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* insertThread({
    id: "thread-pinned",
    instance: "claudeAgent",
    payload: { pinnedAt: NOW, pinOrderKey: "a0" },
  });
  yield* insertThread({
    id: "thread-prs",
    instance: "codex",
    payload: {
      pullRequests: [
        {
          host: "github.com",
          repository: "owner/repo",
          number: 7,
          url: "https://github.com/owner/repo/pull/7",
        },
      ],
    },
  });
  // A subagent workflow the fork wrote without `agents`.
  yield* insertSubagent({
    id: "subagent-review",
    threadId: "thread-pinned",
    childThreadId: "thread-pinned-child",
    payload: { id: "subagent-review", workflow: WORKFLOW },
  });
  yield* insertEvent("thread-pinned", "subagent.updated", {
    id: "subagent-review",
    workflow: WORKFLOW,
  });
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox (
      effect_id, command_id, thread_id, effect_type, payload_json, status, available_at,
      created_at, updated_at
    )
    VALUES ('effect:close-idle', 'command:thread-pinned', 'thread-pinned', 'terminal.close-idle',
      '{}', 'pending', ${NOW}, ${NOW}, ${NOW})
  `;

  yield* insertThread({ id: "thread-hermes", instance: "hermes" });
  yield* insertThread({
    id: "thread-hermes-child",
    instance: "claudeAgent",
    parentThreadId: "thread-hermes",
  });
  yield* insertSubagent({
    id: "subagent-hermes",
    threadId: "thread-hermes",
    childThreadId: "thread-hermes-child",
    payload: { id: "subagent-hermes" },
  });
  // A custom Hermes instance, recognized by the driver its provider thread recorded.
  yield* insertThread({ id: "thread-hermes-custom", instance: "hermes_work" });
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads (
      provider_thread_id, thread_id, provider, status, updated_at, payload_json
    )
    VALUES ('provider-thread-hermes-custom', 'thread-hermes-custom', 'hermes_work', 'idle', ${NOW},
      '{"driver":"hermes","providerInstanceId":"hermes_work"}')
  `;
  // Links from a surviving thread to Hermes threads.
  yield* insertSubagent({
    id: "subagent-delegated-to-hermes",
    threadId: "thread-prs",
    childThreadId: "thread-hermes-custom",
    payload: { id: "subagent-delegated-to-hermes" },
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_context_transfers (
      context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json
    )
    VALUES ('transfer-spawn', 'thread-prs', 'thread-hermes-custom', 'subagent_spawn', 'consumed',
      ${NOW}, '{}')
  `;
  // Already deleted by the user, and only linked to a Hermes thread.
  yield* insertThread({
    id: "thread-deleted-hermes-parent",
    instance: "claudeAgent",
    deletedAt: NOW,
  });
  yield* insertSubagent({
    id: "subagent-deleted-parent",
    threadId: "thread-deleted-hermes-parent",
    childThreadId: "thread-hermes",
    payload: { id: "subagent-deleted-parent" },
  });
  // Deleted and linked to a Hermes thread, but a thread below it is still live.
  yield* insertThread({
    id: "thread-deleted-with-live-child",
    instance: "codex",
    deletedAt: NOW,
  });
  yield* insertThread({
    id: "thread-live-child",
    instance: "claudeAgent",
    parentThreadId: "thread-deleted-with-live-child",
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_context_transfers (
      context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json
    )
    VALUES ('transfer-from-hermes', 'thread-hermes', 'thread-deleted-with-live-child', 'handoff',
      'consumed', ${NOW}, '{}')
  `;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at,
      default_model_selection_json
    )
    VALUES
      ('project-hermes', 'T3 Work', '/tmp/work', '[]', ${NOW}, ${NOW},
        '{"instanceId":"hermes","model":"default"}'),
      ('project-codex', 'Code', '/tmp/code', '[]', ${NOW}, ${NOW},
        '{"instanceId":"codex","model":"gpt-5.4"}')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at)
    VALUES ('thread-hermes', ${NOW}, ${NOW})
  `;
  yield* sql`
    INSERT INTO hermes_session_bindings (binding_id, thread_id, parent_binding_id)
    VALUES ('binding-root', 'thread-hermes', NULL), ('binding-branch', 'thread-hermes', 'binding-root')
  `;
  yield* sql`
    INSERT INTO hermes_mutation_intents (operation_id, thread_id, binding_id)
    VALUES ('intent-1', 'thread-hermes', 'binding-branch')
  `;
  yield* sql`INSERT INTO hermes_proactive_sources (source_id) VALUES ('source-1')`;
  yield* sql`
    INSERT INTO hermes_proactive_events (event_id, thread_id, source_id)
    VALUES ('proactive-1', 'thread-hermes', 'source-1')
  `;
  yield* sql`
    INSERT INTO worktree_retention_registry (worktree_path, thread_id)
    VALUES ('/tmp/worktree', 'thread-pinned')
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_metadata
    SET last_sequence = (SELECT MAX(sequence) FROM orchestration_events)
    WHERE projection_name = 'thread-projections'
  `;
});

const normalizeSql = (statement: string) =>
  statement.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "").trim();

const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<Record<string, unknown>>`
    SELECT m.name AS table_name, c.name, c.type, c."notnull", c.dflt_value, c.pk
    FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS c
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.name, c.name
  `;
  const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
    SELECT name, sql FROM sqlite_master
    WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL
    ORDER BY name
  `;
  return {
    columns,
    indexes: indexes.map((index) => `${index.name}: ${normalizeSql(index.sql)}`),
  };
});

const freshSchema = Effect.gen(function* () {
  yield* runMigrations();
  return yield* schema;
}).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const threadRows = (threadIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      threads: yield* sql`
        SELECT * FROM orchestration_v2_projection_threads
        WHERE thread_id IN ${sql.in(threadIds)} ORDER BY thread_id
      `,
      events: yield* sql`
        SELECT sequence, event_id, stream_id, event_type, payload_json FROM orchestration_events
        WHERE stream_id IN ${sql.in(threadIds)} ORDER BY sequence
      `,
      receipts: yield* sql`
        SELECT * FROM orchestration_command_receipts
        WHERE aggregate_id IN ${sql.in(threadIds)} ORDER BY command_id
      `,
    };
  });

/** Every row in any table whose thread-shaped column names one of `threadIds`. */
const threadReferences = (threadIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly table_name: string; readonly name: string }>`
      SELECT m.name AS table_name, c.name
      FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS c
      WHERE m.type = 'table'
        AND (c.name LIKE '%thread_id' OR c.name IN ('stream_id', 'aggregate_id'))
    `;
    const references: Array<string> = [];
    for (const column of columns) {
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ${sql(column.table_name)}
        WHERE ${sql(column.name)} IN ${sql.in(threadIds)}
      `;
      if ((rows[0]?.count ?? 0) > 0) references.push(`${column.table_name}.${column.name}`);
    }
    return references;
  });

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

describe("upgradeForkDatabase", () => {
  it.effect("upgrades a fork database to this build's schema and keeps its threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkSchema(69);
      yield* seedForkData;
      const survivingBefore = yield* threadRows(SURVIVING_THREADS);

      const executed = yield* runMigrations();

      assert.deepStrictEqual(
        executed,
        migrationManifest.filter(([id]) => id >= 36),
      );
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* schema, yield* freshSchema);

      const survivingAfter = yield* threadRows(SURVIVING_THREADS);
      assert.deepStrictEqual(survivingAfter.threads, survivingBefore.threads);
      assert.deepStrictEqual(survivingAfter.receipts, survivingBefore.receipts);
      assert.deepStrictEqual(
        survivingAfter.events.map((event) => event.event_id),
        survivingBefore.events.map((event) => event.event_id),
      );
      const subagentEvent = survivingAfter.events.find(
        (event) => event.event_type === "subagent.updated",
      );
      assert.deepStrictEqual(JSON.parse(String(subagentEvent?.payload_json)), {
        id: "subagent-review",
        workflow: { ...WORKFLOW, agents: [] },
      });
      const subagents = yield* sql<{ readonly subagent_id: string; readonly payload_json: string }>`
        SELECT subagent_id, payload_json FROM orchestration_v2_projection_subagents
      `;
      assert.deepStrictEqual(
        subagents.map((row) => [row.subagent_id, JSON.parse(row.payload_json)]),
        [["subagent-review", { id: "subagent-review", workflow: { ...WORKFLOW, agents: [] } }]],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT effect_id, status FROM orchestration_v2_effect_outbox ORDER BY effect_id
        `,
        [
          { effect_id: "effect:close-idle", status: "cancelled" },
          { effect_id: "effect:thread-deleted-with-live-child", status: "succeeded" },
          { effect_id: "effect:thread-live-child", status: "succeeded" },
          { effect_id: "effect:thread-pinned", status: "succeeded" },
          { effect_id: "effect:thread-prs", status: "succeeded" },
        ],
      );

      assert.deepStrictEqual(yield* threadReferences(HERMES_THREADS), []);
      assert.deepStrictEqual(
        yield* sql`SELECT context_transfer_id FROM orchestration_v2_projection_context_transfers`,
        [],
      );
      // The newest events were Hermes events.
      assert.deepStrictEqual(
        yield* sql`
          SELECT last_sequence FROM orchestration_v2_projection_metadata
          WHERE projection_name = 'thread-projections'
        `,
        [{ last_sequence: survivingBefore.events.at(-1)?.sequence }],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT project_id, default_model_selection_json FROM projection_projects
          WHERE project_id IN ('project-hermes', 'project-codex') ORDER BY project_id
        `,
        [
          {
            project_id: "project-codex",
            default_model_selection_json: '{"instanceId":"codex","model":"gpt-5.4"}',
          },
          { project_id: "project-hermes", default_model_selection_json: null },
        ],
      );
      const tables = yield* tableNames;
      assert.isFalse(tables.some((table) => table.startsWith("hermes_")));
      assert.notInclude(tables, "worktree_retention_registry");

      // Idempotent: a second start changes nothing.
      const before = {
        schema: yield* schema,
        rows: yield* threadRows([...SURVIVING_THREADS, ...HERMES_THREADS]),
      };
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        {
          schema: yield* schema,
          rows: yield* threadRows([...SURVIVING_THREADS, ...HERMES_THREADS]),
        },
        before,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades the shortest supported fork history", () =>
    Effect.gen(function* () {
      yield* seedForkSchema(44);

      yield* runMigrations();

      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* schema, yield* freshSchema);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([
    ["a gap", 50],
    ["a renamed migration", 52],
  ] as const)("refuses a fork history with %s and leaves it unchanged", ([kind, id]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkSchema(69);
      if (kind === "a gap") {
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id}`;
      } else {
        yield* sql`UPDATE effect_sql_migrations SET name = 'LocalChange' WHERE migration_id = ${id}`;
      }
      const before = { history: yield* history, schema: yield* schema };

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "not a contiguous fork history");
      assert.deepStrictEqual({ history: yield* history, schema: yield* schema }, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a fork history that stops before its V2 schema is complete", () =>
    Effect.gen(function* () {
      yield* seedForkSchema(43);
      const before = yield* history;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves this build's databases untouched", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertThread({ id: "thread-hermes", instance: "hermes" });
      const before = { schema: yield* schema, rows: yield* threadRows(["thread-hermes"]) };

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        { schema: yield* schema, rows: yield* threadRows(["thread-hermes"]) },
        before,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
