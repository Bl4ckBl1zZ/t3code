import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Private import receipts and fingerprints; conversation state stays in the V2 JSON projection. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_session_imports (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    provider_thread_id TEXT NOT NULL UNIQUE
  )`;
  yield* sql`CREATE INDEX agent_session_imports_project_idx ON agent_session_imports(project_id)`;
  yield* sql`CREATE TABLE agent_session_import_sources (
    thread_id TEXT NOT NULL REFERENCES agent_session_imports(thread_id),
    file_path TEXT NOT NULL,
    source_json TEXT NOT NULL,
    PRIMARY KEY(thread_id, file_path)
  )`;
});
