import { CommandId, MessageId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import {
  canContinueAfterRestart,
  RESTART_CONTINUATION_PROMPT,
} from "./RestartContinuationPolicy.ts";

export interface RestartContinuationMarker {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
}
export class RestartContinuationError extends Schema.TaggedErrorClass<RestartContinuationError>()(
  "RestartContinuationError",
  {
    cause: Schema.Defect(),
  },
) {}
export class RestartContinuationService extends Context.Service<
  RestartContinuationService,
  {
    readonly prepare: (
      reason: "restart" | "update",
    ) => Effect.Effect<ReadonlyArray<RestartContinuationMarker>, RestartContinuationError>;
    readonly clear: (
      markers: ReadonlyArray<RestartContinuationMarker>,
    ) => Effect.Effect<void, RestartContinuationError>;
    readonly resume: Effect.Effect<void>;
    readonly awaitInitialResume: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/RestartContinuationService") {}

export const make = Effect.gen(function* () {
  const initialResume = yield* Deferred.make<void>();
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService;
  const settings = yield* ServerSettingsService;
  const clear = (markers: ReadonlyArray<RestartContinuationMarker>) =>
    Effect.forEach(
      markers,
      (marker) =>
        threads.dispatch({
          type: "run.restart-continuation.clear",
          ...marker,
          commandId: CommandId.make(`restart-clear:${marker.messageId}`),
        }),
      { discard: true },
    ).pipe(Effect.mapError((cause) => new RestartContinuationError({ cause })));
  const prepare = Effect.fn("RestartContinuation.prepare")(
    function* (reason: "restart" | "update") {
      if (reason === "restart" && !(yield* settings.getSettings).continueThreadsAfterServerUpdate)
        return [];
      const markers: RestartContinuationMarker[] = [];
      yield* Effect.gen(function* () {
        const snapshot = yield* threads.getShellSnapshot({ location: "active" });
        for (const shell of snapshot.threads) {
          if (shell.archivedAt !== null || shell.deletedAt !== null || shell.status !== "running")
            continue;
          const projection = yield* threads.getThreadProjection(shell.id);
          const run = projection.runs.find((candidate) =>
            canContinueAfterRestart(projection, candidate, "prepare"),
          );
          if (run === undefined || run.restartContinuation?.status === "pending") continue;
          const marker = {
            threadId: shell.id,
            runId: run.id,
            messageId: MessageId.make(`restart-continuation:${yield* crypto.randomUUIDv4}`),
          };
          yield* threads.dispatch({
            type: "run.restart-continuation.prepare",
            ...marker,
            reason,
            commandId: CommandId.make(`restart-prepare:${marker.messageId}`),
          });
          markers.push(marker);
        }
      }).pipe(
        Effect.catchCause((cause) => clear(markers).pipe(Effect.andThen(Effect.failCause(cause)))),
      );
      return markers;
    },
    Effect.mapError((cause) => new RestartContinuationError({ cause })),
  );
  const resume = Effect.gen(function* () {
    const enabled = (yield* settings.getSettings).continueThreadsAfterServerUpdate;
    const snapshot = yield* threads.getShellSnapshot();
    yield* Effect.forEach(
      [...snapshot.threads, ...snapshot.archivedThreads],
      (shell) =>
        Effect.gen(function* () {
          const projection = yield* threads.getThreadProjection(shell.id);
          for (const run of projection.runs) {
            if (run.restartContinuation?.status !== "pending") continue;
            const marker = {
              threadId: shell.id,
              runId: run.id,
              messageId: run.restartContinuation.messageId,
            };
            if (
              (!enabled && run.restartContinuation.reason !== "update") ||
              !canContinueAfterRestart(projection, run, "resume")
            ) {
              yield* clear([marker]);
              continue;
            }
            yield* threads
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`restart-dispatch:${marker.messageId}`),
                threadId: shell.id,
                messageId: marker.messageId,
                text: RESTART_CONTINUATION_PROMPT,
                attachments: [],
                createdBy: "agent",
                creationSource: "server",
                restartContinuation: { sourceRunId: run.id },
                dispatchMode: { type: "start_immediately" },
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : clear([marker]).pipe(
                        Effect.andThen(
                          Effect.logWarning("restart continuation skipped", {
                            threadId: shell.id,
                            cause: Cause.pretty(cause),
                          }),
                        ),
                      ),
                ),
              );
          }
        }),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("restart continuation failed", { cause: Cause.pretty(cause) }),
    ),
  );
  return {
    prepare,
    clear,
    resume: resume.pipe(Effect.ensuring(Deferred.succeed(initialResume, undefined))),
    awaitInitialResume: Deferred.await(initialResume),
  } satisfies RestartContinuationService["Service"];
});
export const layer = Layer.effect(RestartContinuationService, make);
