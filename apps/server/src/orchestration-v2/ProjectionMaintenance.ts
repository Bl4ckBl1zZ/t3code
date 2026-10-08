import { type OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventStoreV2 } from "./EventStore.ts";
import {
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  ProjectionStoreV2,
} from "./ProjectionStore.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedErrorClass<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly compactEventStore: (options?: {
    /** History window for thread-state and legacy v1 rows. */
    readonly retainNewerThan?: Duration.Duration;
    /**
     * Window for superseded streaming snapshots (turn items, messages, nodes).
     * Defaults to the shorter of an hour and `retainNewerThan`.
     */
    readonly retainSnapshotsNewerThan?: Duration.Duration;
  }) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      /** Bytes returned to the filesystem by incremental vacuum. */
      readonly reclaimedBytes: number;
      /** Free pages left inside the file; only an offline VACUUM returns them. */
      readonly reclaimableBytes: number;
      readonly retentionCutoff: string | null;
    },
    ProjectionMaintenanceError
  >;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStoreV2 | ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStoreV2;
    const projectionStore = yield* ProjectionStoreV2;

    const readAllEvents = Effect.gen(function* () {
      const events: Array<OrchestrationV2StoredEvent> = [];
      const pageSize = 500;
      let afterSequence = 0;
      while (true) {
        const page = yield* eventStore.read({ afterSequence, limit: pageSize }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
        events.push(...page);
        if (page.length < pageSize) {
          break;
        }
        afterSequence = page.at(-1)?.sequence ?? afterSequence;
      }
      return events;
    });

    /**
     * EventSink commits the event, its projection updates, and projection metadata in one SQL
     * transaction. Startup verification therefore checks that transaction boundary and that every
     * stored projection can be decoded. It intentionally does not replay domain events through a
     * second projector: doing so creates another implementation of projection semantics that must
     * evolve in lockstep with ProjectionStore.
     */
    const verify = Effect.gen(function* () {
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const projectionRows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id ASC
      `;
      const actualIds = projectionRows.map((row) => ThreadId.make(row.thread_id));
      const expectedIds = expectedThreadRows.map((row) => ThreadId.make(row.thread_id));
      const actualSet = new Set(actualIds);
      const expectedSet = new Set(expectedIds);
      const missingThreadIds = expectedIds.filter((threadId) => !actualSet.has(threadId));
      const unexpectedThreadIds = actualIds.filter((threadId) => !expectedSet.has(threadId));
      const unreadableThreadIds = (yield* Effect.forEach(
        actualIds,
        (threadId) =>
          projectionStore.getThreadProjection(threadId).pipe(
            Effect.as<ThreadId | null>(null),
            Effect.orElseSucceed((): ThreadId | null => threadId),
          ),
        { concurrency: 8 },
      )).filter((threadId): threadId is ThreadId => threadId !== null);
      const metadata = yield* sql<ProjectionMetadataRow>`
        SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
        LIMIT 1
      `;
      const expectedSequence = yield* eventStore.latestSequence();
      const schemaVersion = metadata[0]?.schema_version ?? 0;
      const projectionSequence = metadata[0]?.last_sequence ?? 0;
      return {
        valid:
          schemaVersion === ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
          projectionSequence === expectedSequence &&
          missingThreadIds.length === 0 &&
          unexpectedThreadIds.length === 0 &&
          unreadableThreadIds.length === 0,
        schemaVersion,
        expectedSequence,
        projectionSequence,
        unreadableThreadIds,
        missingThreadIds,
        unexpectedThreadIds,
      } satisfies ProjectionVerificationV2;
    });

    const rebuild = Effect.gen(function* () {
      const events = yield* readAllEvents;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers`;
          yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoints`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes`;
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          yield* sql`DELETE FROM orchestration_v2_projection_plans`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          for (const stored of events) {
            yield* projectionStore.apply(stored.event);
            if (stored.event.type === "turn-item.updated") {
              yield* sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${stored.event.threadId},
                  ${stored.event.payload.id},
                  ${stored.event.payload.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
                  ordinal = excluded.ordinal
              `;
            }
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const lastSequence = events.at(-1)?.sequence ?? 0;
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
              ${lastSequence},
              ${now}
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }),
      );
      return yield* verify;
    });

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    // Thread-state events whose payload is the complete thread: only the
    // newest per thread can influence a replay or an afterSequence catch-up.
    // thread.created stays out — verify derives the expected thread set from
    // it, and it anchors replay ordering.
    const THREAD_STATE_EVENT_TYPES = sql.literal(`(
      'thread.archived',
      'thread.unarchived',
      'thread.deleted',
      'thread.settled',
      'thread.unsettled',
      'thread.snoozed',
      'thread.unsnoozed',
      'thread.metadata-updated',
      'thread.runtime-mode-updated',
      'thread.interaction-mode-updated',
      'thread.model-selection-updated',
      'thread.provider-switched',
      'thread.visited',
      'thread.marked-unread'
    )`);

    // Full-state entity snapshots. A streaming item is rewritten many times
    // (Codex flushes assistant text every 50ms, command output every 500ms),
    // each row carrying everything so far, so storage grows with the square of
    // an item's length. Every projection applies these as a plain upsert of
    // the payload, which is what makes all but the newest version dead weight.
    // subagent.updated is not here: its projection carries completionDelivery
    // forward from earlier versions.
    const ENTITY_SNAPSHOT_EVENT_TYPES = sql.literal(
      `('turn-item.updated', 'message.updated', 'node.updated')`,
    );

    // Both lists together, exactly as migration 067's partial index spells
    // them. SQLite only uses a partial index for a query that repeats its WHERE
    // terms; bound parameters or a subset of the list would not match. Version
    // lookups carry this term plus their own list.
    const VERSIONED_EVENT_TYPES = sql.literal(`(
      'turn-item.updated',
      'message.updated',
      'node.updated',
      'thread.archived',
      'thread.unarchived',
      'thread.deleted',
      'thread.settled',
      'thread.unsettled',
      'thread.snoozed',
      'thread.unsnoozed',
      'thread.metadata-updated',
      'thread.runtime-mode-updated',
      'thread.interaction-mode-updated',
      'thread.model-selection-updated',
      'thread.provider-switched',
      'thread.visited',
      'thread.marked-unread'
    )`);

    // The sqlite driver is synchronous, so a statement blocks every client for
    // its whole duration. Each pass walks the log in sequence ranges of this
    // size, one short transaction per range, yielding to the event loop in
    // between. On a 6.6 GB store the 112k-row first-run backlog took 14s with
    // no statement over 35ms and no event-loop stall over 60ms (warm cache).
    const COMPACTION_CHUNK_SEQUENCES = 500;
    // Legacy rows and receipts are deleted at most this many per statement.
    const COMPACTION_DELETE_BATCH_SIZE = 500;

    // Recent history stays whole, duplicates and all: when something is
    // reported the events behind it are usually hours old, and a store that
    // has already collapsed them cannot answer what actually happened. Only
    // material older than this window is eligible for the history passes.
    const COMPACTION_RETENTION_WINDOW = Duration.days(7);
    // Superseded streaming snapshots are the exception: each is a prefix of the
    // version after it, so keeping them for the full window is what made the
    // store grow quadratically. An hour outlasts any resume or catch-up that
    // could still be reading them.
    const SNAPSHOT_RETENTION_WINDOW = Duration.hours(1);
    // Pages handed back to the filesystem per incremental_vacuum statement:
    // 8 MiB, ~35ms on a 5.7 GB store.
    const INCREMENTAL_VACUUM_STEP_PAGES = 2_048;

    const chunksOf = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
      const out: Array<ReadonlyArray<A>> = [];
      for (let index = 0; index < items.length; index += size) {
        out.push(items.slice(index, index + size));
      }
      return out;
    };

    const cutoffFor = (retainNewerThan: Duration.Duration) =>
      Effect.map(DateTime.now, (now) =>
        Duration.isZero(retainNewerThan)
          ? null
          : DateTime.formatIso(DateTime.subtractDuration(now, retainNewerThan)),
      );

    const readCursor = (pass: string) =>
      sql<{ readonly through_sequence: number }>`
        SELECT through_sequence
        FROM orchestration_event_compaction_cursors
        WHERE pass = ${pass}
      `.pipe(Effect.map((rows) => rows[0]?.through_sequence ?? 0));

    const writeCursor = (pass: string, throughSequence: number) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO orchestration_event_compaction_cursors (pass, through_sequence, updated_at)
          VALUES (${pass}, ${throughSequence}, ${now})
          ON CONFLICT(pass) DO UPDATE SET
            through_sequence = excluded.through_sequence,
            updated_at = excluded.updated_at
        `;
      });

    /**
     * Walk the event log from the pass's cursor to `highWater` in sequence
     * ranges, stopping at the first event newer than `cutoff`. Each range
     * selects its superseded rows, deletes them, and advances the cursor in one
     * transaction, so a crash leaves the cursor exactly where deletion stopped.
     *
     * Passes are driven by the newer version: a range deletes the older
     * versions of every entity it touches. A superseded row is therefore
     * deleted once its successor ages out, wherever the row itself sits, and
     * the cursor never has to revisit old ranges.
     *
     * Every read pins its access path (NOT INDEXED keeps the rowid range,
     * INDEXED BY the version lookups). Left to itself the planner preferred
     * walking a whole index over the bounded range, with or without
     * statistics — exactly the multi-second statements this replaces.
     */
    const walkRanges = (input: {
      readonly pass: string;
      readonly cutoff: string | null;
      readonly highWater: number;
      readonly supersededInRange: (range: {
        readonly afterSequence: number;
        readonly throughSequence: number;
      }) => Effect.Effect<ReadonlyArray<{ readonly sequence: number }>, unknown>;
    }) =>
      Effect.gen(function* () {
        let afterSequence = yield* readCursor(input.pass);
        let deleted = 0;
        while (afterSequence < input.highWater) {
          let throughSequence = Math.min(
            afterSequence + COMPACTION_CHUNK_SEQUENCES,
            input.highWater,
          );
          let reachedCutoff = false;
          if (input.cutoff !== null) {
            // A rowid range read of a few leading columns; payloads stay unread.
            const recent = yield* sql<{ readonly sequence: number | null }>`
              SELECT MIN(sequence) AS sequence
              FROM orchestration_events NOT INDEXED
              WHERE sequence > ${afterSequence}
                AND sequence <= ${throughSequence}
                AND occurred_at >= ${input.cutoff}
            `;
            const firstRecent = recent[0]?.sequence ?? null;
            if (firstRecent !== null) {
              throughSequence = firstRecent - 1;
              reachedCutoff = true;
            }
          }
          if (throughSequence > afterSequence) {
            const range = { afterSequence, throughSequence };
            deleted += yield* sql.withTransaction(
              Effect.gen(function* () {
                const superseded = yield* input.supersededInRange(range);
                yield* deleteEvents(superseded.map((row) => row.sequence));
                yield* writeCursor(input.pass, range.throughSequence);
                return superseded.length;
              }),
            );
            afterSequence = throughSequence;
          }
          yield* Effect.yieldNow;
          if (reachedCutoff) break;
        }
        return deleted;
      });

    const deleteEvents = (sequences: ReadonlyArray<number>) =>
      Effect.forEach(
        chunksOf(sequences, COMPACTION_DELETE_BATCH_SIZE),
        (batch) => sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(batch)}`,
        { discard: true },
      );

    // Every superseded thread-state event of each thread the range touches.
    // A thread payload's id is the thread id, so the same index finds them.
    const supersededThreadStateInRange = (range: {
      readonly afterSequence: number;
      readonly throughSequence: number;
    }) => sql<{ readonly sequence: number }>`
      WITH latest AS (
        -- The payload id rather than stream_id (they are equal) keeps the
        -- comparison below affinity-free, which the expression index needs.
        SELECT stream_id, json_extract(payload_json, '$.id') AS thread_id, MAX(sequence) AS last_sequence
        FROM orchestration_events NOT INDEXED
        WHERE sequence > ${range.afterSequence}
          AND sequence <= ${range.throughSequence}
          AND application_event_version = 2
          AND event_type IN ${THREAD_STATE_EVENT_TYPES}
          AND aggregate_kind = 'thread'
        GROUP BY stream_id, thread_id
      )
      SELECT version.sequence
      FROM latest
      CROSS JOIN orchestration_events AS version
        INDEXED BY idx_orch_events_versions
      WHERE version.application_event_version = 2
        AND version.event_type IN ${VERSIONED_EVENT_TYPES}
        AND version.event_type IN ${THREAD_STATE_EVENT_TYPES}
        AND json_extract(version.payload_json, '$.id') = latest.thread_id
        AND version.sequence < latest.last_sequence
        AND version.stream_id = latest.stream_id
    `;

    // Every superseded snapshot of each entity the range touches. Turn items
    // also keep their first event: rebuild replays it into
    // turn_item_positions, and keeping both ends means compaction cannot
    // reorder a transcript under either a first-write-wins or a
    // last-write-wins derivation.
    const supersededEntitySnapshotsInRange = (range: {
      readonly afterSequence: number;
      readonly throughSequence: number;
    }) => sql<{ readonly sequence: number }>`
      WITH latest AS (
        SELECT
          event_type,
          json_extract(payload_json, '$.id') AS entity_id,
          stream_id,
          MAX(sequence) AS last_sequence
        FROM orchestration_events NOT INDEXED
        WHERE sequence > ${range.afterSequence}
          AND sequence <= ${range.throughSequence}
          AND application_event_version = 2
          AND event_type IN ${ENTITY_SNAPSHOT_EVENT_TYPES}
        GROUP BY event_type, entity_id, stream_id
      )
      SELECT version.sequence
      FROM latest
      CROSS JOIN orchestration_events AS version
        INDEXED BY idx_orch_events_versions
      WHERE version.application_event_version = 2
        AND version.event_type IN ${VERSIONED_EVENT_TYPES}
        AND version.event_type IN ${ENTITY_SNAPSHOT_EVENT_TYPES}
        AND version.event_type = latest.event_type
        AND json_extract(version.payload_json, '$.id') = latest.entity_id
        AND version.sequence < latest.last_sequence
        AND version.stream_id = latest.stream_id
        AND (
          latest.event_type <> 'turn-item.updated'
          OR version.sequence > (
            SELECT MIN(first.sequence)
            FROM orchestration_events AS first
              INDEXED BY idx_orch_events_versions
            WHERE first.application_event_version = 2
              AND first.event_type IN ${VERSIONED_EVENT_TYPES}
              AND first.event_type = latest.event_type
              AND json_extract(first.payload_json, '$.id') = latest.entity_id
              AND first.stream_id = latest.stream_id
          )
        )
    `;

    /**
     * Legacy v1 thread events and their pre-migration command receipts for
     * threads whose v2 import completed — the v1 store is only read to import
     * from, and imports never re-run once transcript_imported_at is set. No
     * cursor: v1 rows are never appended, so each run walks what is left
     * through the (application_event_version, sequence) index.
     */
    const compactImportedLegacyRows = (cutoff: string | null) =>
      Effect.gen(function* () {
        const eventWithinRetention = cutoff === null ? sql`` : sql` AND occurred_at < ${cutoff}`;
        const receiptWithinRetention = cutoff === null ? sql`` : sql` AND accepted_at < ${cutoff}`;
        let deletedEventCount = 0;
        let afterSequence = 0;
        while (true) {
          const chunk = yield* sql<{
            readonly sequence: number;
            readonly collectable: number;
          }>`
            SELECT
              sequence,
              aggregate_kind = 'thread'${eventWithinRetention}
                AND stream_id IN (
                  SELECT thread_id
                  FROM orchestration_v2_legacy_imports
                  WHERE transcript_imported_at IS NOT NULL
                ) AS collectable
            FROM orchestration_events
              INDEXED BY idx_orchestration_events_application_sequence
            WHERE application_event_version = 1
              AND sequence > ${afterSequence}
            ORDER BY sequence ASC
            LIMIT ${COMPACTION_DELETE_BATCH_SIZE}
          `;
          const last = chunk.at(-1);
          if (last === undefined) break;
          const collectable = chunk.filter((row) => row.collectable === 1);
          yield* deleteEvents(collectable.map((row) => row.sequence));
          deletedEventCount += collectable.length;
          afterSequence = last.sequence;
          yield* Effect.yieldNow;
        }

        // Receipts written before the command_type column existed default to
        // 'legacy'; for fully imported v1 threads they guard idempotency of
        // commands that can no longer be re-sent.
        let deletedReceiptCount = 0;
        while (true) {
          const rows = yield* sql<{ readonly command_id: string }>`
            SELECT command_id
            FROM orchestration_command_receipts
            WHERE command_type = 'legacy'
              AND aggregate_kind = 'thread'${receiptWithinRetention}
              AND aggregate_id IN (
                SELECT thread_id
                FROM orchestration_v2_legacy_imports
                WHERE transcript_imported_at IS NOT NULL
              )
            LIMIT ${COMPACTION_DELETE_BATCH_SIZE}
          `;
          if (rows.length > 0) {
            yield* sql`
              DELETE FROM orchestration_command_receipts
              WHERE command_id IN ${sql.in(rows.map((row) => row.command_id))}
            `;
          }
          deletedReceiptCount += rows.length;
          if (rows.length < COMPACTION_DELETE_BATCH_SIZE) break;
          yield* Effect.yieldNow;
        }
        return { deletedEventCount, deletedReceiptCount };
      });

    const pragmaNumber = (pragma: "auto_vacuum" | "freelist_count" | "page_size") =>
      sql
        .unsafe<Record<string, number>>(`PRAGMA ${pragma}`)
        .pipe(Effect.map((rows) => Number(rows[0]?.[pragma] ?? 0)));

    /**
     * Hand freed pages back to the filesystem in small steps. Only databases
     * created with auto_vacuum = INCREMENTAL (see the persistence setup) can
     * do this; older ones reuse their free pages but keep their size until an
     * offline VACUUM.
     */
    const releaseFreePages = Effect.gen(function* () {
      const pageSize = yield* pragmaNumber("page_size");
      if ((yield* pragmaNumber("auto_vacuum")) !== 2) {
        return {
          reclaimedBytes: 0,
          reclaimableBytes: (yield* pragmaNumber("freelist_count")) * pageSize,
        };
      }
      let reclaimedPages = 0;
      let freePages = yield* pragmaNumber("freelist_count");
      while (freePages > 0) {
        yield* sql.unsafe(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_STEP_PAGES})`);
        const remaining = yield* pragmaNumber("freelist_count");
        if (remaining >= freePages) break;
        reclaimedPages += freePages - remaining;
        freePages = remaining;
        yield* Effect.yieldNow;
      }
      return { reclaimedBytes: reclaimedPages * pageSize, reclaimableBytes: freePages * pageSize };
    });

    /**
     * Incremental event-store compaction. Projections are the working state
     * (startup verifies rather than replays), so events only serve
     * afterSequence catch-up and disaster-recovery rebuild — and for
     * full-payload "state of the entity" events, anything but the newest per
     * entity is dead weight in both. Passes:
     *
     * 1. Superseded streaming snapshots (turn items, messages, nodes) once
     *    their successor is an hour old.
     * 2. Superseded thread-state events (visits alone accumulate at multiple
     *    per minute while a thread is open) past the retention window.
     * 3. Legacy v1 rows of fully imported threads past the retention window.
     *
     * Deleting a version only ever happens when a newer version of the same
     * entity is committed, and the newest is never deleted, so a client
     * resuming from any sequence still receives every entity's latest state,
     * and an in-flight item's last persisted state survives a crash.
     *
     * Then freed pages are released (incremental-vacuum databases only) and
     * the planner statistics are refreshed. VACUUM is never run here: on the
     * synchronous driver it would block every query for minutes on a
     * multi-GB file.
     */
    const compactEventStore = (options?: {
      readonly retainNewerThan?: Duration.Duration;
      readonly retainSnapshotsNewerThan?: Duration.Duration;
    }) =>
      Effect.gen(function* () {
        const retainNewerThan = options?.retainNewerThan ?? COMPACTION_RETENTION_WINDOW;
        const retainSnapshotsNewerThan =
          options?.retainSnapshotsNewerThan ??
          Duration.min(retainNewerThan, SNAPSHOT_RETENTION_WINDOW);
        const retentionCutoff = yield* cutoffFor(retainNewerThan);
        // Fixed for the run: ranges past it would advance a cursor over
        // sequences that are not yet committed.
        const highWater = yield* eventStore.latestSequence();

        const deletedSnapshotCount = yield* walkRanges({
          pass: "entity-snapshots",
          cutoff: yield* cutoffFor(retainSnapshotsNewerThan),
          highWater,
          supersededInRange: supersededEntitySnapshotsInRange,
        });
        const deletedThreadStateCount = yield* walkRanges({
          pass: "thread-state",
          cutoff: retentionCutoff,
          highWater,
          supersededInRange: supersededThreadStateInRange,
        });
        const legacy = yield* compactImportedLegacyRows(retentionCutoff);

        const space = yield* releaseFreePages;
        // Deletes shift row counts; optimize re-analyzes only the tables
        // whose counts moved enough to matter, bounded by analysis_limit.
        yield* sql`PRAGMA analysis_limit = 400`;
        yield* sql`PRAGMA optimize`;

        return {
          deletedEventCount:
            deletedSnapshotCount + deletedThreadStateCount + legacy.deletedEventCount,
          deletedReceiptCount: legacy.deletedReceiptCount,
          reclaimedBytes: space.reclaimedBytes,
          reclaimableBytes: space.reclaimableBytes,
          retentionCutoff,
        };
      });

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore: (options) => mapError("compact event store")(compactEventStore(options)),
    });
  }),
);
