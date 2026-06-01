import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "tab_group_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tab_group_id TEXT
    `;
  }

  if (!columns.some((column) => column.name === "tab_type")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tab_type TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET
      tab_group_id = COALESCE(tab_group_id, thread_id),
      tab_type = COALESCE(tab_type, 'chat')
    WHERE tab_group_id IS NULL
      OR tab_type IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_tab_group_created
    ON projection_threads(tab_group_id, created_at, thread_id)
  `;
});
