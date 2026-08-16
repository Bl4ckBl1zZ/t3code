import {
  CommandId,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CommandReceiptStoreV2,
  type CommandReceiptV2,
  layer as commandReceiptStoreLayer,
} from "./CommandReceiptStore.ts";
import {
  EffectOutboxV2,
  type OrchestrationEffectRequestV2,
  type PendingOrchestrationEffectV2,
  layer as effectOutboxLayer,
} from "./EffectOutbox.ts";
import { EventStoreV2 } from "./EventStore.ts";
import {
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  ProjectionStoreV2,
} from "./ProjectionStore.ts";
import {
  TurnItemPositionStoreV2,
  layer as turnItemPositionStoreLayer,
} from "./TurnItemPositionStore.ts";

/**
 * ERRORS
 */
export class EventSinkWriteError extends Schema.TaggedErrorClass<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedErrorClass<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

/**
 * SERVICE DEFINITION
 */
export interface EventSinkV2Shape {
  /**
   * Append events and apply them to the projection.
   *
   * Writes are group-committed on a background fiber, so the transaction runs
   * on a different fiber than the caller: do NOT call this from inside a
   * `sql.withTransaction` block. The caller would hold the transaction while
   * waiting for a second one to commit on the sink's fiber, which the
   * synchronous SQLite driver cannot service concurrently. Use
   * {@link EventSinkV2Shape.commitCommand} when the write has to participate
   * in surrounding transactional work.
   */
  readonly write: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

/**
 * IMPLEMENTATIONS
 */
const baseLayer: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStoreV2
  | EffectOutboxV2
  | EventStoreV2
  | ProjectionStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutboxV2;
    const eventStore = yield* EventStoreV2;
    const projectionStore = yield* ProjectionStoreV2;
    const turnItemPositions = yield* TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          event.type === "turn-item.updated"
            ? turnItemPositions
                .normalize(
                  event.payload,
                  event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                )
                .pipe(Effect.map((payload) => ({ ...event, payload })))
            : Effect.succeed(event),
        { concurrency: 1 },
      );
    };

    const applyProjectionEvents = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
        concurrency: 1,
      });

    const recordProjectionSequence = (sequence: number) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
      });

    const applyStoredEvents = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.gen(function* () {
        yield* applyProjectionEvents(storedEvents);
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          yield* recordProjectionSequence(sequence);
        }
      });

    type WriteInput = Parameters<EventSinkV2Shape["writeWithEffects"]>[0];
    interface PendingWrite {
      readonly input: WriteInput;
      readonly deferred: Deferred.Deferred<
        ReadonlyArray<OrchestrationV2StoredEvent>,
        EventSinkWriteError
      >;
    }

    const pendingWrites = yield* Queue.unbounded<PendingWrite>();

    const writeError = (input: WriteInput, cause: unknown) =>
      new EventSinkWriteError({
        eventCount: input.events.length,
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        cause,
      });

    /**
     * Commit a batch of queued writes in one transaction.
     *
     * Each write keeps its own `append` call so per-request command ids and
     * stored-event slices stay intact; only the surrounding transaction (and
     * therefore the WAL write) is shared. The projection metadata row is
     * written once per batch because only the highest sequence is meaningful
     * and every write would otherwise rewrite the same row.
     */
    const runBatchTransaction = (batch: ReadonlyArray<PendingWrite>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const committed: Array<ReadonlyArray<OrchestrationV2StoredEvent>> = [];
          for (const pending of batch) {
            const normalized = yield* normalizeEvents(pending.input.events);
            const stored = yield* eventStore.append({
              ...(pending.input.commandId === undefined
                ? {}
                : { commandId: pending.input.commandId }),
              events: normalized,
            });
            yield* applyProjectionEvents(stored);
            yield* effectOutbox.enqueue(pending.input.effects);
            committed.push(stored);
          }
          const sequence = committed.at(-1)?.at(-1)?.sequence;
          if (sequence !== undefined) {
            yield* recordProjectionSequence(sequence);
          }
          return committed;
        }),
      );

    const settleCommittedBatch = (
      batch: ReadonlyArray<PendingWrite>,
      committed: ReadonlyArray<ReadonlyArray<OrchestrationV2StoredEvent>>,
    ) =>
      Effect.gen(function* () {
        const effectCount = batch.reduce(
          (total, pending) => total + pending.input.effects.length,
          0,
        );
        if (effectCount > 0) {
          yield* effectOutbox.notifyAvailable(effectCount);
        }
        // Publish only after the transaction commits so a subscriber never
        // observes an event that a rolled-back batch never durably stored.
        for (const [index, pending] of batch.entries()) {
          const stored = committed[index] ?? [];
          yield* eventStore.publishCommitted(stored);
          yield* PubSub.publishAll(liveEvents, stored);
          yield* Deferred.succeed(pending.deferred, stored);
        }
      });

    // Settling an already-settled deferred is a no-op, so this is safe to call
    // over a batch that partially succeeded.
    const failPendingWrites = (batch: ReadonlyArray<PendingWrite>, cause: unknown) =>
      Effect.forEach(
        batch,
        (pending) => Deferred.fail(pending.deferred, writeError(pending.input, cause)),
        { discard: true },
      );

    const flushWriteBatch: (batch: ReadonlyArray<PendingWrite>) => Effect.Effect<void> = Effect.fn(
      "orchestrationV2.EventSink.flushWriteBatch",
    )(function* (batch: ReadonlyArray<PendingWrite>) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.batch_size": batch.length,
        "orchestration_v2.event_count": batch.reduce(
          (total, pending) => total + pending.input.events.length,
          0,
        ),
      });

      const outcome = yield* Effect.exit(runBatchTransaction(batch));
      if (Exit.isSuccess(outcome)) {
        yield* settleCommittedBatch(batch, outcome.value);
        return;
      }
      if (batch.length === 1) {
        yield* failPendingWrites(batch, Cause.squash(outcome.cause));
        return;
      }
      // A batch commits atomically, so one bad write — a duplicate event id,
      // say — would otherwise fail unrelated writes that merely happened to be
      // queued alongside it. Failures are rare, so re-commit the batch one
      // write at a time: only the write that actually fails reports an error,
      // which is the isolation callers had before group commit.
      yield* Effect.forEach(batch, (pending) => flushWriteBatch([pending]), {
        discard: true,
        concurrency: 1,
      });
    });

    // Group commit. Provider ingestion writes once per streamed event, and a
    // transaction per event (each forcing its own WAL write) dominated the
    // cost of a running turn. `takeAll` blocks until the queue is non-empty
    // and then drains it, so batching tracks the arrival rate on its own: an
    // idle server commits a lone write immediately, while writes that arrive
    // during an in-flight transaction fold into the next one. No delay to
    // tune, and no added latency when nothing else is pending.
    yield* Queue.takeAll(pendingWrites).pipe(
      Effect.flatMap((batch) =>
        // Nothing may escape this loop: a dead flush fiber would leave every
        // future write parked on a deferred that can never resolve, wedging
        // the whole write path. Settle the batch and keep going.
        flushWriteBatch(batch).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("orchestration-v2.event-sink.flush-failed", {
              batchSize: batch.length,
              cause,
            }).pipe(Effect.andThen(failPendingWrites(batch, Cause.squash(cause)))),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (input: WriteInput) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const deferred = yield* Deferred.make<
        ReadonlyArray<OrchestrationV2StoredEvent>,
        EventSinkWriteError
      >();
      yield* Queue.offer(pendingWrites, { input, deferred });
      return yield* Deferred.await(deferred);
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* normalizeEvents(input.events);
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            yield* applyStoredEvents(storedEvents);
            return { committed: true as const, storedEvents };
          }),
        );
        if (result.committed) {
          yield* eventStore.publishCommitted(result.storedEvents);
          yield* PubSub.publishAll(liveEvents, result.storedEvents);
        }
        return result;
      },
    );

    const existingCommandResult = (commandId: CommandId) =>
      Effect.gen(function* () {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }

          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          const sequence = storedEvents.at(-1)?.sequence;
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          yield* applyStoredEvents(storedEvents);
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, committed: true as const, cancelledEffectIds };
        }),
      );
      yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
      if (result.committed && input.effects.length > 0) {
        yield* effectOutbox.notifyAvailable(input.effects.length);
      }
      if (result.committed) {
        yield* eventStore.publishCommitted(result.storedEvents);
        yield* PubSub.publishAll(liveEvents, result.storedEvents);
      }
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: { readonly threadId?: ThreadId; readonly afterSequence?: number }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe first, then capture the database high-water mark. Events
          // committed between those operations are buffered by the subscription.
          const subscription = yield* PubSub.subscribe(liveEvents);
          const highWater = yield* eventStore.latestSequence();
          const afterSequence = input?.afterSequence ?? 0;
          const replay = catchUp({
            afterSequence,
            throughSequence: highWater,
            ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          });
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(
              (stored) => input?.threadId === undefined || stored.event.threadId === input.threadId,
            ),
          );
          return Stream.concat(replay, live);
        }),
      );

    return EventSinkV2.of({
      // `writeEffect` already fails with `EventSinkWriteError`: the batch that
      // committed the write owns the error mapping so each queued caller gets
      // its own event count and command id back.
      write: (input) => writeEffect({ ...input, effects: [] }),
      writeWithEffects: (input) => writeEffect(input),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/**
 * Event sink layer for application compositions that already own the
 * persistence services. Keeping the outbox instance shared with the worker is
 * important because enqueue notifications are in-memory wakeups backed by the
 * durable SQL queue.
 */
export const layerFromStores = baseLayer;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStoreV2 | ProjectionStoreV2 | SqlClient.SqlClient
> = baseLayer.pipe(
  Layer.provide(
    Layer.mergeAll(commandReceiptStoreLayer, effectOutboxLayer, turnItemPositionStoreLayer),
  ),
);
