import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import {
  OrchestrationV2EventSupersession,
  orchestrationV2EventSupersessionKey,
} from "@t3tools/shared/orchestrationV2EventSupersession";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";

import {
  THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./ThreadStream.ts";

// The thread stream emits one item per stored event, and a streaming turn
// produces several per provider chunk. `RpcServer` sends one protocol frame
// per *stream chunk* (`Stream.runForEachArray`), so regrouping the stream into
// coarser chunks collapses a burst into a single encode and a single socket
// write per subscriber — without changing the item shape the client decodes.
// The window is around one animation frame: long enough to absorb a token
// burst, short enough to stay imperceptible.
export const THREAD_STREAM_FRAME_WINDOW = Duration.millis(16);
export const THREAD_STREAM_FRAME_MAX_ITEMS = 256;

/**
 * Regroup a stream so each emitted chunk carries up to
 * {@link THREAD_STREAM_FRAME_MAX_ITEMS} items collected over at most
 * {@link THREAD_STREAM_FRAME_WINDOW}. Item order and item shape are unchanged;
 * only the chunk boundaries — and therefore the protocol framing — differ.
 */
export function coalesceThreadStreamFrames<A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> {
  return stream.pipe(
    Stream.groupedWithin(THREAD_STREAM_FRAME_MAX_ITEMS, THREAD_STREAM_FRAME_WINDOW),
    // `groupedWithin` never emits an empty group, so the flattened batch is
    // non-empty — which `mapArray` requires but cannot infer through `flat`.
    Stream.mapArray((batches) => batches.flat() as unknown as readonly [A, ...Array<A>]),
  );
}

/**
 * A subscriber whose unsent backlog grows past the resume budget gets one
 * fresh snapshot instead: past this point a snapshot is cheaper to send and to
 * apply than the events it replaces, same as on resume.
 */
export const THREAD_STREAM_BACKLOG_MAX_EVENTS = THREAD_RESUME_MAX_REPLAY_EVENTS;
export const THREAD_STREAM_BACKLOG_MAX_ENCODED_BYTES = THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES;

export interface ThreadStreamEventItem {
  readonly kind: "event";
  readonly sequence: number;
  readonly event: OrchestrationV2DomainEvent;
}

export interface ThreadStreamSnapshotItem {
  readonly kind: "snapshot";
  readonly snapshotSequence: number;
}

export interface ThreadStreamBacklogBudget {
  readonly maxEvents: number;
  readonly maxEncodedBytes: number;
}

interface PendingEvent {
  readonly item: ThreadStreamEventItem;
  readonly bytes: number;
}

const encodedBytes = (item: ThreadStreamEventItem) =>
  Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");

/**
 * The events one subscriber has received but not yet sent. Superseded events
 * are dropped as they arrive, and once the survivors exceed the budget the
 * whole backlog is dropped in favour of a snapshot.
 */
export class ThreadStreamBacklog {
  private readonly pending = new OrchestrationV2EventSupersession<PendingEvent>((entry) =>
    orchestrationV2EventSupersessionKey(entry.item.event),
  );
  private bytes = 0;
  private overflowed = false;
  /** Events at or below this sequence are already in a snapshot sent ahead of them. */
  private floor = -1;
  private readonly budget: ThreadStreamBacklogBudget;

  constructor(
    budget: ThreadStreamBacklogBudget = {
      maxEvents: THREAD_STREAM_BACKLOG_MAX_EVENTS,
      maxEncodedBytes: THREAD_STREAM_BACKLOG_MAX_ENCODED_BYTES,
    },
  ) {
    this.budget = budget;
  }

  /** Events waiting to be sent, after supersession. */
  get size(): number {
    return this.pending.size;
  }

  get encodedBytes(): number {
    return this.bytes;
  }

  /** True when the backlog was dropped and the next frame must be a snapshot. */
  get needsSnapshot(): boolean {
    return this.overflowed;
  }

  get hasWork(): boolean {
    return this.overflowed || this.pending.size > 0;
  }

  push(item: ThreadStreamEventItem): void {
    // While a snapshot is owed, the snapshot (read later) covers every event
    // received until then.
    if (this.overflowed || item.sequence <= this.floor) return;
    const entry = { item, bytes: encodedBytes(item) };
    const dropped = this.pending.push(entry);
    this.bytes += entry.bytes - (dropped?.bytes ?? 0);
    if (this.pending.size > this.budget.maxEvents || this.bytes > this.budget.maxEncodedBytes) {
      this.pending.clear();
      this.bytes = 0;
      this.overflowed = true;
    }
  }

  /**
   * Start replacing the backlog with a snapshot. Events received while the
   * snapshot loads are kept; {@link completeSnapshot} discards the ones it
   * already contains.
   */
  beginSnapshot(): void {
    this.overflowed = false;
  }

  completeSnapshot(snapshotSequence: number): void {
    this.floor = Math.max(this.floor, snapshotSequence);
  }

  /** Remove and return the events to send next, oldest first. */
  take(): Array<ThreadStreamEventItem> {
    const items: Array<ThreadStreamEventItem> = [];
    for (const entry of this.pending.take()) {
      if (entry.item.sequence > this.floor) items.push(entry.item);
    }
    this.bytes = 0;
    return items;
  }
}

/**
 * Deliver live thread events to one subscriber at the pace it acknowledges
 * frames.
 *
 * `RpcServer` sends one chunk and waits for the client's ack before pulling
 * the next, so a link slower than the provider leaves events queued here.
 * Events are drained from the source as they are published; each pull sends
 * everything queued as one frame, with superseded full-state updates removed.
 * A backlog over budget is replaced by a single `snapshot` item from
 * `loadSnapshot`, after which delivery continues from the snapshot's
 * sequence. A client that keeps up waits one frame window after the first
 * event so a burst still goes out as one frame, and never loads a snapshot.
 */
export function streamThreadLiveFrames<S extends ThreadStreamSnapshotItem, E, R, E2, R2>(input: {
  readonly events: Stream.Stream<ThreadStreamEventItem, E, R>;
  readonly loadSnapshot: Effect.Effect<S, E2, R2>;
  readonly frameWindow?: Duration.Input;
  readonly backlog?: ThreadStreamBacklog;
}): Stream.Stream<ThreadStreamEventItem | S, E | E2, R | R2> {
  const frameWindow = Duration.fromInputUnsafe(input.frameWindow ?? THREAD_STREAM_FRAME_WINDOW);
  return Stream.unwrap(
    Effect.gen(function* () {
      const backlog = input.backlog ?? new ThreadStreamBacklog();
      const wake = Latch.makeUnsafe(false);
      // Set by the draining fiber once the source ends.
      const source: { exit: Exit.Exit<void, E> | undefined } = { exit: undefined };

      yield* Stream.runForEachArray(input.events, (items) =>
        Effect.sync(() => {
          for (const item of items) backlog.push(item);
          wake.openUnsafe();
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            source.exit = exit;
            wake.openUnsafe();
          }),
        ),
        Effect.forkScoped,
      );

      const pull: Effect.Effect<
        Arr.NonEmptyReadonlyArray<ThreadStreamEventItem | S>,
        E | E2 | Cause.Done,
        R2
      > = Effect.gen(function* () {
        while (true) {
          let waited = false;
          while (!backlog.hasWork && source.exit === undefined) {
            waited = true;
            wake.closeUnsafe();
            yield* wake.await;
          }
          // Nothing was queued when the client asked: it is keeping up, so
          // give a burst one frame window to arrive and leave together.
          if (waited && backlog.hasWork && !Duration.isZero(frameWindow)) {
            yield* Effect.sleep(frameWindow);
          }
          if (backlog.needsSnapshot) {
            backlog.beginSnapshot();
            const snapshot = yield* input.loadSnapshot;
            backlog.completeSnapshot(snapshot.snapshotSequence);
            return [snapshot] as const;
          }
          const [first, ...rest] = backlog.take();
          if (first !== undefined) return [first, ...rest] as const;
          if (source.exit !== undefined) {
            return yield* Exit.isFailure(source.exit)
              ? Effect.failCause(source.exit.cause)
              : Cause.done();
          }
        }
      });
      return Stream.fromPull(Effect.succeed(pull));
    }),
  );
}
