import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_WorktreeRetentionRegistry", (it) => {
  it.effect("creates the durable worktree inventory with safe ownership fields", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runMigrations({ toMigrationInclusive: 54 });

      const tables = yield* sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'worktree_retention_registry'
      `;
      assert.deepStrictEqual(tables, [{ name: "worktree_retention_registry" }]);

      const columns = yield* sql`
        PRAGMA table_info(worktree_retention_registry)
      `;
      assert.deepStrictEqual(
        columns.map(({ name, notnull }) => [name, notnull]),
        [
          ["repository_root", 1],
          ["worktree_path", 1],
          ["project_id", 0],
          ["thread_id", 0],
          ["branch", 0],
          ["ownership", 1],
          ["created_at_ms", 0],
          ["discovered_at_ms", 1],
          ["last_activity_at_ms", 0],
          ["state", 1],
          ["last_reason", 0],
          ["updated_at_ms", 1],
        ],
      );

      const indexes = yield* sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_worktree_retention_registry_state',
            'idx_worktree_retention_registry_thread_path'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(indexes, [
        { name: "idx_worktree_retention_registry_state" },
        { name: "idx_worktree_retention_registry_thread_path" },
      ]);
    }),
  );
});
