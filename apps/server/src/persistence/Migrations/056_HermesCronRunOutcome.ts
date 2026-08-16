import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * How the last run of a cron job ended, alongside the watermark that says when.
 *
 * A run time on its own cannot tell a healthy schedule from one that has been
 * failing for a week — the shipped Hermes build reported six days of quota
 * errors that T3 rendered as an ordinary "it ran". Storing the status next to
 * the watermark is also what lets a job that fails twice at the same reported
 * time be announced once rather than never.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE hermes_cron_run_watermarks ADD COLUMN last_status TEXT`;
});
