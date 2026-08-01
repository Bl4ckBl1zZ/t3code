/**
 * HandoffSummaryCapture - Diverts one provider turn away from the timeline.
 *
 * During a cross-provider handoff the reactor sends a summarization prompt to
 * the outgoing session. That turn is machinery, not conversation: its deltas
 * must not become assistant messages and its lifecycle must not churn the
 * thread's session state. While a capture is active for a thread,
 * ProviderRuntimeIngestion routes the thread's runtime events here instead of
 * dispatching orchestration commands.
 *
 * Capture is keyed by threadId rather than turnId because runtime events can
 * arrive before `sendTurn` returns the provider's turn id. The decider
 * guarantees no other turn is running when a handoff starts, so the thread key
 * is unambiguous.
 *
 * @module HandoffSummaryCapture
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/** Why a capture ended without a usable summary. */
export type HandoffCaptureFailureReason =
  | "turn-failed"
  | "session-exited"
  | "runtime-error"
  | "request-opened"
  | "empty-summary"
  | "aborted";

export class HandoffCaptureError extends Data.TaggedError("HandoffCaptureError")<{
  readonly threadId: ThreadId;
  readonly reason: HandoffCaptureFailureReason;
  readonly detail?: string;
}> {}

export interface HandoffSummaryCaptureShape {
  /**
   * Start capturing for a thread. Returns the effect that resolves with the
   * captured summary text (or fails) once the turn settles. Beginning a
   * capture while one is already active for the thread aborts the previous
   * one.
   */
  readonly begin: (threadId: ThreadId) => Effect.Effect<void>;

  /** Whether ingestion should divert this thread's runtime events. */
  readonly isActive: (threadId: ThreadId) => Effect.Effect<boolean>;

  /** Blocks until the captured turn settles. */
  readonly await: (threadId: ThreadId) => Effect.Effect<string, HandoffCaptureError>;

  /** Streamed assistant text for the captured turn. */
  readonly appendAssistantText: (threadId: ThreadId, delta: string) => Effect.Effect<void>;

  /**
   * Final assistant text delivered on item completion. Some providers emit
   * only this and never stream deltas, so it is kept as a fallback.
   */
  readonly noteAssistantItemCompleted: (
    threadId: ThreadId,
    text: string | undefined,
  ) => Effect.Effect<void>;

  /** Settle the capture from a turn.completed runtime event. */
  readonly completeTurn: (
    threadId: ThreadId,
    state: "completed" | "failed" | "interrupted" | "cancelled",
  ) => Effect.Effect<void>;

  /** Settle the capture as failed. */
  readonly fail: (
    threadId: ThreadId,
    reason: HandoffCaptureFailureReason,
    detail?: string,
  ) => Effect.Effect<void>;

  /**
   * Stop diverting events for the thread. Safe to call more than once; always
   * run this in an `ensuring` so a crashed handoff cannot leave a thread's
   * runtime events permanently swallowed.
   */
  readonly end: (threadId: ThreadId) => Effect.Effect<void>;
}

export class HandoffSummaryCapture extends Context.Service<
  HandoffSummaryCapture,
  HandoffSummaryCaptureShape
>()("t3/orchestration/Services/HandoffSummaryCapture") {}
