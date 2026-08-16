import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(worktree_retention_registry)
  `;

  if (!columns.some((column) => column.name === "generation")) {
    yield* sql`
      ALTER TABLE worktree_retention_registry
      ADD COLUMN generation INTEGER NOT NULL DEFAULT 1
    `;
  }
  if (!columns.some((column) => column.name === "removal_claimed_at_ms")) {
    yield* sql`
      ALTER TABLE worktree_retention_registry
      ADD COLUMN removal_claimed_at_ms INTEGER
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_worktree_retention_registry_claim
    ON worktree_retention_registry (state, removal_claimed_at_ms, generation)
  `;
});
