import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  forkMigrationMarkers,
  migrationManifest,
  runMigrations,
  UpstreamMigrationJournalError,
} from "./Migrations.ts";
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

freshDatabase()("fork migration markers", (it) => {
  it.effect("cover every fork migration and match the real schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const markerIds = new Set(forkMigrationMarkers.map(([id]) => id));
      const missing = migrationManifest
        .filter(([id]) => id >= 36 && !markerIds.has(id))
        .map(([id, name]) => `${id}_${name}`);
      assert.deepStrictEqual(missing, []);

      for (const [id, marker] of forkMigrationMarkers) {
        const rows =
          marker.kind === "column"
            ? yield* sql`
                SELECT 1 FROM pragma_table_info(${marker.table}) WHERE name = ${marker.column}
              `
            : yield* sql`
                SELECT 1 FROM sqlite_master
                WHERE type = ${marker.kind}
                  AND name = ${marker.kind === "table" ? marker.table : marker.index}
              `;
        assert.strictEqual(rows.length, 1, `marker for migration ${id} not found in schema`);
      }
    }),
  );
});

freshDatabase()("journal lost after fork migrations ran", (it) => {
  it.effect("re-stamps the journal from schema markers instead of re-running", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO orchestration_v2_events (
          event_id, thread_id, event_type, occurred_at, payload_json
        ) VALUES ('evt-1', 'thread-1', 'test', '2026-08-01T00:00:00.000Z', '{}')
      `;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 36`;

      yield* runMigrations();

      const journal = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id IN (36, 52) ORDER BY migration_id
      `;
      assert.deepStrictEqual(journal, [
        { migration_id: 36, name: "OrchestrationV2" },
        { migration_id: 52, name: "ProjectionProjectsDefaultThreadEnvMode" },
      ]);

      const events = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_v2_events
      `;
      assert.deepStrictEqual(events, [{ event_id: "evt-1" }]);
    }),
  );
});

freshDatabase()("renumbered fork journal", (it) => {
  it.effect("drops fork rows journaled under wrong ids and re-stamps from markers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // A patched build renumbered the fork migrations in the journal. The
      // shift has to clear the real id range in one statement, or it collides
      // with a row it has not moved yet — so it is far larger than the number
      // of migrations rather than just past today's last one.
      yield* sql`
        UPDATE effect_sql_migrations SET migration_id = migration_id + 1000
        WHERE migration_id >= 36
      `;

      yield* runMigrations();

      const journal = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id >= 36 ORDER BY migration_id
      `;
      assert.strictEqual(journal.length, 23);
      assert.deepStrictEqual(journal[0], { migration_id: 36, name: "OrchestrationV2" });
      assert.deepStrictEqual(journal[22], {
        migration_id: 58,
        name: "AuthSessionClientConnection",
      });
    }),
  );
});

freshDatabase()("partially migrated fork database", (it) => {
  it.effect("adopts only the contiguous prefix and runs the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 36`;

      yield* runMigrations();

      const journal = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM effect_sql_migrations WHERE migration_id >= 36
      `;
      assert.deepStrictEqual(journal, [{ n: 23 }]);

      const hermes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hermes_session_bindings'
      `;
      assert.strictEqual(hermes.length, 1);
    }),
  );
});
