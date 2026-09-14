import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HermesDashboardClient, type HermesDashboardRequest } from "./HermesDashboardClient.ts";
import { HermesWorkRunRepository, type HermesWorkRunSnapshot } from "./HermesWorkRunRepository.ts";
import { makeHermesWorkSyncService } from "./HermesWorkSyncService.ts";

it.effect(
  "observes external sessions and cron runs without executing jobs or duplicating runs",
  () =>
    Effect.gen(function* () {
      const calls: HermesDashboardRequest[] = [];
      const saved = new Map<string, HermesWorkRunSnapshot>();
      const dashboard = HermesDashboardClient.of({
        connection: () =>
          Effect.die("Background reconciliation does not access raw connection credentials."),
        connections: () =>
          Effect.succeed({
            connections: [{ providerInstanceId: "h", displayName: "Hermes", configured: true }],
          }),
        request: (input) =>
          Effect.sync(() => {
            calls.push(input);
            if (input.path === "/api/profiles") return { profiles: [{ name: "default" }] };
            if (input.path === "/api/cron/jobs") return [{ id: "hourly" }];
            if (input.path.endsWith("/runs"))
              return { runs: [{ id: "cron_hourly_1", title: "Report", ended_at: 123 }] };
            return {
              sessions: [
                { id: "cron_hourly_1", title: "Report", ended_at: 123 },
                { id: "external", title: "From Hermes Desktop" },
              ],
              total: 2,
            };
          }),
      });
      const repository = HermesWorkRunRepository.of({
        pendingResults: () => Effect.succeed([]),
        getCursor: () => Effect.succeed({ watermark: 0, offset: 0, nextWatermark: 0 }),
        saveCursor: () => Effect.void,
        getResult: () => Effect.succeed(null),
        saveResult: () => Effect.void,
        markRead: () => Effect.void,
        list: () => Effect.succeed([...saved.values()]),
        upsert: ({ runs }) =>
          Effect.sync(() => {
            for (const run of runs) saved.set(run.id, run);
          }),
      });
      const service = yield* makeHermesWorkSyncService.pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(HermesDashboardClient, dashboard),
            Layer.succeed(HermesWorkRunRepository, repository),
          ),
        ),
      );
      yield* service.sweep();
      yield* service.sweep();
      assert.strictEqual(saved.size, 2);
      assert.strictEqual(saved.get("cron_hourly_1")?.jobId, "hourly");
      assert.strictEqual(saved.get("external")?.title, "From Hermes Desktop");
      assert.isTrue(calls.every((call) => call.method === "GET"));
    }),
);

it.effect("bounds history reconciliation and durably continues backfill on the next sweep", () =>
  Effect.gen(function* () {
    const offsets: number[] = [];
    let cursor = { watermark: 0, offset: 0, nextWatermark: 0 };
    const dashboard = HermesDashboardClient.of({
      connection: () =>
        Effect.die("Background reconciliation does not access raw connection credentials."),
      connections: () =>
        Effect.succeed({
          connections: [{ providerInstanceId: "h", displayName: "Hermes", configured: true }],
        }),
      request: (input) =>
        Effect.sync(() => {
          if (input.path === "/api/profiles") return { profiles: [{ name: "default" }] };
          if (input.path === "/api/cron/jobs") return [];
          const offset = Number(input.query?.offset ?? 0);
          offsets.push(offset);
          return {
            sessions: Array.from({ length: 100 }, (_, i) => ({
              id: `session-${offset + i}`,
              last_active: 10_000 - offset - i,
            })),
            total: 1_000,
          };
        }),
    });
    const repository = HermesWorkRunRepository.of({
      list: () => Effect.succeed([]),
      upsert: () => Effect.void,
      getResult: () => Effect.succeed(null),
      saveResult: () => Effect.void,
      markRead: () => Effect.void,
      pendingResults: () => Effect.succeed([]),
      getCursor: () => Effect.succeed(cursor),
      saveCursor: (input) =>
        Effect.sync(() => {
          cursor = input.cursor;
        }),
    });
    const service = yield* makeHermesWorkSyncService.pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(HermesDashboardClient, dashboard),
          Layer.succeed(HermesWorkRunRepository, repository),
        ),
      ),
    );
    yield* service.sweep();
    assert.deepStrictEqual(offsets, [0, 100, 200]);
    assert.strictEqual(cursor.offset, 300);
    yield* service.sweep();
    assert.deepStrictEqual(offsets, [0, 100, 200, 0, 200, 300]);
    assert.strictEqual(cursor.offset, 400);
  }),
);
