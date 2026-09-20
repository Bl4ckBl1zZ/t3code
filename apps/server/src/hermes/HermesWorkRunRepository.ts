import { HermesWorkRun } from "@t3tools/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const HermesWorkRunSnapshot = Schema.Struct({
  ...HermesWorkRun.fields,
  lastActive: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type HermesWorkRunSnapshot = typeof HermesWorkRunSnapshot.Type;
export class HermesWorkRunRepositoryError extends Schema.TaggedErrorClass<HermesWorkRunRepositoryError>()(
  "HermesWorkRunRepositoryError",
  { cause: Schema.Defect() },
) {}
export interface HermesWorkRunScope {
  readonly providerInstanceId: string;
  readonly profile: string;
  readonly jobId?: string;
  readonly sessionId?: string;
}
export const HermesWorkSyncCursor = Schema.Struct({
  watermark: Schema.Number,
  offset: Schema.Number,
  nextWatermark: Schema.Number,
  /** Rotation into the profile's cron jobs, so one sweep refreshes a bounded slice. */
  jobOffset: Schema.optional(Schema.Number),
});
export type HermesWorkSyncCursor = typeof HermesWorkSyncCursor.Type;
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(HermesWorkRunSnapshot));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(HermesWorkRunSnapshot));
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(HermesWorkSyncCursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(HermesWorkSyncCursor));
export class HermesWorkRunRepository extends Context.Service<
  HermesWorkRunRepository,
  {
    readonly pendingResults: (
      input: HermesWorkRunScope & { readonly now: string },
    ) => Effect.Effect<ReadonlyArray<string>, HermesWorkRunRepositoryError>;
    readonly getCursor: (
      input: HermesWorkRunScope,
    ) => Effect.Effect<HermesWorkSyncCursor, HermesWorkRunRepositoryError>;
    readonly saveCursor: (
      input: HermesWorkRunScope & { readonly cursor: HermesWorkSyncCursor },
    ) => Effect.Effect<void, HermesWorkRunRepositoryError>;
    readonly getResult: (
      input: HermesWorkRunScope & { readonly id: string },
    ) => Effect.Effect<string | null, HermesWorkRunRepositoryError>;
    readonly saveResult: (
      input: HermesWorkRunScope & { readonly id: string; readonly content: string },
    ) => Effect.Effect<void, HermesWorkRunRepositoryError>;
    readonly markRead: (
      input: HermesWorkRunScope & { readonly id: string; readonly now: string },
    ) => Effect.Effect<void, HermesWorkRunRepositoryError>;
    readonly list: (
      input: HermesWorkRunScope,
    ) => Effect.Effect<ReadonlyArray<HermesWorkRunSnapshot>, HermesWorkRunRepositoryError>;
    readonly upsert: (input: {
      readonly providerInstanceId: string;
      readonly runs: ReadonlyArray<HermesWorkRunSnapshot>;
      readonly observedAt: string;
    }) => Effect.Effect<void, HermesWorkRunRepositoryError>;
  }
>()("t3/hermes/HermesWorkRunRepository") {}

