import type { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  HandoffCaptureError,
  HandoffSummaryCapture,
  type HandoffCaptureFailureReason,
  type HandoffSummaryCaptureShape,
} from "../Services/HandoffSummaryCapture.ts";

interface CaptureState {
  readonly deferred: Deferred.Deferred<string, HandoffCaptureError>;
  readonly buffer: string;
  readonly completedItemText: string | null;
}

const make = Effect.gen(function* () {
  const captures = yield* Ref.make(new Map<ThreadId, CaptureState>());

  const update = (threadId: ThreadId, f: (state: CaptureState) => CaptureState) =>
    Ref.update(captures, (current) => {
      const state = current.get(threadId);
      if (!state) return current;
      const next = new Map(current);
      next.set(threadId, f(state));
      return next;
    });

  /** Resolves the deferred and leaves the entry in place: `end` removes it, so
      a late runtime event after settling is swallowed rather than projected. */
  const settle = (
    threadId: ThreadId,
    result:
      | { readonly _tag: "success" }
      | { readonly _tag: "failure"; readonly error: HandoffCaptureError },
  ) =>
    Effect.gen(function* () {
      const state = (yield* Ref.get(captures)).get(threadId);
      if (!state) return;
      if (result._tag === "failure") {
        yield* Deferred.fail(state.deferred, result.error);
        return;
      }
      const summary =
        state.buffer.trim().length > 0 ? state.buffer : (state.completedItemText ?? "");
      if (summary.trim().length === 0) {
        yield* Deferred.fail(
          state.deferred,
          new HandoffCaptureError({ threadId, reason: "empty-summary" }),
        );
        return;
      }
      yield* Deferred.succeed(state.deferred, summary.trim());
    });

  const failWith = (threadId: ThreadId, reason: HandoffCaptureFailureReason, detail?: string) =>
    settle(threadId, {
      _tag: "failure",
      error: new HandoffCaptureError({
        threadId,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      }),
    });

  const begin: HandoffSummaryCaptureShape["begin"] = (threadId) =>
    Effect.gen(function* () {
      yield* failWith(threadId, "aborted", "Superseded by a newer handoff capture.");
      const deferred = yield* Deferred.make<string, HandoffCaptureError>();
      yield* Ref.update(captures, (current) => {
        const next = new Map(current);
        next.set(threadId, { deferred, buffer: "", completedItemText: null });
        return next;
      });
    });

  const isActive: HandoffSummaryCaptureShape["isActive"] = (threadId) =>
    Effect.map(Ref.get(captures), (current) => current.has(threadId));

  const awaitSummary: HandoffSummaryCaptureShape["await"] = (threadId) =>
    Effect.gen(function* () {
      const state = (yield* Ref.get(captures)).get(threadId);
      if (!state) {
        return yield* new HandoffCaptureError({ threadId, reason: "aborted" });
      }
      return yield* Deferred.await(state.deferred);
    });

  const appendAssistantText: HandoffSummaryCaptureShape["appendAssistantText"] = (
    threadId,
    delta,
  ) => update(threadId, (state) => ({ ...state, buffer: `${state.buffer}${delta}` }));

  const noteAssistantItemCompleted: HandoffSummaryCaptureShape["noteAssistantItemCompleted"] = (
    threadId,
    text,
  ) =>
    text === undefined || text.trim().length === 0
      ? Effect.void
      : update(threadId, (state) => ({ ...state, completedItemText: text }));

  const completeTurn: HandoffSummaryCaptureShape["completeTurn"] = (threadId, state) =>
    state === "completed"
      ? settle(threadId, { _tag: "success" })
      : failWith(threadId, "turn-failed", `Summary turn ended as "${state}".`);

  const fail: HandoffSummaryCaptureShape["fail"] = (threadId, reason, detail) =>
    failWith(threadId, reason, detail);

  const end: HandoffSummaryCaptureShape["end"] = (threadId) =>
    Effect.gen(function* () {
      // A capture torn down before it settled would otherwise leave the
      // reactor's await hanging until its timeout.
      yield* failWith(threadId, "aborted", "Handoff capture ended before the turn settled.");
      yield* Ref.update(captures, (current) => {
        if (!current.has(threadId)) return current;
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });
    });

  return {
    begin,
    isActive,
    await: awaitSummary,
    appendAssistantText,
    noteAssistantItemCompleted,
    completeTurn,
    fail,
    end,
  } satisfies HandoffSummaryCaptureShape;
});

export const HandoffSummaryCaptureLive = Layer.effect(HandoffSummaryCapture, make);
