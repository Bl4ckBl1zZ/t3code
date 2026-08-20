import { CommandId, type OrchestrationV2ThreadProjection, type RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { formatDelegatedTaskWakeMessage } from "@t3tools/shared/delegatedTaskWake";

import { IdAllocatorV2 } from "./IdAllocator.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "./ProviderContinuationRequests.ts";
import { isActiveRun, ThreadManagementService } from "./ThreadManagementService.ts";

const CONTINUATION_MESSAGE_TEXT = "Background task completed.";

/** Same rendering as the orchestrator: one task keeps the singular sentence. */
function delegatedCompletionText(
  projection: OrchestrationV2ThreadProjection,
  taskIds: ReadonlyArray<string>,
): string {
  return formatDelegatedTaskWakeMessage(
    taskIds.map((taskId) => {
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      return { id: taskId, title: task?.title ?? null, status: task?.status ?? "completed" };
    }),
  );
}

/**
 * Re-reads the cohort at dispatch time. A task that finished after the offer
 * can have joined the delivery, and an acknowledged or stopped cohort must not
 * produce a turn at all.
 */
function currentDelegatedCompletionDelivery(
  projection: OrchestrationV2ThreadProjection,
  completion: NonNullable<ProviderContinuationRequest["delegatedCompletion"]>,
) {
  const sourceRun = projection.runs.find((candidate) => candidate.id === completion.parentRunId);
  const delivery = sourceRun?.delegatedCompletion?.delivery;
  const alreadyDispatched = projection.messages.some(
    (message) => message.id === completion.messageId,
  );
  if (
    sourceRun?.delegatedCompletion?.disposition !== "open" ||
    delivery === null ||
    delivery === undefined ||
    delivery.generation !== completion.generation ||
    delivery.messageId !== completion.messageId ||
    alreadyDispatched
  ) {
    return undefined;
  }
  return delivery;
}

function delegatedCompletionRetryKey(
  request: ProviderContinuationRequest,
  completion: NonNullable<ProviderContinuationRequest["delegatedCompletion"]>,
): string {
  return `${request.threadId}:${completion.parentRunId}:${completion.generation}:${completion.messageId}`;
}

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
    const retryAttempts = yield* Ref.make(new Map<string, number>());

    const clearRetryAttempt = (key: string) =>
      Ref.update(retryAttempts, (current) => {
        if (!current.has(key)) return current;
        const updated = new Map(current);
        updated.delete(key);
        return updated;
      });

    const nextRetryDelay = (key: string) =>
      Ref.modify(retryAttempts, (current) => {
        const attempt = current.get(key) ?? 0;
        const updated = new Map(current);
        updated.set(key, attempt + 1);
        return [Math.min(100 * 2 ** Math.min(attempt, 6), 5_000), updated] as const;
      });

    const dispatchContinuation = Effect.fn("ProviderContinuationService.dispatchContinuation")(
      function* (request: ProviderContinuationRequest) {
        const projection = yield* threads.getThreadProjection(request.threadId);
        if (
          projection.thread.archivedAt !== null ||
          (projection.thread.deletedAt ?? null) !== null
        ) {
          yield* Effect.logInfo("orchestration-v2.provider-continuation.thread-archived", {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
          });
          if (request.delegatedCompletion !== undefined) {
            yield* clearRetryAttempt(
              delegatedCompletionRetryKey(request, request.delegatedCompletion),
            );
          }
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
        // A cohort delivery is always its own queued run, never a steer: the
        // run is what the user can dismiss and what the orchestrator reconciles
        // against when it terminalizes.
        if (request.delegatedCompletion !== undefined) {
          const retryKey = delegatedCompletionRetryKey(request, request.delegatedCompletion);
          const delivery = currentDelegatedCompletionDelivery(
            projection,
            request.delegatedCompletion,
          );
          if (delivery === undefined) {
            yield* clearRetryAttempt(retryKey);
            return;
          }
          const commandId = yield* ids.allocate.command({
            fixtureName: "delegated-completion",
            commandName: "dispatch",
          });
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId,
            threadId: request.threadId,
            messageId: delivery.messageId,
            text: delegatedCompletionText(projection, delivery.taskIds),
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
            delegatedCompletion: {
              parentRunId: request.delegatedCompletion.parentRunId,
              generation: delivery.generation,
              taskIds: delivery.taskIds,
            },
          });
          yield* clearRetryAttempt(retryKey);
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
            Effect.gen(function* () {
              yield* Effect.logWarning("orchestration-v2.provider-continuation.dispatch-failed", {
                threadId: request.threadId,
                providerThreadId: request.providerThreadId,
                cause,
              });
              // A cohort delivery is the only announcement of a delegated
              // result, so a transient dispatch failure retries with backoff
              // until the cohort itself says it is no longer wanted.
              if (request.delegatedCompletion !== undefined) {
                const completion = request.delegatedCompletion;
                const retryKey = delegatedCompletionRetryKey(request, completion);
                const retryDelay = yield* nextRetryDelay(retryKey);
                yield* Effect.gen(function* () {
                  yield* Effect.sleep(`${retryDelay} millis`);
                  const projection = yield* threads.getThreadProjection(request.threadId);
                  if (currentDelegatedCompletionDelivery(projection, completion) !== undefined) {
                    yield* requests.offer(request);
                  } else {
                    yield* clearRetryAttempt(retryKey);
                  }
                }).pipe(
                  Effect.catchCause((retryCause) =>
                    Effect.logWarning("orchestration-v2.provider-continuation.retry-check-failed", {
                      threadId: request.threadId,
                      providerThreadId: request.providerThreadId,
                      cause: retryCause,
                    }).pipe(Effect.andThen(requests.offer(request))),
                  ),
                  Effect.forkScoped,
                );
              }
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
