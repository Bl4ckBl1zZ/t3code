import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Partial index for the shell snapshot's live background commands.
 *
 * The shell reads, per thread, the command items that are still running. No
 * index carried type/status, so SQLite fetched every turn item row of every
 * thread to find the handful that match — ~130-220ms per full shell on a 126k
 * item store, and far worse once those pages are cold. Only live commands are
 * indexed, so this stays tiny. The WHERE clause has to match the shell query's
 * terms exactly for SQLite to use it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_live_command_idx
      ON orchestration_v2_projection_turn_items(thread_id)
      WHERE type = 'command_execution'
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
  `;
});
