import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";

export class ThreadFeedbackUploadError extends Schema.TaggedErrorClass<ThreadFeedbackUploadError>()(
  "ThreadFeedbackUploadError",
  {
    reason: Schema.Literals([
      "provider-thread-missing",
      "provider-session-not-active",
      "unsupported-provider",
      "unexpected-failure",
    ]),
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider-thread-missing":
        return `Thread ${this.threadId} has no provider thread to upload.`;
      case "provider-session-not-active":
        return `Thread ${this.threadId} has no live provider session; open the thread and try again.`;
      case "unsupported-provider":
        return `The provider running thread ${this.threadId} does not support feedback uploads.`;
      case "unexpected-failure":
        return `Failed to upload thread ${this.threadId} as feedback.`;
    }
  }
}

const isThreadFeedbackUploadError = Schema.is(ThreadFeedbackUploadError);

export interface ThreadFeedbackServiceV2Shape {
  /**
   * Hand the thread's live provider session to the provider as feedback. Needs
   * a session that is still open: the upload is the running agent's own report,
   * not something the server can reconstruct from the projection.
   */
  readonly upload: (input: {
    readonly threadId: ThreadId;
    readonly reason?: string;
  }) => Effect.Effect<{ readonly feedbackId: string }, ThreadFeedbackUploadError>;
}

export class ThreadFeedbackServiceV2 extends Context.Service<
  ThreadFeedbackServiceV2,
  ThreadFeedbackServiceV2Shape
>()("t3/orchestration-v2/ThreadFeedbackService/ThreadFeedbackServiceV2") {}

export const layer: Layer.Layer<
  ThreadFeedbackServiceV2,
  never,
  ProjectionStoreV2 | ProviderSessionManagerV2
> = Layer.effect(
  ThreadFeedbackServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;

    return ThreadFeedbackServiceV2.of({
      upload: (input) =>
        Effect.gen(function* () {
          const projection = yield* projections.getThreadProjection(input.threadId);
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === projection.thread.activeProviderThreadId,
          );
          if (providerThread === undefined) {
            return yield* new ThreadFeedbackUploadError({
              reason: "provider-thread-missing",
              threadId: input.threadId,
            });
          }

          // Newest session for the thread's current provider instance, the same
          // rule the thread shell uses to report session state.
          const providerSession =
            projection.providerSessions
              .filter(
                (candidate) =>
                  candidate.providerInstanceId === projection.thread.providerInstanceId,
              )
              .toSorted(
                (left, right) =>
                  DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
              )[0] ?? null;
          if (providerSession === null) {
            return yield* new ThreadFeedbackUploadError({
              reason: "provider-session-not-active",
              threadId: input.threadId,
            });
          }

          const session = yield* sessions.get(providerSession.id);
          if (Option.isNone(session)) {
            return yield* new ThreadFeedbackUploadError({
              reason: "provider-session-not-active",
              threadId: input.threadId,
            });
          }

          const uploadFeedback = session.value.uploadFeedback;
          if (uploadFeedback === undefined) {
            return yield* new ThreadFeedbackUploadError({
              reason: "unsupported-provider",
              threadId: input.threadId,
            });
          }

          return yield* uploadFeedback({
            providerThread,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          });
        }).pipe(
          Effect.mapError((cause) =>
            isThreadFeedbackUploadError(cause)
              ? cause
              : new ThreadFeedbackUploadError({
                  reason: "unexpected-failure",
                  threadId: input.threadId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
