/**
 * MigrationsLive - Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * Migrations run automatically when the MigrationLayer is provided,
 * ensuring the database schema is always up-to-date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_OrchestrationV2.ts";
import Migration0037 from "./Migrations/037_OrchestrationV2Subagents.ts";
import Migration0038 from "./Migrations/038_OrchestrationV2Foundation.ts";
import Migration0039 from "./Migrations/039_OrchestrationV2ProviderSessionBindings.ts";
import Migration0040 from "./Migrations/040_OrchestrationV2ThreadLaunchWorkflows.ts";
import Migration0041 from "./Migrations/041_ApplicationEventSource.ts";
import Migration0042 from "./Migrations/042_OrchestrationV2EffectCancellation.ts";
import Migration0043 from "./Migrations/043_ScheduledTasks.ts";
import Migration0044 from "./Migrations/044_LegacyV1ImportState.ts";
import Migration0045 from "./Migrations/045_HermesSessionBindings.ts";
import Migration0046 from "./Migrations/046_HermesProactiveEvents.ts";
import Migration0047 from "./Migrations/047_HermesTitleBranchLineage.ts";
import Migration0048 from "./Migrations/048_HermesSessionImports.ts";
import Migration0049 from "./Migrations/049_HermesImportProjectScope.ts";
import Migration0050 from "./Migrations/050_HermesImportInheritedBoundary.ts";
import Migration0051 from "./Migrations/051_HermesCronRunWatermarks.ts";
import Migration0052 from "./Migrations/052_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0053 from "./Migrations/053_ProjectionProjectFaviconPath.ts";
import Migration0054 from "./Migrations/054_WorktreeRetentionRegistry.ts";
import Migration0055 from "./Migrations/055_WorktreeRetentionLifecycle.ts";
import Migration0056 from "./Migrations/056_HermesCronRunOutcome.ts";
import Migration0057 from "./Migrations/057_ProjectionTurnItemsThreadRunIndex.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "OrchestrationV2", Migration0036],
  [37, "OrchestrationV2Subagents", Migration0037],
  [38, "OrchestrationV2Foundation", Migration0038],
  [39, "OrchestrationV2ProviderSessionBindings", Migration0039],
  [40, "OrchestrationV2ThreadLaunchWorkflows", Migration0040],
  [41, "ApplicationEventSource", Migration0041],
  [42, "OrchestrationV2EffectCancellation", Migration0042],
  [43, "ScheduledTasks", Migration0043],
  [44, "LegacyV1ImportState", Migration0044],
  [45, "HermesSessionBindings", Migration0045],
  [46, "HermesProactiveEvents", Migration0046],
  [47, "HermesTitleBranchLineage", Migration0047],
  [48, "HermesSessionImports", Migration0048],
  [49, "HermesImportProjectScope", Migration0049],
  [50, "HermesImportInheritedBoundary", Migration0050],
  [51, "HermesCronRunWatermarks", Migration0051],
  [52, "ProjectionProjectsDefaultThreadEnvMode", Migration0052],
  [53, "ProjectionProjectFaviconPath", Migration0053],
  [54, "WorktreeRetentionRegistry", Migration0054],
  [55, "WorktreeRetentionLifecycle", Migration0055],
  [56, "HermesCronRunOutcome", Migration0056],
  [57, "ProjectionTurnItemsThreadRunIndex", Migration0057],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * The fork's migration ids diverge from the official app at 36: upstream keeps
 * shipping its own migrations under 36+ while the fork owns those numbers for
 * the orchestration-v2 schema. A database last opened by the official app has
 * journal rows for 36+ that name upstream migrations, which makes the migrator
 * skip the fork's 36-38 (the ones that create the orchestration_v2_* tables)
 * and crash at the first fork migration that reads them.
 */
const forkDivergenceId = 36;

/**
 * Upstream migrations 36+ whose schema changes are safe to leave in place when
 * their journal rows are dropped: guarded ALTER TABLE ADD COLUMNs and a
 * CREATE INDEX IF NOT EXISTS, none of which conflict with fork migrations
 * (the fork's own copy under 052 checks for the column before adding it).
 * An upstream journal row 36+ with a name outside this set means the official
 * app applied a migration we have not audited, so we refuse to touch the
 * database instead of guessing.
 */
