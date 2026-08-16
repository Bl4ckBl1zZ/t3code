import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_WorktreeRetentionLifecycle", (it) => {
  it.effect("adds generation claims and a claim lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* runMigrations({ toMigrationInclusive: 55 });

      const columns = yield* sql`
        PRAGMA table_info(worktree_retention_registry)
      `;
      assert.deepStrictEqual(
        columns
          .filter(({ name }) => name === "generation" || name === "removal_claimed_at_ms")
          .map(({ name, notnull, dflt_value }) => [name, notnull, dflt_value]),
        [
          ["generation", 1, "1"],
          ["removal_claimed_at_ms", 0, null],
        ],
      );

      const indexes = yield* sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_worktree_retention_registry_claim'
      `;
      assert.deepStrictEqual(indexes, [{ name: "idx_worktree_retention_registry_claim" }]);
    }),
  );
});
