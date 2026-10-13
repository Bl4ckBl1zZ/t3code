import type { DesktopUpdateStatusReport } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

/** The desktop treats a report older than 75 seconds as unknown. */
export const AGENT_ACTIVITY_REPORT_INTERVAL = Duration.seconds(30);

/** True while the desktop holds a downloaded update it installs on its own. */
export function isAutomaticInstallWaiting(report: DesktopUpdateStatusReport): boolean {
  return report.state.status === "downloaded" && report.state.autoUpdateEnabled === true;
}

/**
 * Agent work a desktop restart would cut off: a run that is active or queued
 * to start, or a background command that outlived its turn.
 */
export const hasAgentWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly busy: number }>`
      SELECT (
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs
          WHERE status IN ('preparing', 'starting', 'running', 'waiting')
            OR (status = 'queued' AND CASE WHEN json_valid(payload_json)
              THEN json_extract(payload_json, '$.queueHeld') IS NOT 1
              ELSE 1 END)
        )
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_provider_threads
          WHERE CASE WHEN json_valid(payload_json)
            THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
            ELSE 0 END
        )
      ) AS busy
  `;
  return rows.some((row) => row.busy !== 0);
});

/**
 * While the desktop waits to install an update automatically, tells it every
 * 30 seconds whether agent work is running. Silent otherwise, so the query
 * only runs while someone is waiting on the answer. A failed read reports busy.
 */
export const reportWhileWaiting = <ReadError, SendError, R>(input: {
  readonly reports: Stream.Stream<DesktopUpdateStatusReport>;
  readonly hasAgentWork: Effect.Effect<boolean, ReadError, R>;
  readonly send: (busy: boolean) => Effect.Effect<void, SendError>;
}): Effect.Effect<void, never, R> =>
  input.reports.pipe(
    Stream.map(isAutomaticInstallWaiting),
    Stream.changes,
    Stream.switchMap((waiting) =>
      waiting
        ? Stream.tick(AGENT_ACTIVITY_REPORT_INTERVAL).pipe(
            Stream.mapEffect(() =>
              input.hasAgentWork.pipe(
                Effect.orElseSucceed(() => true),
                Effect.flatMap((busy) =>
                  input.send(busy).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Could not report agent activity to the desktop app", {
                        cause: String(cause),
                      }),
                    ),
                  ),
                ),
              ),
            ),
          )
        : Stream.empty,
    ),
    Stream.runDrain,
  );

/** Runs only on servers the desktop app spawned with a control channel. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.mode !== "desktop" || config.desktopTelemetryControlFd === undefined) return;
    const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const sql = yield* SqlClient.SqlClient;
    const { latest, changes } = yield* receiver.desktopUpdates;
    yield* reportWhileWaiting({
      reports: Stream.concat(Stream.fromIterable(Option.toArray(latest)), changes),
      hasAgentWork: hasAgentWork.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      send: receiver.setAgentActivity,
    }).pipe(Effect.forkScoped);
  }),
);