const reconcilableUpstreamMigrations = new Set([
  "ProjectionThreadsPinned",
  "ProjectionTurnsKeysetIndex",
  "ProjectionThreadsPinOrderKey",
  "ProjectionProjectsDefaultThreadEnvMode",
  "ProjectionProjectFaviconPath",
]);

const forkMigrationNames = new Map<number, string>(
  migrationEntries.map(([id, name]) => [id, name]),
);

const knownForkMigrationNames: ReadonlySet<string> = new Set(
  migrationEntries.map(([, name]) => name),
);

type SchemaMarker =
  | { readonly kind: "table"; readonly table: string }
  | { readonly kind: "index"; readonly index: string }
  | { readonly kind: "column"; readonly table: string; readonly column: string };

/**
 * One provable schema artifact per fork migration from the divergence point on.
 * If the marker exists but the journal row does not, the migration already ran
 * on this database under a journal the fork can no longer trust (official app,
 * manual repair, renumbered build) — the journal row is restored instead of
 * re-running the migration, which would crash on the existing schema.
 * Every entry in migrationEntries at or past forkDivergenceId must have a
 * marker; a test enforces this.
 */
export const forkMigrationMarkers: ReadonlyArray<readonly [number, SchemaMarker]> = [
  [36, { kind: "table", table: "orchestration_v2_events" }],
  [37, { kind: "table", table: "orchestration_v2_projection_subagents" }],
  [38, { kind: "column", table: "orchestration_v2_events", column: "driver" }],
  [39, { kind: "table", table: "orchestration_v2_projection_provider_session_bindings" }],
  [40, { kind: "table", table: "orchestration_v2_thread_launch_workflows" }],
  [41, { kind: "index", index: "idx_orchestration_events_application_sequence" }],
  // Not claim_idx/command_idx: 038 creates those too on the pre-rebuild table.
  [42, { kind: "index", index: "orchestration_v2_effect_outbox_thread_status_idx" }],
  [43, { kind: "table", table: "scheduled_tasks" }],
  [44, { kind: "table", table: "orchestration_v2_legacy_imports" }],
  [45, { kind: "table", table: "hermes_session_bindings" }],
  [46, { kind: "table", table: "hermes_proactive_sources" }],
  [47, { kind: "column", table: "hermes_session_bindings", column: "title_revision" }],
  [48, { kind: "table", table: "hermes_session_imports" }],
  [49, { kind: "column", table: "hermes_session_imports", column: "project_id" }],
  [50, { kind: "column", table: "hermes_session_imports", column: "inherited_message_count" }],
  [51, { kind: "table", table: "hermes_cron_run_watermarks" }],
  [52, { kind: "column", table: "projection_projects", column: "default_thread_env_mode" }],
  [53, { kind: "column", table: "projection_projects", column: "favicon_path" }],
  [54, { kind: "table", table: "worktree_retention_registry" }],
  [55, { kind: "index", index: "idx_worktree_retention_registry_claim" }],
  [56, { kind: "column", table: "hermes_cron_run_watermarks", column: "last_status" }],
];

const markerExists = Effect.fn("markerExists")(function* (marker: SchemaMarker) {
  const sql = yield* SqlClient.SqlClient;
  switch (marker.kind) {
    case "table": {
      const rows = yield* sql`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${marker.table}
      `;
      return rows.length > 0;
    }
    case "index": {
      const rows = yield* sql`
        SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ${marker.index}
      `;
      return rows.length > 0;
    }
    case "column": {
      const rows = yield* sql`
        SELECT 1 FROM pragma_table_info(${marker.table}) WHERE name = ${marker.column}
      `;
      return rows.length > 0;
    }
  }
});