export const makeHermesWorkRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = Effect.fn("HermesWorkRunRepository.list")(
    function* (input: HermesWorkRunScope) {
      const rows = yield* sql<{
        snapshot_json: string;
        job_id: string | null;
        read_at: string | null;
        result_json: string | null;
      }>`SELECT snapshot_json, job_id, read_at FROM hermes_work_runs
      WHERE provider_instance_id = ${input.providerInstanceId} AND profile = ${input.profile}
      AND ${input.jobId === undefined ? sql`1 = 1` : sql`job_id = ${input.jobId}`}
      AND ${input.sessionId === undefined ? sql`1 = 1` : sql`session_id = ${input.sessionId}`}
      ORDER BY observed_at DESC, session_id DESC LIMIT 100`;
      return yield* Effect.forEach(rows, (row) =>
        decodeRun(row.snapshot_json).pipe(
          Effect.map((run) => ({ ...run, jobId: row.job_id, readAt: row.read_at })),
        ),
      );
    },
    Effect.mapError((cause) => new HermesWorkRunRepositoryError({ cause })),
  );
  const upsert = Effect.fn("HermesWorkRunRepository.upsert")(
    function* (input: {
      readonly providerInstanceId: string;
      readonly runs: ReadonlyArray<HermesWorkRunSnapshot>;
      readonly observedAt: string;
    }) {
      yield* sql.withTransaction(
        Effect.forEach(
          input.runs,
          (run) => sql`
      INSERT INTO hermes_work_runs (provider_instance_id, profile, session_id, job_id, snapshot_json, observed_at)
      VALUES (${input.providerInstanceId}, ${run.profile}, ${run.id}, ${run.jobId}, ${encodeRun(run)}, ${input.observedAt})
      ON CONFLICT(provider_instance_id, profile, session_id) DO UPDATE SET
        job_id = COALESCE(excluded.job_id, hermes_work_runs.job_id),
        result_json = CASE WHEN json_extract(hermes_work_runs.snapshot_json, '$.lastActive') IS NOT json_extract(excluded.snapshot_json, '$.lastActive') OR json_extract(hermes_work_runs.snapshot_json, '$.active') = 1 OR json_extract(hermes_work_runs.snapshot_json, '$.endedAt') IS NOT json_extract(excluded.snapshot_json, '$.endedAt') THEN NULL ELSE hermes_work_runs.result_json END,
        snapshot_json = excluded.snapshot_json, observed_at = excluded.observed_at
    `,
          { discard: true },
        ),
      );
    },
    Effect.mapError((cause) => new HermesWorkRunRepositoryError({ cause })),
  );
  const getResult = Effect.fn("HermesWorkRunRepository.getResult")(
    function* (input: HermesWorkRunScope & { readonly id: string }) {
      const rows = yield* sql<{
        result_json: string | null;
      }>`SELECT result_json FROM hermes_work_runs WHERE provider_instance_id = ${input.providerInstanceId} AND profile = ${input.profile} AND session_id = ${input.id}`;
      return rows[0]?.result_json ?? null;
    },
    Effect.mapError((cause) => new HermesWorkRunRepositoryError({ cause })),
  );
  const saveResult = Effect.fn("HermesWorkRunRepository.saveResult")(
    function* (input: HermesWorkRunScope & { readonly id: string; readonly content: string }) {
      yield* sql`UPDATE hermes_work_runs SET result_json = ${input.content}, read_at = CASE WHEN result_json = ${input.content} THEN read_at ELSE NULL END WHERE provider_instance_id = ${input.providerInstanceId} AND profile = ${input.profile} AND session_id = ${input.id}`;
    },
    Effect.mapError((cause) => new HermesWorkRunRepositoryError({ cause })),
  );
  const markRead = Effect.fn("HermesWorkRunRepository.markRead")(
    function* (input: HermesWorkRunScope & { readonly id: string; readonly now: string }) {
      yield* sql`UPDATE hermes_work_runs SET read_at = ${input.now} WHERE provider_instance_id = ${input.providerInstanceId} AND profile = ${input.profile} AND session_id = ${input.id}`;
    },
    Effect.mapError((cause) => new HermesWorkRunRepositoryError({ cause })),
  );
  const getCursor = Effect.fn("HermesWorkRunRepository.getCursor")(
    function* (input: HermesWorkRunScope) {
      const rows = yield* sql<{
        cursor_json: string;
      }>`SELECT cursor_json FROM hermes_work_sync_cursors WHERE provider_instance_id = ${input.providerInstanceId} AND profile = ${input.profile}`;
      return rows[0]
        ? yield* decodeCursor(rows[0].cursor_json)
        : { watermark: 0, offset: 0, nextWatermark: 0 };
    },
    Effect.mapError((cause) => new HermesWorkRunRepositoryError({ cause })),
  );
  const saveCursor = Effect.fn("HermesWorkRunRepository.saveCursor")(
    function* (input: HermesWorkRunScope & { readonly cursor: HermesWorkSyncCursor }) {
      const encoded = yield* encodeCursor(input.cursor);
      yield* sql`INSERT INTO hermes_work_sync_cursors VALUES (${input.providerInstanceId}, ${input.profile}, ${encoded}) ON CONFLICT(provider_instance_id, profile) DO UPDATE SET cursor_json = excluded.cursor_json`;
    },
    Effect.mapError((cause) => new HermesWorkRunRepositoryError({ cause })),
  );
  /**
   * Claims the next batch of runs whose output still needs downloading.
   *
   * Claiming, rather than merely reading, is what keeps the queue moving: the
   * rows are stamped before they are handed out, so a run whose output never
   * downloads sinks to the back instead of holding a slot on every sweep. Runs
   * that have never been tried come first, newest first, because a scheduled
   * task someone is waiting on is worth more than a conversation from months
   * ago.
   */
  const pendingResults = Effect.fn("HermesWorkRunRepository.pendingResults")(
    function* (input: HermesWorkRunScope & { readonly now: string }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            session_id: string;
          }>`SELECT session_id FROM hermes_work_runs
            WHERE provider_instance_id = ${input.providerInstanceId}
              AND profile = ${input.profile}
              AND result_json IS NULL
            ORDER BY
              (result_attempted_at IS NULL) DESC,
              result_attempted_at ASC,
              session_id DESC
            LIMIT 10`;
          const ids = rows.map((row) => row.session_id);
          yield* Effect.forEach(
            ids,
            (id) =>
              sql`UPDATE hermes_work_runs SET result_attempted_at = ${input.now}
                WHERE provider_instance_id = ${input.providerInstanceId}
                  AND profile = ${input.profile}
                  AND session_id = ${id}`,
            { discard: true },
          );
          return ids;
        }),
      );
    },
    Effect.mapError((cause) => new HermesWorkRunRepositoryError({ cause })),
  );
  return HermesWorkRunRepository.of({
    list,
    upsert,
    getResult,
    saveResult,
    markRead,
    getCursor,
    saveCursor,
    pendingResults,
  });
});
export const hermesWorkRunRepositoryLayer = Layer.effect(
  HermesWorkRunRepository,
  makeHermesWorkRunRepository,
);
