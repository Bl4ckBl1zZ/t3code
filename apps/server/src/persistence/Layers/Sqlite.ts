import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // Lets event-store compaction hand freed pages back to the filesystem in
    // small steps (`PRAGMA incremental_vacuum`). It only takes effect on a
    // database that has no tables yet, so it must precede journal_mode, which
    // writes the header; on an existing database it is a no-op, and only an
    // offline VACUUM converts it.
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // WAL defaults to `synchronous = FULL`, which fsyncs on every commit. The
    // orchestration event stream commits continuously while a run is
    // streaming, so that default costs one fsync per provider event and
    // stalls the (synchronous) SQLite driver — and therefore every connected
    // client's frames — on disk I/O.
    //
    // `NORMAL` keeps WAL crash-safe for process crashes; only an OS crash or
    // power loss can drop the most recent commits. That is an acceptable
    // trade here: projections are rebuildable from the event log, and a run
    // interrupted by power loss is re-run rather than resumed mid-turn.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
    // SQLite's recommended pattern for long-lived connections: refresh planner
    // statistics on open, and periodically after (event-store compaction does).
    // Without sqlite_stat1 the planner guesses row counts and can pick an
    // index that scans most of a multi-GB table. analysis_limit samples each
    // index instead of reading it whole. The first run on a 6.6 GB store took
    // ~1s warm and ~12s from a cold disk cache, once; with statistics present
    // it takes under 1ms.
    yield* sql`PRAGMA analysis_limit = 400;`;
    yield* sql`PRAGMA optimize = 0x10002;`;
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath);
  }),
);