/**
 * Restore journal rows for fork migrations whose schema is already present but
 * whose journal rows were lost (reset by reconciliation, stripped by a manual
 * repair, or written under renumbered ids by a patched build). Migrations run
 * contiguously, so adoption walks up from the divergence point and stops at the
 * first migration whose marker is absent — everything past that point runs
 * normally. Without this, the migrator re-runs the base orchestration_v2
 * migration and crashes with "table orchestration_v2_events already exists"
 * on every launch.
 */
export const adoptAppliedForkMigrations = Effect.fn("adoptAppliedForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const journalTable = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (journalTable.length === 0) return;

  const rows = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM effect_sql_migrations
    WHERE migration_id >= ${forkDivergenceId}
  `;
  const journaled = new Set(rows.map((row) => row.migration_id));

  const adopted: Array<string> = [];
  const adoptedAt = DateTime.formatIso(yield* DateTime.now);
  for (const [id, marker] of forkMigrationMarkers) {
    if (journaled.has(id)) continue;
    if (!(yield* markerExists(marker))) break;
    const name = forkMigrationNames.get(id);
    if (name === undefined) break;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      VALUES (${id}, ${name}, ${adoptedAt})
    `;
    adopted.push(`${id}_${name}`);
  }

  if (adopted.length > 0) {
    yield* Effect.log("Adopted already-applied fork migrations into the journal").pipe(
      Effect.annotateLogs({ adopted }),
    );
  }
});

export class UpstreamMigrationJournalError extends Error {
  override readonly name = "UpstreamMigrationJournalError";
}

/**
 * Detect a journal written by the official app and reset it back to the shared
 * prefix (ids < 36) so the fork's own migrations run from the divergence point.
 * The data those upstream migrations touched is preserved; only their journal
 * rows are removed.
 */
export const reconcileUpstreamMigrationJournal = Effect.fn("reconcileUpstreamMigrationJournal")(
  function* () {
    const sql = yield* SqlClient.SqlClient;

    const journalTable = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (journalTable.length === 0) return;

    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations
      WHERE migration_id >= ${forkDivergenceId}
      ORDER BY migration_id
    `;
    const upstreamRows = rows.filter(
      (row) => forkMigrationNames.get(row.migration_id) !== row.name,
    );
    if (upstreamRows.length === 0) return;

    const unknown = upstreamRows.filter(
      (row) =>
        !reconcilableUpstreamMigrations.has(row.name) &&
        // A fork migration name journaled under the wrong id comes from a
        // patched/renumbered build; dropping the row is safe because adoption
        // re-stamps it at the correct id from the schema itself.
        !knownForkMigrationNames.has(row.name),
    );
    if (unknown.length > 0) {
      return yield* Effect.fail(
        new UpstreamMigrationJournalError(
          "This database was migrated by the official app past the point this fork can " +
            "automatically reconcile. Unrecognized migrations: " +
            unknown.map((row) => `${row.migration_id}_${row.name}`).join(", ") +
            ". Back up the database and resolve the journal manually, or update the fork.",
        ),
      );
    }

    yield* sql`
      DELETE FROM effect_sql_migrations
      WHERE migration_id IN ${sql.in(upstreamRows.map((row) => row.migration_id))}
    `;
    yield* Effect.log("Reconciled official-app migration journal").pipe(
      Effect.annotateLogs({
        removed: upstreamRows.map((row) => `${row.migration_id}_${row.name}`),
      }),
    );
  },
);

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  yield* reconcileUpstreamMigrationJournal();
  yield* adoptAppliedForkMigrations();
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

/**
 * Layer that runs migrations when the layer is built.
 *
 * Use this to ensure migrations run before your application starts.
 * Migrations are run automatically - no separate script is needed.
 *
 * @example
 * ```typescript
 * import { MigrationsLive } from "@acme/db/Migrations"
 * import * as SqliteClient from "@acme/db/SqliteClient"
 *
 * // Migrations run automatically when SqliteClient is provided
 * const AppLayer = MigrationsLive.pipe(
 *   Layer.provideMerge(SqliteClient.layer({ filename: "database.sqlite" }))
 * )
 * ```
 */
export const MigrationsLive = Layer.effectDiscard(runMigrations());
