import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  THREAD_STREAM_BACKLOG_MAX_ENCODED_BYTES,
  THREAD_STREAM_BACKLOG_MAX_EVENTS,
  THREAD_STREAM_FRAME_MAX_ITEMS,
  ThreadStreamBacklog,
  type ThreadStreamBacklogBudget,
  type ThreadStreamEventItem,
  coalesceThreadStreamFrames,
  streamThreadLiveFrames,
} from "./ThreadStreamFrames.ts";

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

function eventItem(
  sequence: number,
  type: "turn-item.updated" | "message.updated" | "run.updated",
  id: string,
  body: string,
): ThreadStreamEventItem {
  return {
    kind: "event",
    sequence,
    event: {
      id: `event-${sequence}`,
      threadId: "thread-live",
      occurredAt: "2026-06-20T00:00:00.000Z",
      type,
      payload: { id, body },
    } as unknown as OrchestrationV2DomainEvent,
  };
}

const frameBytes = (frame: ReadonlyArray<unknown>) =>
  frame.reduce<number>((total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);

describe("ThreadStreamBacklog", () => {
  it("keeps the first and latest update per entity and releases superseded bytes", () => {
    const backlog = new ThreadStreamBacklog();
    backlog.push(eventItem(1, "turn-item.updated", "a", "x".repeat(1_000)));
    backlog.push(eventItem(2, "turn-item.updated", "a", "x".repeat(2_000)));
    backlog.push(eventItem(3, "run.updated", "run", "running"));
    const withMiddle = backlog.encodedBytes;
    backlog.push(eventItem(4, "turn-item.updated", "a", "x".repeat(2_000)));

    // The first update holds the entity's place; the middle one is gone.
    expect(backlog.size).toBe(3);
    expect(backlog.encodedBytes).toBe(withMiddle);
    expect(backlog.take().map((item) => item.sequence)).toEqual([1, 3, 4]);

    // Once delivered, an entity needs only its latest update.
    backlog.push(eventItem(5, "turn-item.updated", "a", "y"));
    backlog.push(eventItem(6, "turn-item.updated", "a", "z"));
    expect(backlog.take().map((item) => item.sequence)).toEqual([6]);
  });

  it("never drops structural events", () => {
    const backlog = new ThreadStreamBacklog();
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      backlog.push(eventItem(sequence, "run.updated", "run", `status ${sequence}`));
    }
    expect(backlog.take().map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("drops the backlog for a snapshot once survivors exceed the event budget", () => {
    const backlog = new ThreadStreamBacklog({ maxEvents: 3, maxEncodedBytes: 1_000_000 });
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      backlog.push(eventItem(sequence, "turn-item.updated", `item-${sequence}`, "x"));
    }
    expect(backlog.needsSnapshot).toBe(true);
    expect(backlog.size).toBe(0);
    // Until the snapshot is taken, it covers everything that arrives.
    backlog.push(eventItem(5, "turn-item.updated", "item-5", "x"));
    expect(backlog.size).toBe(0);

    backlog.beginSnapshot();
    backlog.push(eventItem(6, "turn-item.updated", "item-6", "x"));
    backlog.push(eventItem(7, "turn-item.updated", "item-7", "x"));
    backlog.completeSnapshot(6);
    // Event 6 was already in the snapshot; event 7 was committed after it.
    expect(backlog.take().map((item) => item.sequence)).toEqual([7]);
    backlog.push(eventItem(4, "turn-item.updated", "item-4", "x"));
    expect(backlog.size).toBe(0);
  });

  it("holds a stalled client's backlog within the resume budget for a whole turn", () => {
    // A minute of a Codex turn against a client that acknowledges nothing:
    // the full answer text every 50 ms, 64 KiB of command output every
    // 500 ms, and a new command every 5 s.
    const backlog = new ThreadStreamBacklog();
    let sequence = 0;
    let peakBytes = 0;
    let peakEvents = 0;
    let answer = "";
    for (let tick = 0; tick < 1_200; tick += 1) {
      answer += "word ".repeat(4);
      backlog.push(eventItem(++sequence, "message.updated", "answer", answer));
      if (tick % 10 === 0) {
        backlog.push(
          eventItem(
            ++sequence,
            "turn-item.updated",
            `command-${Math.floor(tick / 100)}`,
            "o".repeat(64 * 1024),
          ),
        );
      }
      peakBytes = Math.max(peakBytes, backlog.encodedBytes);
      peakEvents = Math.max(peakEvents, backlog.size);
    }
    expect(backlog.needsSnapshot).toBe(true);
    expect(peakEvents).toBeLessThanOrEqual(THREAD_STREAM_BACKLOG_MAX_EVENTS);
    expect(peakBytes).toBeLessThanOrEqual(THREAD_STREAM_BACKLOG_MAX_ENCODED_BYTES);
  });

  it("drops the backlog for a snapshot once survivors exceed the byte budget", () => {
    const backlog = new ThreadStreamBacklog({ maxEvents: 128, maxEncodedBytes: 16_000 });
    backlog.push(eventItem(1, "message.updated", "a", "x".repeat(6_000)));
    // Superseding one message keeps it within budget...
    for (let sequence = 2; sequence <= 20; sequence += 1) {
      backlog.push(eventItem(sequence, "message.updated", "a", "x".repeat(6_000)));
    }
    expect(backlog.needsSnapshot).toBe(false);
    // ...a third large entity does not.
    backlog.push(eventItem(21, "message.updated", "b", "x".repeat(6_000)));
    expect(backlog.needsSnapshot).toBe(true);
  });
});

interface SimulatedSnapshot {
  readonly kind: "snapshot";
  readonly snapshotSequence: number;
  readonly state: ReadonlyMap<string, unknown>;
}

/** What a client holds after applying events: each entity's latest payload. */
function applyEvent(state: Map<string, unknown>, item: ThreadStreamEventItem) {
  const payload = item.event.payload as { readonly id: string };
  state.set(`${item.event.type}:${payload.id}`, payload);
}

/**
 * Drives `streamThreadLiveFrames` one acknowledged frame at a time, the way
 * `RpcServer` does, while the test plays the provider between frames.
 */
const makeHarness = (budget: ThreadStreamBacklogBudget) =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<ThreadStreamEventItem>();
    const server = new Map<string, unknown>();
    let head = 0;
    let snapshotLoads = 0;
    let beforeSnapshotRead: Effect.Effect<void> = Effect.void;
    const backlog = new ThreadStreamBacklog(budget);
    const client = { state: new Map<string, unknown>(), cursor: 0 };

    /** Commit events on the server and publish them to the subscriber. */
    const produce = (items: ReadonlyArray<ThreadStreamEventItem>) =>
      Effect.suspend(() => {
        for (const item of items) {
          applyEvent(server, item);
          head = item.sequence;
        }
        return Queue.offerAll(source, items);
      });

    const pull = yield* Stream.toPull(
      streamThreadLiveFrames({
        events: Stream.fromQueue(source),
        loadSnapshot: Effect.suspend(() => {
          snapshotLoads += 1;
          const before = beforeSnapshotRead;
          beforeSnapshotRead = Effect.void;
          return before.pipe(
            Effect.map(
              (): SimulatedSnapshot => ({
                kind: "snapshot",
                snapshotSequence: head,
                state: new Map(server),
              }),
            ),
          );
        }),
        frameWindow: 0,
        backlog,
      }),
    );

    /** Send one frame and apply it the way every client does. */
    const deliverFrame = pull.pipe(
      Effect.map((frame) => {
        for (const item of frame) {
          if (item.kind === "snapshot") {
            client.state = new Map(item.state);
            client.cursor = item.snapshotSequence;
            continue;
          }
          if (item.sequence <= client.cursor) continue;
          client.cursor = item.sequence;
          applyEvent(client.state, item);
        }
        return frame;
      }),
    );

    return {
      backlog,
      client,
      server,
      produce,
      deliverFrame,
      head: () => head,
      snapshotLoads: () => snapshotLoads,
      beforeSnapshotRead: (effect: Effect.Effect<void>) => {
        beforeSnapshotRead = effect;
      },
    };
  });

