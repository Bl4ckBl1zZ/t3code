import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const threadPayload = (input: {
  readonly threadId: string;
  readonly settledAt?: string | null;
  readonly settledOverride?: string | null;
}): string =>
  JSON.stringify({
    id: input.threadId,
    settledAt: input.settledAt ?? null,
    settledOverride: input.settledOverride ?? null,
  });

/** A migrated source db with one V2 thread per lifecycle state. Only
 * `stopped-thread` qualifies for the clone. */
const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "state.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const threads = [
        // threadId, projectId, settledAt, settledOverride, activeRun, liveSession
        ["stopped-thread", "project-kept", null, null, false, false],
        ["running-thread", "project-kept", null, null, true, false],
        ["settled-thread", "project-kept", "2026-08-01T00:00:00.000Z", "settled", false, false],
        ["monitored-thread", "project-kept", null, null, false, true],
        ["deleted-project-thread", "project-deleted", null, null, false, false],
      ] as const;
      for (const [
        threadId,
        projectId,
        settledAt,
        settledOverride,
        activeRun,
        liveSession,
      ] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
           interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at,
           deleted_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'codex', 'full-access',
           'default', NULL, '2026-08-01', '2026-08-01', NULL, NULL,
           ${threadPayload({ threadId, settledAt, settledOverride })})`;
        if (activeRun) {
          yield* sql`INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
             completed_at, payload_json)
            VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', NULL, 'running',
             '2026-08-01', NULL, '{}')`;
        }
        if (liveSession) {
          yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
            (provider_session_id, thread_id, provider, status, model, updated_at, payload_json)
            VALUES (${`session-${threadId}`}, ${threadId}, 'codex', 'ready', NULL,
             '2026-08-01', '{}')`;
        }
        yield* sql`INSERT INTO orchestration_v2_events
          (event_id, command_id, thread_id, event_type, occurred_at, payload_json)
          VALUES (${`event-${threadId}`}, NULL, ${threadId}, 'thread.created', '2026-08-01', '{}')`;
      }
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES
        ('event-project-kept', 'project', 'project-kept', 0, 'project.created', '2026-08-01', 'user', '{}', '{}'),
        ('event-project-deleted', 'project', 'project-deleted', 0, 'project.created', '2026-08-01', 'user', '{}', '{}')`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("keeps only stopped threads from live projects and clears auth state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "state.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_events`;
          const projectEvents = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const [auth] = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM auth_sessions`;
          return { threads, events, projectEvents, authCount: auth?.count ?? 0 };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.thread_id),
        ["stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.projectEvents.map((row) => row.stream_id),
        ["project-kept"],
      );
      assert.equal(kept.authCount, 0);
    }),
  );

  it.effect("fails loudly on a migration slot collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      // Simulate another branch having claimed slot 1 first: the id is
      // recorded, so this checkout's migration 1 silently never runs.
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations
            SET name = 'SomebodyElsesMigration' WHERE migration_id = 1`;
        }),
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSlotCollisionError");
      if (error._tag === "MigrateDevDbSlotCollisionError") {
        assert.equal(error.slot, 1);
        assert.equal(error.appliedName, "SomebodyElsesMigration");
      }
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      // This test process stands in for a live dev server.
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect("refuses a source that resolves to a destination path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      // A leftover snapshot from a prior failed run, passed as --source: it
      // must not be deleted before it is read.
      const leftoverSnapshot = path.join(destDir, "userdata", "state.sqlite.migrate-dev-db-tmp");
      yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
      yield* fs.writeFileString(leftoverSnapshot, "not a real db");

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.exists(leftoverSnapshot), true);
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );
});
