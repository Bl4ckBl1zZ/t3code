import * as Duration from "effect/Duration";
import * as Stream from "effect/Stream";

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
