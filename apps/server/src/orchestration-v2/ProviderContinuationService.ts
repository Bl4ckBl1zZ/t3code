import { CommandId, type RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { IdAllocatorV2 } from "./IdAllocator.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "./ProviderContinuationRequests.ts";
import { isActiveRun, ThreadManagementService } from "./ThreadManagementService.ts";

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

/**
 * Drains ProviderContinuationRequests and dispatches an internal
 * message.dispatch per request so the wake turn buffered by the adapter is
 * ingested as a normal run.
 *
 * Delivery mode decides how a wake meets a live parent run. An app-owned
 * message_text wake (a delegated child finishing) steers the active run so the
 * parent learns of the completion immediately instead of after its current
 * turn; when steering is impossible (no running provider turn yet, provider
 * cannot steer, or the run settled in the race) it falls back to
 * queue_after_active. An adapter_buffered wake always queues: it must open its
 * own continuation turn to drain the adapter's buffered CLI output, which
 * steering into an existing turn would never do.
 */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const ids = yield* IdAllocatorV2;
    const requests = yield* ProviderContinuationRequests;
    const threads = yield* ThreadManagementService;

    const dispatchContinuation = Effect.fn("ProviderContinuationService.dispatchContinuation")(
      function* (request: ProviderContinuationRequest) {
        const projection = yield* threads.getThreadProjection(request.threadId);
        if (projection.thread.archivedAt !== null) {
          yield* Effect.logInfo("orchestration-v2.provider-continuation.thread-archived", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
          });
          // No continuation turn will start to clear the adapter's sticky offer.
          if (request.clearIfCurrent !== undefined) {
            yield* request.clearIfCurrent();
          } else if (request.dispatchIfCurrent !== undefined) {
            // Backward compatibility for request producers without an explicit
            // drop callback.
            yield* request.dispatchIfCurrent(Effect.void);
          }
          return;
        }
        const dispatchWith = (
          dispatchMode:
            | { readonly type: "steer_active"; readonly targetRunId: RunId }
            | { readonly type: "queue_after_active" },
        ) =>
          Effect.gen(function* () {
            // The ordinal is display metadata only: allocate.message appends a
            // random UUID, so a stale projection read here cannot collide ids.
            const messageId = yield* ids.allocate.message({
              threadId: request.threadId,
              ordinal: projection.messages.length + 1,
            });
            return yield* threads.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`provider-continuation:${messageId}`),
              threadId: request.threadId,
              messageId,
              text: request.detail ?? CONTINUATION_MESSAGE_TEXT,
              attachments: [],
              dispatchMode,
              createdBy: "agent",
              // "provider" marks an adapter-buffered wake, which ClaudeAdapterV2
              // detects to attach the buffered CLI output and drop this text. A
              // message_text wake has no buffered output, so it must not carry that
              // marker or the turn settles immediately having prompted nothing.
              creationSource: request.delivery === "message_text" ? "server" : "provider",
            });
          });
        const activeRun =
          request.delivery === "message_text" ? projection.runs.find(isActiveRun) : undefined;
        const dispatch =
          activeRun === undefined
            ? dispatchWith({ type: "queue_after_active" })
            : dispatchWith({ type: "steer_active", targetRunId: activeRun.id }).pipe(
                Effect.catch((error) =>
                  Effect.logInfo("orchestration-v2.provider-continuation.steer-fallback", {
                    threadId: request.threadId,
                    targetRunId: activeRun.id,
                    error,
                  }).pipe(Effect.andThen(dispatchWith({ type: "queue_after_active" }))),
                ),
              );
        if (request.dispatchIfCurrent === undefined) {
          yield* dispatch;
          return;
        }
        yield* request.dispatchIfCurrent(dispatch);
      },
    );

    yield* requests.take.pipe(
      Effect.flatMap((request) =>
        dispatchContinuation(request).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.provider-continuation.dispatch-failed", {
              threadId: request.threadId,
              providerThreadId: request.providerThreadId,
              cause,
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
