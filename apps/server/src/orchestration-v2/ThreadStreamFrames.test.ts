import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { THREAD_STREAM_FRAME_MAX_ITEMS, coalesceThreadStreamFrames } from "./ThreadStreamFrames.ts";

/** Collect the chunk boundaries the stream emits, not just its items. */
function collectFrames<A>(stream: Stream.Stream<A>): Effect.Effect<Array<Array<A>>> {
  return Effect.gen(function* () {
    const frames: Array<Array<A>> = [];
    yield* Stream.runForEachArray(stream, (values) =>
      Effect.sync(() => {
        frames.push(Array.from(values));
      }),
    );
    return frames;
  });
}

describe("coalesceThreadStreamFrames", () => {
  it.effect("preserves item order and content", () =>
    Effect.gen(function* () {
      const items = Array.from({ length: 1_000 }, (_, index) => index);
      const result = yield* Stream.fromIterable(items).pipe(
        coalesceThreadStreamFrames,
        Stream.runCollect,
      );
      expect(Array.from(result)).toEqual(items);
    }),
  );

  it.effect("folds a burst into far fewer frames than items", () =>
    Effect.gen(function* () {
      // One event per provider chunk is what makes the unbatched stream
      // expensive: every frame is a separate encode and socket write per
      // subscriber. Coalescing must cut the frame count by orders of
      // magnitude, not merely shave it.
      const items = Array.from({ length: 1_000 }, (_, index) => index);
      const frames = yield* collectFrames(
        Stream.fromIterable(items).pipe(coalesceThreadStreamFrames),
      );

      expect(frames.flat()).toEqual(items);
      expect(frames.length).toBeLessThanOrEqual(
        Math.ceil(items.length / THREAD_STREAM_FRAME_MAX_ITEMS),
      );
      for (const frame of frames) {
        expect(frame.length).toBeGreaterThan(0);
        expect(frame.length).toBeLessThanOrEqual(THREAD_STREAM_FRAME_MAX_ITEMS);
      }
    }),
  );

  it.effect("emits a lone item as its own frame rather than withholding it", () =>
    Effect.gen(function* () {
      const frames = yield* collectFrames(Stream.make("only").pipe(coalesceThreadStreamFrames));
      expect(frames).toEqual([["only"]]);
    }),
  );

  it.effect("propagates the source error after draining buffered items", () =>
    Effect.gen(function* () {
      const failure = yield* Stream.make(1, 2, 3).pipe(
        Stream.concat(Stream.fail("boom" as const)),
        coalesceThreadStreamFrames,
        Stream.runCollect,
        Effect.flip,
      );
      expect(failure).toBe("boom");
    }),
  );
});
