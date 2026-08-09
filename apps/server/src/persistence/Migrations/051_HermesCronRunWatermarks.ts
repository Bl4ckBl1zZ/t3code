import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The last cron run T3 knows about, per job.
 *
 * Hermes keeps running its schedule while T3 is closed and offers nothing to
 * replay those runs from, so the only way to notice one is to remember what the
 * job's last run time was the previous time T3 looked. A watermark that moves
 * without T3 having witnessed the run is a missed run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE hermes_cron_run_watermarks (
      provider_instance_id TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      job_identity TEXT NOT NULL,
      job_name TEXT,
      -- Verbatim from the gateway, which types this as either an ISO string or
      -- an epoch number. Comparison is by equality, never by ordering, so no
      -- normalisation is required and none is invented.
      last_run_at TEXT,
      thread_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_instance_id, profile_key, job_identity)
    )
  `;
});
