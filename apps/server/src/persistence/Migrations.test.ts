import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const forkMigrations = migrationManifest.filter(([id]) => id >= 36);
const latestMigration = migrationManifest.at(-1)!;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const tableExists = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
    return rows.length > 0;
  });

/** A journal at 44 that also records the latest fork migration, leaving 45+ as a hole. */
const seedHoleAfter44 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 44 });
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (${latestMigration[0]}, ${latestMigration[1]})
  `;
});

const memoryDatabase = NodeSqliteClient.layerMemory();

describe("runMigrations", () => {
  it.effect("migrates a fresh database through the whole manifest", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isTrue(yield* tableExists("orchestration_v2_events"));
    }).pipe(Effect.provide(memoryDatabase)),
  );

  it.effect("refuses to start when a later id would skip fork migrations", () =>
    Effect.gen(function* () {
      yield* seedHoleAfter44;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of forkMigrations) {
        if (id <= 44 || id === latestMigration[0]) continue;
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.isFalse(yield* tableExists("hermes_session_bindings"));
    }).pipe(Effect.provide(memoryDatabase)),
  );

  it.effect("upgrades a database at exactly the divergence point", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 35 });
      assert.deepStrictEqual(yield* runMigrations(), forkMigrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(memoryDatabase)),
  );

  it.effect.each([30, 35])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), forkMigrations);
      assert.isTrue(yield* tableExists("orchestration_v2_events"));
    }).pipe(Effect.provide(memoryDatabase)),
  );

  it.effect("only checks fork migrations within the requested limit", () =>
    Effect.gen(function* () {
      yield* seedHoleAfter44;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 44 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 45 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "45_HermesSessionBindings (recorded: nothing)");
      assert.notInclude(String(exit), "46_");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(memoryDatabase)),
  );
});
