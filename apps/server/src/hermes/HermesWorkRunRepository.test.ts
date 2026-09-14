import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import migration from "../persistence/Migrations/061_HermesWorkRuns.ts";
import {
  HermesWorkRunRepository,
  hermesWorkRunRepositoryLayer,
} from "./HermesWorkRunRepository.ts";

const test = it.layer(
  hermesWorkRunRepositoryLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
test("Hermes run snapshots", (it) => {
  it.effect(
    "retains native job identity and output after schedule removal and repeated reconciliation",
    () =>
      Effect.gen(function* () {
        yield* migration;
        const repository = yield* HermesWorkRunRepository;
        const scope = { providerInstanceId: "hermes", profile: "default", id: "cron_hourly_123" };
        const run = {
          status: null,
          deliveryStatus: null,
          content: null,
          readAt: null,
          id: scope.id,
          profile: scope.profile,
          jobId: "hourly",
          title: "Report",
          startedAt: 123,
          endedAt: 124,
          active: false,
        };
        yield* repository.upsert({
          providerInstanceId: scope.providerInstanceId,
          runs: [run],
          observedAt: "2026-09-14T00:00:00Z",
        });
        yield* repository.saveResult({ ...scope, content: '{"messages": ["result"]}' });
        yield* repository.markRead({ ...scope, now: "2026-09-14T00:00:01Z" });
        yield* repository.upsert({
          providerInstanceId: scope.providerInstanceId,
          runs: [{ ...run, jobId: null }],
          observedAt: "2026-09-14T00:01:00Z",
        });
        yield* repository.upsert({
          providerInstanceId: scope.providerInstanceId,
          observedAt: "2026-09-15T00:00:00Z",
          runs: Array.from({ length: 101 }, (_, index) => ({
            ...run,
            id: `new-${index}`,
            jobId: "new-job",
          })),
        });
        const exact = yield* repository.list({ ...scope, sessionId: scope.id });
        assert.strictEqual(exact.length, 1);
        assert.strictEqual(exact[0]?.jobId, "hourly");
        const runs = yield* repository.list({ ...scope, jobId: "hourly" });
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(runs[0]?.jobId, "hourly");
        assert.strictEqual(yield* repository.getResult(scope), '{"messages": ["result"]}');
        yield* repository.saveResult({ ...scope, content: '{"messages": ["updated"]}' });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ read_at: string | null }>`SELECT read_at FROM hermes_work_runs`;
        assert.strictEqual(rows[0]?.read_at, null);
      }),
  );
});
