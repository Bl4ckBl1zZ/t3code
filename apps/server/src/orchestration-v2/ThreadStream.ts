import * as Effect from "effect/Effect";

/** Maximum number of reducer applications allowed during a thread resume. */
export const THREAD_RESUME_MAX_REPLAY_EVENTS = 128;

/** Maximum encoded event JSON allowed during a thread resume. */
export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;

/** Encoded payload cost after events have been projected for the wire. */
export function threadReplayEncodedBytes(items: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    total += Buffer.byteLength(encoded ?? "", "utf8");
  }
  return total;
}

export type ThreadResumePlan =
  | {
      readonly mode: "replay";
      readonly afterSequence: number;
      readonly throughSequence: number;
    }
  | { readonly mode: "snapshot" };

/**
 * Decide whether a thread subscription should replay the event gap after the
 * client's cursor or send a fresh snapshot instead.
 *
 * A client cursor above the high water mark is stale or invalid. Event count
 * limits reducer churn while encoded bytes limit a small number of large
 * updates. Either excess is cheaper to replace with one current snapshot.
 */
export function decideThreadResume(input: {
  readonly afterSequence: number;
  readonly highWater: number;
  readonly replayEventCount: number;
  readonly replayEncodedBytes: number;
}): ThreadResumePlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
    input.replayEncodedBytes > THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES
  ) {
    return { mode: "snapshot" };
  }
  return {
    mode: "replay",
    afterSequence: input.afterSequence,
    throughSequence: input.highWater,
  };
}

/**
 * Read a resuming thread subscriber's catch-up, or `null` when a snapshot is
 * cheaper. Sequences are global across the event log, so the distance between
 * the cursor and the thread's high water says nothing about how many of this
 * thread's events lie between them; the bounded read (one row past the event
 * budget proves an overflow) and the byte budget decide instead.
 */
export const readThreadResumeReplay = <A, E, R>(input: {
  readonly afterSequence: number;
  readonly highWater: number;
  readonly readReplay: (
    afterSequence: number,
    throughSequence: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<A>, E, R>;
}): Effect.Effect<ReadonlyArray<A> | null, E, R> =>
  // A cursor ahead of the store (or from a rebuilt log) gets a snapshot unread.
  input.afterSequence > input.highWater
    ? Effect.succeed(null)
    : input
        .readReplay(input.afterSequence, input.highWater, THREAD_RESUME_MAX_REPLAY_EVENTS + 1)
        .pipe(
          Effect.map((replay) =>
            decideThreadResume({
              afterSequence: input.afterSequence,
              highWater: input.highWater,
              replayEventCount: replay.length,
              replayEncodedBytes: threadReplayEncodedBytes(replay),
            }).mode === "replay"
              ? replay
              : null,
          ),
        );
