import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decideThreadResume,
  readThreadResumeReplay,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./ThreadStream.ts";

describe("decideThreadResume", () => {
  it("replays when the gap is zero", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 10,
        replayEventCount: 0,
        replayEncodedBytes: 0,
      }),
    ).toEqual({ mode: "replay", afterSequence: 10, throughSequence: 10 });
  });

  it("replays when the event count is within the bound", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 20_000,
        replayEventCount: THREAD_RESUME_MAX_REPLAY_EVENTS,
        replayEncodedBytes: THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
      }),
    ).toEqual({
      mode: "replay",
      afterSequence: 10,
      throughSequence: 20_000,
    });
  });

  it("falls back to a snapshot when the event count exceeds the bound", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 20_000,
        replayEventCount: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
        replayEncodedBytes: 1,
      }),
    ).toEqual({ mode: "snapshot" });
  });

  it("falls back to a snapshot when encoded replay bytes exceed the bound", () => {
    expect(
      decideThreadResume({
        afterSequence: 10,
        highWater: 11,
        replayEventCount: 1,
        replayEncodedBytes: THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES + 1,
      }),
    ).toEqual({ mode: "snapshot" });
  });

  it("falls back to a snapshot when the client cursor is ahead of the store", () => {
    expect(
      decideThreadResume({
        afterSequence: 50,
        highWater: 40,
        replayEventCount: 0,
        replayEncodedBytes: 0,
      }),
    ).toEqual({ mode: "snapshot" });
  });

  it("counts UTF-8 bytes across projected stream items", () => {
    expect(threadReplayEncodedBytes([{ value: "a" }, { value: "🦊" }])).toBe(
      Buffer.byteLength('{"value":"a"}', "utf8") + Buffer.byteLength('{"value":"🦊"}', "utf8"),
    );
  });
});

describe("readThreadResumeReplay", () => {
  const readReplayOf =
    (items: ReadonlyArray<unknown>, calls: Array<[number, number, number]>) =>
    (afterSequence: number, throughSequence: number, limit: number) =>
      Effect.sync(() => {
        calls.push([afterSequence, throughSequence, limit]);
        return items;
      });

  it.effect("replays an idle thread however far the global sequence moved", () =>
    Effect.gen(function* () {
      const calls: Array<[number, number, number]> = [];
      const replay = yield* readThreadResumeReplay({
        afterSequence: 10,
        highWater: 836_010,
        readReplay: readReplayOf([{ sequence: 836_010 }], calls),
      });
      expect(replay).toEqual([{ sequence: 836_010 }]);
      expect(calls).toEqual([[10, 836_010, THREAD_RESUME_MAX_REPLAY_EVENTS + 1]]);
    }),
  );

  it.effect("falls back to a snapshot when the bounded read overflows the event budget", () =>
    Effect.gen(function* () {
      const items = Array.from({ length: THREAD_RESUME_MAX_REPLAY_EVENTS + 1 }, (_, sequence) => ({
        sequence,
      }));
      const replay = yield* readThreadResumeReplay({
        afterSequence: 0,
        highWater: 200,
        readReplay: readReplayOf(items, []),
      });
      expect(replay).toBeNull();
    }),
  );

  it.effect("falls back to a snapshot when a few events exceed the byte budget", () =>
    Effect.gen(function* () {
      const replay = yield* readThreadResumeReplay({
        afterSequence: 0,
        highWater: 2,
        readReplay: readReplayOf(
          [{ output: "x".repeat(THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES) }],
          [],
        ),
      });
      expect(replay).toBeNull();
    }),
  );

  it.effect("answers a cursor ahead of the store with a snapshot without reading", () =>
    Effect.gen(function* () {
      const calls: Array<[number, number, number]> = [];
      const replay = yield* readThreadResumeReplay({
        afterSequence: 50,
        highWater: 40,
        readReplay: readReplayOf([], calls),
      });
      expect(replay).toBeNull();
      expect(calls).toEqual([]);
    }),
  );
});
