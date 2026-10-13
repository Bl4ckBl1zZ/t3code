import { assert, it } from "@effect/vitest";
import type { DesktopUpdateState, DesktopUpdateStatusReport } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as DesktopAgentActivity from "./DesktopAgentActivity.ts";

function report(overrides: Partial<DesktopUpdateState>): DesktopUpdateStatusReport {
  return {
    version: 1,
    type: "desktopUpdateStatus",
    state: {
      enabled: true,
      status: "idle",
      channel: "latest",
      currentVersion: "1.0.0",
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
      availableVersion: null,
      downloadedVersion: null,
      releaseNotes: [],
      omittedReleaseCount: 0,
      downloadPercent: null,
      checkedAt: null,
      message: null,
      errorContext: null,
      canRetry: false,
      ...overrides,
    },
  };
}

const waiting = report({
  status: "downloaded",
  downloadedVersion: "1.1.0",
  autoUpdateEnabled: true,
});

it.effect("reports agent activity only while an automatic install waits", () =>
  Effect.gen(function* () {
    const reports = yield* Queue.unbounded<DesktopUpdateStatusReport>();
    const sent = yield* Queue.unbounded<boolean>();
    let reads = 0;
    let busy = true;
    const fiber = yield* DesktopAgentActivity.reportWhileWaiting({
      reports: Stream.fromQueue(reports),
      hasAgentWork: Effect.sync(() => {
        reads += 1;
        return busy;
      }),
      send: (value) => Queue.offer(sent, value),
    }).pipe(Effect.forkChild);

    // A download with the setting off asks for nothing; the first report
    // comes as soon as an automatic install starts waiting.
    yield* Queue.offer(reports, report({ status: "downloaded", autoUpdateEnabled: false }));
    yield* Queue.offer(reports, waiting);
    assert.isTrue(yield* Queue.take(sent));
    assert.equal(reads, 1);

    busy = false;
    yield* TestClock.adjust("30 seconds");
    assert.isFalse(yield* Queue.take(sent));

    // Once nothing waits (install started, setting turned off), it stops asking.
    yield* Queue.offer(reports, report({ status: "idle", autoUpdateEnabled: true }));
    yield* TestClock.adjust("2 minutes");
    yield* Queue.offer(reports, waiting);
    assert.isFalse(yield* Queue.take(sent));
    assert.equal(reads, 3);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("reports busy when the activity read fails", () =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<boolean>();
    const fiber = yield* DesktopAgentActivity.reportWhileWaiting({
      reports: Stream.concat(Stream.make(waiting), Stream.never),
      hasAgentWork: Effect.fail("database locked"),
      send: (value) => Queue.offer(sent, value),
    }).pipe(Effect.forkChild);
    assert.isTrue(yield* Queue.take(sent));
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("counts active and queued runs and lingering background commands as agent work", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const insertRun = (runId: string, ordinal: number, status: string, payload = "{}") =>
      sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${runId}, 'thread-a', ${ordinal}, 'codex', ${status}, '2026-01-01', ${payload})
      `;
    const setRunStatus = (runId: string, status: string) =>
      sql`UPDATE orchestration_v2_projection_runs SET status = ${status} WHERE run_id = ${runId}`;

    yield* insertRun("run-done", 0, "completed");
    yield* insertRun("run-held", 1, "queued", JSON.stringify({ queueHeld: true }));
    assert.isFalse(yield* DesktopAgentActivity.hasAgentWork);

    yield* insertRun("run-live", 2, "running");
    assert.isTrue(yield* DesktopAgentActivity.hasAgentWork);
    yield* setRunStatus("run-live", "waiting");
    assert.isTrue(yield* DesktopAgentActivity.hasAgentWork);
    yield* setRunStatus("run-live", "queued");
    assert.isTrue(yield* DesktopAgentActivity.hasAgentWork);
    yield* setRunStatus("run-live", "completed");
    assert.isFalse(yield* DesktopAgentActivity.hasAgentWork);

    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES ('provider-thread', 'thread-a', 'codex', 'idle', '2026-01-01',
        ${JSON.stringify({ pendingBackgroundTasks: [{ id: "task" }] })})
    `;
    assert.isTrue(yield* DesktopAgentActivity.hasAgentWork);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
