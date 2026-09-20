import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records when output retrieval was last attempted for a run.
 *
 * Without it the pending-output queue orders by `observed_at, session_id`, and
 * every row in a profile shares one `observed_at` because a sweep stamps them
 * all at once. The order therefore collapses to `session_id`, which is stable:
 * ten sessions whose output never downloads hold the ten-row batch forever and
 * no other run's output is ever fetched. Stamping each attempt turns the queue
 * into a round robin, so a permanently failing run costs one slot per pass
 * instead of the whole queue.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE hermes_work_runs ADD COLUMN result_attempted_at TEXT`;
  yield* sql`CREATE INDEX hermes_work_runs_pending_result
    ON hermes_work_runs(provider_instance_id, profile, result_attempted_at)
    WHERE result_json IS NULL`;
});
