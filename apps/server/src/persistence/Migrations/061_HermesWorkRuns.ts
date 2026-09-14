import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE hermes_work_runs (
    provider_instance_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    session_id TEXT NOT NULL,
    job_id TEXT,
    snapshot_json TEXT NOT NULL,
    result_json TEXT,
    read_at TEXT,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (provider_instance_id, profile, session_id)
  )`;
  yield* sql`CREATE TABLE hermes_work_sync_cursors (provider_instance_id TEXT NOT NULL, profile TEXT NOT NULL, cursor_json TEXT NOT NULL, PRIMARY KEY(provider_instance_id, profile))`;
  yield* sql`CREATE INDEX hermes_work_runs_job ON hermes_work_runs(provider_instance_id, profile, job_id)`;
});
