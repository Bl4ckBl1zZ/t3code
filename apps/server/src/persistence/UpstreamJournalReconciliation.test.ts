import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations, UpstreamMigrationJournalError } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const freshDatabase = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/**
 * Reproduce a database last opened by the official app: shared prefix through
 * 35, then upstream's own 36+ journal rows and their (additive) schema
 * changes, with none of the fork's orchestration_v2_* tables.
 */
const seedOfficialAppDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 35 });
  yield* sql`ALTER TABLE projection_threads ADD COLUMN pinned_at TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_keyset
    ON projection_turns(thread_id, requested_at, turn_id)
  `;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN pin_order_key TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN default_thread_env_mode TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN favicon_path TEXT`;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
      (36, 'ProjectionThreadsPinned', '2026-08-01T00:00:00.000Z'),
      (37, 'ProjectionTurnsKeysetIndex', '2026-08-01T00:00:00.000Z'),
      (38, 'ProjectionThreadsPinOrderKey', '2026-08-01T00:00:00.000Z'),
      (39, 'ProjectionProjectsDefaultThreadEnvMode', '2026-08-01T00:00:00.000Z'),
      (40, 'ProjectionProjectFaviconPath', '2026-08-01T00:00:00.000Z')
  `;
});

freshDatabase()("adopts an official-app database", (it) => {
  it.effect("resets the journal to the shared prefix and runs fork migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedOfficialAppDatabase;

      yield* runMigrations();

      const journal = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id IN (36, 39, 52)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(journal, [
        { migration_id: 36, name: "OrchestrationV2" },
        { migration_id: 39, name: "OrchestrationV2ProviderSessionBindings" },
        { migration_id: 52, name: "ProjectionProjectsDefaultThreadEnvMode" },
      ]);

      const v2Tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
      `;
      assert.isAtLeast(v2Tables.length, 1);

      // Upstream's additive columns stay in place and 052's guard tolerates them.
      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.strictEqual(
        projectColumns.filter((column) => column.name === "default_thread_env_mode").length,
        1,
      );
    }),
  );
});

freshDatabase()("fork-migrated database", (it) => {
  it.effect("is a no-op on a database the fork migrated itself", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const before = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM effect_sql_migrations
      `;

      yield* runMigrations();

      const after = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM effect_sql_migrations
      `;
      assert.deepStrictEqual(after, before);
    }),
  );
});

freshDatabase()("unaudited upstream journal", (it) => {
  it.effect("refuses journals containing upstream migrations it has not audited", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedOfficialAppDatabase;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (41, 'SomeFutureUpstreamMigration', '2026-08-01T00:00:00.000Z')
      `;

      const result = yield* Effect.flip(runMigrations());

      assert.instanceOf(result, UpstreamMigrationJournalError);
      assert.include(result.message, "41_SomeFutureUpstreamMigration");

      const journal = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM effect_sql_migrations WHERE migration_id >= 36
      `;
      assert.deepStrictEqual(journal, [{ n: 6 }]);
    }),
  );
});
