import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HandoffSummaryCapture } from "../Services/HandoffSummaryCapture.ts";
import { HandoffSummaryCaptureLive } from "./HandoffSummaryCapture.ts";

const threadId = ThreadId.make("thread-1");

it.layer(HandoffSummaryCaptureLive)("HandoffSummaryCapture", (it) => {
  it.effect("is inactive until a capture begins", () =>
    Effect.gen(function* () {
      const capture = yield* HandoffSummaryCapture;
      expect(yield* capture.isActive(threadId)).toBe(false);
      yield* capture.begin(threadId);
      expect(yield* capture.isActive(threadId)).toBe(true);
      yield* capture.end(threadId);
      expect(yield* capture.isActive(threadId)).toBe(false);
    }),
  );

  it.effect("resolves with the streamed assistant text", () =>
    Effect.gen(function* () {
      const capture = yield* HandoffSummaryCapture;
      yield* capture.begin(threadId);
      yield* capture.appendAssistantText(threadId, "## Task\n");
      yield* capture.appendAssistantText(threadId, "Refactor the parser.");
      yield* capture.completeTurn(threadId, "completed");
      expect(yield* capture.await(threadId)).toBe("## Task\nRefactor the parser.");
      yield* capture.end(threadId);
    }),
  );

  it.effect("falls back to item-completed text when no deltas streamed", () =>
    Effect.gen(function* () {
      const capture = yield* HandoffSummaryCapture;
      yield* capture.begin(threadId);
      yield* capture.noteAssistantItemCompleted(threadId, "Only final text.");
      yield* capture.completeTurn(threadId, "completed");
      expect(yield* capture.await(threadId)).toBe("Only final text.");
      yield* capture.end(threadId);
    }),
  );

  it.effect("fails a turn that did not complete", () =>
    Effect.gen(function* () {
      const capture = yield* HandoffSummaryCapture;
      yield* capture.begin(threadId);
      yield* capture.appendAssistantText(threadId, "partial");
      yield* capture.completeTurn(threadId, "failed");
      const error = yield* Effect.flip(capture.await(threadId));
      expect(error.reason).toBe("turn-failed");
      yield* capture.end(threadId);
    }),
  );

  it.effect("fails when the provider opens a request instead of answering", () =>
    Effect.gen(function* () {
      const capture = yield* HandoffSummaryCapture;
      yield* capture.begin(threadId);
      yield* capture.fail(threadId, "request-opened");
      const error = yield* Effect.flip(capture.await(threadId));
      expect(error.reason).toBe("request-opened");
      yield* capture.end(threadId);
    }),
  );

  it.effect("fails an empty summary rather than handing off nothing", () =>
    Effect.gen(function* () {
      const capture = yield* HandoffSummaryCapture;
      yield* capture.begin(threadId);
      yield* capture.appendAssistantText(threadId, "   ");
      yield* capture.completeTurn(threadId, "completed");
      const error = yield* Effect.flip(capture.await(threadId));
      expect(error.reason).toBe("empty-summary");
      yield* capture.end(threadId);
    }),
  );

  it.effect("settles a capture torn down before its turn finished", () =>
    Effect.gen(function* () {
      const capture = yield* HandoffSummaryCapture;
      yield* capture.begin(threadId);
      // `end` must not leave the reactor's await hanging until its timeout.
      yield* capture.end(threadId);
      const error = yield* Effect.flip(capture.await(threadId));
      expect(error.reason).toBe("aborted");
    }),
  );
});
