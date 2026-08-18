import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Covering index for the per-run item counts the shell snapshot reads.
 *
 * The unscoped count groups every turn item by (thread_id, run_id). The
 * existing thread_ordinal index carries neither run_id nor a usable grouping
 * order, so SQLite scanned it, looked run_id up row by row in the (large)
 * table, and sorted the result in a temp b-tree. Covering the exact grouping
 * keys turns that into an ordered index-only scan — measured 60-80ms down to
 * 10ms on a 64k-item store, for ~9MB of index.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_thread_run_idx
      ON orchestration_v2_projection_turn_items(thread_id, run_id)
  `;
});
