import { Context, DateTime, Duration, Effect, Layer, Schedule, Schema } from "effect";
import type * as Scope from "effect/Scope";

import { HermesDashboardClient } from "./HermesDashboardClient.ts";
import { HermesWorkRunRepository, type HermesWorkRunSnapshot } from "./HermesWorkRunRepository.ts";

const encodeResult = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Job = Schema.Struct({ id: Schema.String, profile: Schema.optional(Schema.String) });
const Jobs = Schema.Array(Job);
const Session = Schema.Struct({
  id: Schema.String,
  profile: Schema.optional(Schema.String),
  source: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  started_at: Schema.optional(Schema.NullOr(Schema.Number)),
  ended_at: Schema.optional(Schema.NullOr(Schema.Number)),
  is_active: Schema.optional(Schema.Boolean),
  last_active: Schema.optional(Schema.Number),
  end_reason: Schema.optional(Schema.NullOr(Schema.String)),
  preview: Schema.optional(Schema.NullOr(Schema.String)),
});
const Runs = Schema.Struct({ runs: Schema.Array(Session) });
const Sessions = Schema.Struct({ sessions: Schema.Array(Session), total: Schema.Number });
const Profiles = Schema.Struct({ profiles: Schema.Array(Schema.Struct({ name: Schema.String })) });

const decodeProfiles = Schema.decodeUnknownEffect(Profiles);
const decodeJobs = Schema.decodeUnknownEffect(Jobs);
const decodeRuns = Schema.decodeUnknownEffect(Runs);
const decodeSessions = Schema.decodeUnknownEffect(Sessions);

export class HermesWorkSyncService extends Context.Service<
  HermesWorkSyncService,
  {
    readonly sweep: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/hermes/HermesWorkSyncService") {}

/** Observes Hermes-owned execution. This service never starts or resumes work. */
export const makeHermesWorkSyncService = Effect.gen(function* () {
  const dashboard = yield* HermesDashboardClient;
  const repository = yield* HermesWorkRunRepository;
  const reconcile = Effect.fn("HermesWorkSyncService.reconcile")(function* (
    providerInstanceId: string,
  ) {
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const profiles = yield* dashboard
      .request({ providerInstanceId, method: "GET", path: "/api/profiles" })
      .pipe(Effect.flatMap(decodeProfiles));
    for (const { name: profile } of profiles.profiles) {
      const jobs = yield* dashboard
        .request({ providerInstanceId, profile, method: "GET", path: "/api/cron/jobs" })
        .pipe(Effect.flatMap(decodeJobs));
      const snapshots = new Map<string, HermesWorkRunSnapshot>();
      for (const job of jobs) {
        const result = yield* dashboard
          .request({
            providerInstanceId,
            profile,
            method: "GET",
            path: `/api/cron/jobs/${encodeURIComponent(job.id)}/runs`,
            query: { limit: 20 },
          })
          .pipe(Effect.flatMap(decodeRuns));
        for (const run of result.runs)
          snapshots.set(run.id, {
            lastActive: run.last_active ?? null,
            status: run.end_reason ?? null,
            deliveryStatus: null,
            content: run.preview ?? null,
            readAt: null,
            id: run.id,
            profile,
            jobId: job.id,
            title: run.title ?? "Scheduled task",
            startedAt: run.started_at ?? null,
            endedAt: run.ended_at ?? null,
            active: run.is_active ?? false,
          });
      }
      // The paginated session catalog includes runs from deleted one-shot jobs
      // and conversations started by other clients. No import action is needed.
      const cursor = yield* repository.getCursor({ providerInstanceId, profile });
      let offset = 0;
      let nextWatermark = cursor.nextWatermark;
      let finished = false;
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const page = yield* dashboard
          .request({
            providerInstanceId,
            profile,
            method: "GET",
            path: "/api/sessions",
            query: { limit: 100, offset, archived: "include", order: "recent" },
          })
          .pipe(Effect.flatMap(decodeSessions));
        for (const run of page.sessions) {
          if (snapshots.has(run.id)) continue;
          snapshots.set(run.id, {
            lastActive: run.last_active ?? null,
            status: run.end_reason ?? null,
            deliveryStatus: null,
            content: run.preview ?? null,
            readAt: null,
            id: run.id,
            profile,
            jobId:
              run.source === "cron" ? (/^cron_(.+)_\d{8}_\d{6}$/u.exec(run.id)?.[1] ?? null) : null,
            title: run.title ?? "Conversation",
            startedAt: run.started_at ?? null,
            endedAt: run.ended_at ?? null,
            active: run.is_active ?? false,
          });
        }
        nextWatermark = Math.max(
          nextWatermark,
          ...page.sessions.map((session) => session.last_active ?? session.started_at ?? 0),
        );
        const reachedKnown =
          cursor.watermark > 0 &&
          page.sessions.some(
            (session) => (session.last_active ?? session.started_at ?? 0) < cursor.watermark,
          );
        offset += page.sessions.length;
        if (page.sessions.length === 0 || offset >= page.total || reachedKnown) {
          finished = true;
          break;
        }
        // Always refresh page one, then continue an interrupted backfill with
        // one page of overlap because newly active sessions shift offsets.
        if (pageIndex === 0) offset = Math.max(offset, cursor.offset - 100);
      }
      yield* repository.upsert({ providerInstanceId, runs: [...snapshots.values()], observedAt });
      yield* repository.saveCursor({
        providerInstanceId,
        profile,
        cursor: finished
          ? { watermark: nextWatermark, offset: 0, nextWatermark: 0 }
          : { watermark: cursor.watermark, offset, nextWatermark },
      });
      for (const id of yield* repository.pendingResults({ providerInstanceId, profile })) {
        const scope = { providerInstanceId, profile, id };
        yield* dashboard
          .request({
            providerInstanceId,
            profile,
            method: "GET",
            path: `/api/sessions/${encodeURIComponent(id)}/messages`,
            query: { limit: 500, order: "latest" },
          })
          .pipe(
            Effect.flatMap((result) =>
              repository.saveResult({
                ...scope,
                content: encodeResult(result),
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("hermes.work.result-unavailable", { sessionId: id, cause }),
            ),
          );
      }
    }
  });
  const sweep = Effect.fn("HermesWorkSyncService.sweep")(
    function* () {
      const { connections } = yield* dashboard.connections();
      yield* Effect.forEach(
        connections.filter((connection) => connection.configured),
        (connection) =>
          reconcile(connection.providerInstanceId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("hermes.work.reconciliation-failed", {
                providerInstanceId: connection.providerInstanceId,
                cause,
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("hermes.work.directory-unavailable", { cause })),
  );
  return HermesWorkSyncService.of({
    sweep,
    start: () =>
      sweep().pipe(
        Effect.repeat(Schedule.spaced(Duration.minutes(1))),
        Effect.forkScoped,
        Effect.asVoid,
      ),
  });
});

export const hermesWorkSyncServiceLayer = Layer.effect(
  HermesWorkSyncService,
  makeHermesWorkSyncService,
);
