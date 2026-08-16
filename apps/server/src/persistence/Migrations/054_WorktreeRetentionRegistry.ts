import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE worktree_retention_registry (
      repository_root TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      project_id TEXT,
      thread_id TEXT,
      branch TEXT,
      ownership TEXT NOT NULL CHECK (ownership IN ('t3-created', 'legacy-discovered', 'unmanaged')),
      created_at_ms INTEGER,
      discovered_at_ms INTEGER NOT NULL,
      last_activity_at_ms INTEGER,
      state TEXT NOT NULL CHECK (state IN ('present', 'removed')),
      last_reason TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (repository_root, worktree_path)
    )
  `;

  yield* sql`
    CREATE INDEX idx_worktree_retention_registry_state
    ON worktree_retention_registry (state, updated_at_ms)
  `;

  yield* sql`
    CREATE INDEX idx_worktree_retention_registry_thread_path
    ON worktree_retention_registry (thread_id, worktree_path, state)
  `;
});