describe("streamThreadLiveFrames", () => {
  it.effect("sends each event straight through to a client that keeps up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ maxEvents: 4, maxEncodedBytes: 4_096 });
        for (let sequence = 1; sequence <= 50; sequence += 1) {
          yield* harness.produce([
            eventItem(sequence, "message.updated", "streaming", "x".repeat(sequence * 50)),
          ]);
          const frame = yield* harness.deliverFrame;
          expect(frame.map((item) => (item.kind === "event" ? item.sequence : -1))).toEqual([
            sequence,
          ]);
        }
        // The text outgrew the byte budget long ago, but no backlog ever did.
        expect(harness.snapshotLoads()).toBe(0);
        expect(harness.client.state).toEqual(harness.server);
      }),
    ),
  );

  it.effect("keeps a slow client's backlog bounded and converges on the final state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const budget = { maxEvents: 16, maxEncodedBytes: 48 * 1024 };
        const harness = yield* makeHarness(budget);
        let sequence = 0;
        let transcript = "";
        let produced = 0;
        let sent = 0;
        let stalls = 0;

        // A Codex-style turn: the full accumulated text every tick, growing
        // command output, a new command now and then, and run status changes.
        // The link acknowledges one frame per six ticks, and every 25th frame
        // stalls for sixty.
        for (let round = 0; round < 200; round += 1) {
          const stalled = round % 25 === 24;
          if (stalled) stalls += 1;
          const items: Array<ThreadStreamEventItem> = [];
          for (let tick = 0; tick < (stalled ? 60 : 6); tick += 1) {
            transcript += "token ";
            items.push(
              eventItem(++sequence, "message.updated", "answer", transcript.slice(-8_000)),
            );
            items.push(
              eventItem(
                ++sequence,
                "turn-item.updated",
                `command-${Math.floor(round / 10)}`,
                transcript.slice(-2_000),
              ),
            );
            if (tick % 3 === 0) {
              items.push(eventItem(++sequence, "run.updated", "run", `tick ${tick}`));
            }
          }
          produced += items.length;
          yield* harness.produce(items);

          const frame = yield* harness.deliverFrame;
          sent += frame.length;
          if (frame[0]?.kind === "event") {
            expect(frame.length).toBeLessThanOrEqual(budget.maxEvents);
            expect(frameBytes(frame)).toBeLessThanOrEqual(budget.maxEncodedBytes);
          }
        }

        // The provider stops and the client catches up.
        while (harness.client.cursor < harness.head()) {
          yield* harness.deliverFrame;
        }

        expect(harness.client.state).toEqual(harness.server);
        expect(harness.client.cursor).toBe(harness.head());
        // Each stall overflowed the budget once and was answered with one
        // snapshot instead of everything that piled up.
        expect(harness.snapshotLoads()).toBe(stalls);
        expect(sent).toBeLessThan(produced / 2);
      }),
    ),
  );

  it.effect("keeps events committed while the snapshot loads, minus those it covers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ maxEvents: 2, maxEncodedBytes: 1_000_000 });
        yield* harness.produce([
          eventItem(1, "turn-item.updated", "a", "1"),
          eventItem(2, "turn-item.updated", "b", "2"),
          eventItem(3, "turn-item.updated", "c", "3"),
        ]);
        // Event 4 commits before the snapshot is read, so the snapshot holds
        // it, but the subscriber receives it afterwards.
        harness.beforeSnapshotRead(harness.produce([eventItem(4, "turn-item.updated", "d", "4")]));
        const snapshotFrame = yield* harness.deliverFrame;
        expect(snapshotFrame.map((item) => item.kind)).toEqual(["snapshot"]);

        yield* harness.produce([eventItem(5, "turn-item.updated", "e", "5")]);
        const next = yield* harness.deliverFrame;
        expect(next.map((item) => (item.kind === "event" ? item.sequence : -1))).toEqual([5]);
        expect(harness.client.state).toEqual(harness.server);
      }),
    ),
  );

  it.effect("sends what is queued before failing with the source error", () =>
    Effect.gen(function* () {
      const frames: Array<Array<number>> = [];
      const failure = yield* streamThreadLiveFrames({
        events: Stream.make(
          eventItem(1, "turn-item.updated", "a", "1"),
          eventItem(2, "turn-item.updated", "b", "2"),
        ).pipe(Stream.concat(Stream.fail("boom" as const))),
        loadSnapshot: Effect.die("no snapshot expected"),
        frameWindow: 0,
      }).pipe(
        Stream.runForEachArray((frame) =>
          Effect.sync(() => {
            frames.push(frame.map((item) => (item.kind === "event" ? item.sequence : -1)));
          }),
        ),
        Effect.flip,
      );
      expect(frames.flat()).toEqual([1, 2]);
      expect(failure).toBe("boom");
    }),
  );
});
