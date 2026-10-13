import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { type AgentActivityRecord, canAutoInstall } from "./autoInstallPolicy.ts";

const { logInfo } = DesktopObservability.makeComponentLogger("desktop-auto-update");

/**
 * Opt-in automatic updates: downloads an available update right away and
 * installs a downloaded one once no backend reports agent work. The quit-time
 * install is handled by the updater itself (DesktopUpdates).
 */
export const listen: Effect.Effect<
  void,
  never,
  | DesktopUpdates.DesktopUpdates
  | DesktopTelemetryPublisher.DesktopTelemetryPublisher
  | DesktopBackendPool.DesktopBackendPool
  | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const activityRef = yield* Ref.make<ReadonlyMap<string, AgentActivityRecord>>(new Map());
  const evaluating = yield* Semaphore.make(1);

  const runningBackendIds = pool.list.pipe(
    Effect.flatMap((instances) =>
      Effect.filter(instances, (instance) =>
        instance.snapshot.pipe(Effect.map((snapshot) => Option.isSome(snapshot.activePid))),
      ),
    ),
    Effect.map((instances) => instances.map((instance) => instance.id)),
  );

  const evaluate = evaluating.withPermits(1)(
    Effect.gen(function* () {
      const state = yield* updates.getState;
      if (state.autoUpdateEnabled !== true) return;
      if (state.status === "available") {
        yield* logInfo("downloading update automatically", { version: state.availableVersion });
        yield* updates.download;
        return;
      }
      const install = canAutoInstall({
        state,
        runningBackendIds: yield* runningBackendIds,
        activity: yield* Ref.get(activityRef),
        nowMs: yield* Clock.currentTimeMillis,
      });
      if (!install) return;
      yield* logInfo("no agent work running; installing update automatically", {
        version: state.downloadedVersion,
      });
      yield* updates.install;
    }),
  );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const { latest, changes } = yield* updates.subscribe;
      if (latest.autoUpdateEnabled === true) yield* evaluate;
      yield* Stream.runForEach(changes, () => evaluate);
    }),
  ).pipe(Effect.forkScoped);

  yield* Stream.runForEach(publisher.agentActivity, (report) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((reportedAtMs) =>
        Ref.update(activityRef, (current) =>
          new Map(current).set(report.sourceId, { busy: report.busy, reportedAtMs }),
        ),
      ),
      Effect.andThen(evaluate),
    ),
  ).pipe(Effect.forkScoped);
});
