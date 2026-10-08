import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `sqlite_stat1` as `PRAGMA optimize` (analysis_limit 400) wrote it for the
 * orchestration tables of a real 6.6 GB store: 789k events, 362k turn items,
 * 167k nodes, 1.5k threads. The sample reads the first entries of each index,
 * so mostly-NULL or low-cardinality leading columns come out far too
 * selective (`aggregate_kind` at 201 rows per value against a real 390k).
 *
 * Plan tests run on tiny databases with no statistics, where SQLite falls back
 * to fixed guesses. Loading these rows makes it plan as it does in production.
 */
const PRODUCTION_PLANNER_STATISTICS: ReadonlyArray<
  readonly [table: string, index: string | null, stat: string]
> = [
  ["orchestration_command_receipts", "idx_orch_command_receipts_aggregate", "61711 201 19"],
  ["orchestration_command_receipts", "idx_orch_command_receipts_sequence", "61711 1"],
  [
    "orchestration_command_receipts",
    "sqlite_autoindex_orchestration_command_receipts_1",
    "61711 1",
  ],
  [
    "orchestration_event_compaction_cursors",
    "sqlite_autoindex_orchestration_event_compaction_cursors_1",
    "2 1",
  ],
  ["orchestration_events", "idx_orch_events_command_id", "789623 6"],
  ["orchestration_events", "idx_orch_events_correlation_id", "789623 6"],
  ["orchestration_events", "idx_orch_events_stream_sequence", "789623 201 34 1"],
  ["orchestration_events", "idx_orch_events_stream_version", "789623 201 34 1"],
  ["orchestration_events", "idx_orch_events_versions", "634453 401 1 1"],
  ["orchestration_events", "idx_orchestration_events_application_sequence", "789623 401 1"],
  ["orchestration_events", "sqlite_autoindex_orchestration_events_1", "789623 1"],
  ["orchestration_v2_effect_outbox", "orchestration_v2_effect_outbox_claim_idx", "2037 134 1 1 1"],
  ["orchestration_v2_effect_outbox", "orchestration_v2_effect_outbox_command_idx", "2037 1 1"],
  [
    "orchestration_v2_effect_outbox",
    "orchestration_v2_effect_outbox_thread_status_idx",
    "2037 37 37 17",
  ],
  ["orchestration_v2_effect_outbox", "sqlite_autoindex_orchestration_v2_effect_outbox_1", "2037 1"],
  [
    "orchestration_v2_legacy_imports",
    "orchestration_v2_legacy_imports_pending_transcript_idx",
    "104 1 1 1",
  ],
  [
    "orchestration_v2_legacy_imports",
    "sqlite_autoindex_orchestration_v2_legacy_imports_1",
    "104 1",
  ],
  [
    "orchestration_v2_projection_checkpoint_scopes",
    "orchestration_v2_projection_checkpoint_scopes_parent_idx",
    "676 401",
  ],
  [
    "orchestration_v2_projection_checkpoint_scopes",
    "orchestration_v2_projection_checkpoint_scopes_thread_idx",
    "676 1",
  ],
  [
    "orchestration_v2_projection_checkpoint_scopes",
    "sqlite_autoindex_orchestration_v2_projection_checkpoint_scopes_1",
    "676 1",
  ],
  [
    "orchestration_v2_projection_checkpoints",
    "orchestration_v2_projection_checkpoints_parent_idx",
    "5204 2",
  ],
  [
    "orchestration_v2_projection_checkpoints",
    "orchestration_v2_projection_checkpoints_scope_ordinal_idx",
    "5204 7 1",
  ],
  [
    "orchestration_v2_projection_checkpoints",
    "orchestration_v2_projection_checkpoints_thread_idx",
    "5204 7",
  ],
  [
    "orchestration_v2_projection_checkpoints",
    "sqlite_autoindex_orchestration_v2_projection_checkpoints_1",
    "5204 1",
  ],
  [
    "orchestration_v2_projection_context_handoffs",
    "orchestration_v2_projection_context_handoffs_target_run_idx",
    "239 6",
  ],
  [
    "orchestration_v2_projection_context_handoffs",
    "orchestration_v2_projection_context_handoffs_thread_idx",
    "239 20",
  ],
  [
    "orchestration_v2_projection_context_handoffs",
    "sqlite_autoindex_orchestration_v2_projection_context_handoffs_1",
    "239 1",
  ],
  [
    "orchestration_v2_projection_context_transfers",
    "orchestration_v2_projection_context_transfers_source_thread_idx",
    "458 3",
  ],
  [
    "orchestration_v2_projection_context_transfers",
    "orchestration_v2_projection_context_transfers_target_run_idx",
    "458 2",
  ],
  [
    "orchestration_v2_projection_context_transfers",
    "orchestration_v2_projection_context_transfers_target_thread_idx",
    "458 3 3",
  ],
  [
    "orchestration_v2_projection_context_transfers",
    "sqlite_autoindex_orchestration_v2_projection_context_transfers_1",
    "458 1",
  ],
  [
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_messages_node_idx",
    "33154 2",
  ],
  [
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_messages_run_idx",
    "33154 11",
  ],
  [
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_messages_thread_created_idx",
    "33154 45 2 1",
  ],
  [
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_messages_thread_run_idx",
    "33154 45 6",
  ],
  [
    "orchestration_v2_projection_messages",
    "sqlite_autoindex_orchestration_v2_projection_messages_1",
    "33154 1",
  ],
  [
    "orchestration_v2_projection_metadata",
    "sqlite_autoindex_orchestration_v2_projection_metadata_1",
    "1 1",
  ],
  [
    "orchestration_v2_projection_nodes",
    "orchestration_v2_projection_nodes_parent_idx",
    "167450 101",
  ],
  [
    "orchestration_v2_projection_nodes",
    "orchestration_v2_projection_nodes_provider_turn_idx",
    "167450 35",
  ],
  [
    "orchestration_v2_projection_nodes",
    "orchestration_v2_projection_nodes_thread_run_idx",
    "167450 81 20",
  ],
  [
    "orchestration_v2_projection_nodes",
    "sqlite_autoindex_orchestration_v2_projection_nodes_1",
    "167450 1",
  ],
  ["orchestration_v2_projection_plans", "orchestration_v2_projection_plans_run_idx", "12 1"],
  ["orchestration_v2_projection_plans", "orchestration_v2_projection_plans_thread_idx", "12 2"],
  [
    "orchestration_v2_projection_plans",
    "sqlite_autoindex_orchestration_v2_projection_plans_1",
    "12 1",
  ],
  [
    "orchestration_v2_projection_provider_session_bindings",
    "orchestration_v2_projection_provider_session_bindings_thread_idx",
    "311 1",
  ],
  [
    "orchestration_v2_projection_provider_session_bindings",
    "sqlite_autoindex_orchestration_v2_projection_provider_session_bindings_1",
    "311 1 1",
  ],
  [
    "orchestration_v2_projection_provider_sessions",
    "orchestration_v2_projection_provider_sessions_instance_status_idx",
    "620 146 73",
  ],
  [
    "orchestration_v2_projection_provider_sessions",
    "orchestration_v2_projection_provider_sessions_provider_status_idx",
    "620 146 73",
  ],
  [
    "orchestration_v2_projection_provider_sessions",
    "orchestration_v2_projection_provider_sessions_thread_idx",
    "620 1",
  ],
  [
    "orchestration_v2_projection_provider_sessions",
    "sqlite_autoindex_orchestration_v2_projection_provider_sessions_1",
    "620 1",
  ],
  [
    "orchestration_v2_projection_provider_threads",
    "orchestration_v2_projection_provider_threads_instance_status_idx",
    "710 131 75",
  ],
  [
    "orchestration_v2_projection_provider_threads",
    "orchestration_v2_projection_provider_threads_owner_idx",
    "710 401",
  ],
  [
    "orchestration_v2_projection_provider_threads",
    "orchestration_v2_projection_provider_threads_session_idx",
    "710 1",
  ],
  [
    "orchestration_v2_projection_provider_threads",
    "orchestration_v2_projection_provider_threads_thread_idx",
    "710 1",
  ],
  [
    "orchestration_v2_projection_provider_threads",
    "sqlite_autoindex_orchestration_v2_projection_provider_threads_1",
    "710 1",
  ],
  [
    "orchestration_v2_projection_provider_turns",
    "orchestration_v2_projection_provider_turns_thread_idx",
    "4737 5",
  ],
  [
    "orchestration_v2_projection_provider_turns",
    "orchestration_v2_projection_provider_turns_thread_ordinal_idx",
    "4737 5 1",
  ],
  [
    "orchestration_v2_projection_provider_turns",
    "sqlite_autoindex_orchestration_v2_projection_provider_turns_1",
    "4737 1",
  ],
  [
    "orchestration_v2_projection_run_attempts",
    "orchestration_v2_projection_run_attempts_run_ordinal_idx",
    "4760 1 1",
  ],
  [
    "orchestration_v2_projection_run_attempts",
    "orchestration_v2_projection_run_attempts_thread_idx",
    "4760 5 1",
  ],
  [
    "orchestration_v2_projection_run_attempts",
    "sqlite_autoindex_orchestration_v2_projection_run_attempts_1",
    "4760 1",
  ],
  [
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_runs_provider_thread_idx",
    "4760 5",
  ],
  [
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_runs_thread_ordinal_idx",
    "4760 5 1",
  ],
  [
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_runs_thread_status_idx",
    "4760 5 5",
  ],
  [
    "orchestration_v2_projection_runs",
    "sqlite_autoindex_orchestration_v2_projection_runs_1",
    "4760 1",
  ],
  [
    "orchestration_v2_projection_runtime_requests",
    "orchestration_v2_projection_runtime_requests_provider_turn_idx",
    "24 2",
  ],
  [
    "orchestration_v2_projection_runtime_requests",
    "orchestration_v2_projection_runtime_requests_thread_status_idx",
    "24 2 2",
  ],
  [
    "orchestration_v2_projection_runtime_requests",
    "sqlite_autoindex_orchestration_v2_projection_runtime_requests_1",
    "24 1",
  ],
  [
    "orchestration_v2_projection_subagents",
    "orchestration_v2_projection_subagents_child_thread_idx",
    "895 1",
  ],
  [
    "orchestration_v2_projection_subagents",
    "orchestration_v2_projection_subagents_parent_node_idx",
    "895 4",
  ],
  [
    "orchestration_v2_projection_subagents",
    "orchestration_v2_projection_subagents_provider_thread_idx",
    "895 3",
  ],
  [
    "orchestration_v2_projection_subagents",
    "orchestration_v2_projection_subagents_thread_idx",
    "895 10 1 1",
  ],
  [
    "orchestration_v2_projection_subagents",
    "sqlite_autoindex_orchestration_v2_projection_subagents_1",
    "895 1",
  ],
  [
    "orchestration_v2_projection_threads",
    "orchestration_v2_projection_threads_project_updated_idx",
    "1514 51 1",
  ],
  [
    "orchestration_v2_projection_threads",
    "sqlite_autoindex_orchestration_v2_projection_threads_1",
    "1514 1",
  ],
  [
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_turn_items_live_command_idx",
    "22 2",
  ],
  [
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_turn_items_node_ordinal_idx",
    "175597 101 3",
  ],
  [
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_turn_items_provider_turn_idx",
    "175597 29",
  ],
  [
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_turn_items_run_ordinal_idx",
    "175597 39 2",
  ],
  [
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_turn_items_thread_ordinal_idx",
    "175597 41 1 1",
  ],
  [
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_turn_items_thread_run_idx",
    "175597 41 17",
  ],
  [
    "orchestration_v2_projection_turn_items",
    "sqlite_autoindex_orchestration_v2_projection_turn_items_1",
    "175597 1",
  ],
  [
    "orchestration_v2_turn_item_positions",
    "sqlite_autoindex_orchestration_v2_turn_item_positions_1",
    "175621 41 1",
  ],
  [
    "orchestration_v2_turn_item_positions",
    "sqlite_autoindex_orchestration_v2_turn_item_positions_2",
    "175621 41 1",
  ],
];

/** Make SQLite plan this connection's queries as it would on a large production store. */
export const loadProductionPlannerStatistics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Creates sqlite_stat1 if it does not exist yet; the test database is tiny.
  yield* sql`ANALYZE`;
  yield* sql`DELETE FROM sqlite_stat1`;
  for (const [table, index, stat] of PRODUCTION_PLANNER_STATISTICS) {
    yield* sql`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (${table}, ${index}, ${stat})`;
  }
  // Reloads the statistics into the planner.
  yield* sql`ANALYZE sqlite_schema`;
});

/** Back to the no-statistics planner, for tests sharing a database. */
export const clearPlannerStatistics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM sqlite_stat1`;
  yield* sql`ANALYZE sqlite_schema`;
});
