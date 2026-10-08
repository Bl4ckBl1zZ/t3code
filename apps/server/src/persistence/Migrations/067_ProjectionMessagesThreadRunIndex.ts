import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Per-run message lookups for windowed thread snapshots.
 *
 * A windowed snapshot reads the messages of the runs it keeps plus every
 * runless message of the thread. The existing indexes are on run_id alone
 * (runless rows of every thread share one key) and on (thread_id,
 * created_at), so either lookup walked the thread's whole message history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_thread_run_idx
      ON orchestration_v2_projection_messages(thread_id, run_id)
  `;
});
