import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Index-driven, incremental event-store compaction.
 *
 * Compaction used to find superseded events with whole-table scans that ran
 * json_extract on every payload — 1.4-22s per statement on a 6.6 GB store,
 * each one freezing the synchronous driver. Compaction now walks the log in
 * sequence ranges and, for each entity a range touches, seeks its older
 * versions through this partial index, keyed by event type and payload id.
 * Only the full-state event types are indexed — streaming snapshots and
 * thread-state events, whose payload id is the thread id — so json_extract
 * runs once per such insert rather than per row on every compaction pass.
 *
 * The WHERE clause must match the compaction queries in
 * ProjectionMaintenance.ts term for term, or SQLite will not use it.
 * Building it reads the whole event table once: ~3s warm, ~25s from a cold
 * disk cache on a 6.6 GB store.
 *
 * The cursor table remembers how far each compaction pass has walked, so a
 * pass only reads events appended since the last one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_versions
      ON orchestration_events(event_type, json_extract(payload_json, '$.id'), sequence)
      WHERE application_event_version = 2
        AND event_type IN (
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
        )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_event_compaction_cursors (
      pass TEXT PRIMARY KEY,
      through_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
