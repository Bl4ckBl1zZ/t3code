#!/usr/bin/env node
// @effect-diagnostics anyUnknownInErrorContext:off - drizzle's effect-postgres migrator types its errors as any.
// Applies the relay Postgres migrations to a self-hosted database.
//
//   DATABASE_MIGRATION_URL=postgresql://... node scripts/migrate.ts
//
// DATABASE_MIGRATION_URL falls back to DATABASE_URL. Drizzle tracks applied
// migrations by folder name in drizzle.relay_migrations, so before migrating
// this renames journal rows the fork recorded under other names.
import * as NodeURL from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PgClient from "@effect/sql-pg/PgClient";
import { sql } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const RELAY_MIGRATIONS_FOLDER = NodeURL.fileURLToPath(
  new URL("../migrations/postgres", import.meta.url),
);
export const RELAY_MIGRATIONS_SCHEMA = "drizzle";
export const RELAY_MIGRATIONS_TABLE = "relay_migrations";

/**
 * Upstream migrations the fork applied under a different folder name. The SQL
 * is identical, so the fork's journal row is renamed instead of re-running it.
 */
export const FORK_RENAMED_MIGRATIONS: Readonly<Record<string, string>> = {
  "20260925043329_managed_endpoint_recovery": "20260919015455_managed_endpoint_recovery",
};

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * One idempotent statement that rewrites fork journal rows to the upstream
 * name, hash and timestamp. A no-op on fresh or already reconciled databases.
 */
export function forkMigrationJournalReconcileSql(
  migrationsFolder: string = RELAY_MIGRATIONS_FOLDER,
): string {
  const local = new Map(
    readMigrationFiles({ migrationsFolder }).map((migration) => [migration.name, migration]),
  );
  const table = `"${RELAY_MIGRATIONS_SCHEMA}"."${RELAY_MIGRATIONS_TABLE}"`;
  const updates = Object.entries(FORK_RENAMED_MIGRATIONS).map(([forkName, upstreamName]) => {
    const migration = local.get(upstreamName);
    if (!migration) {
      throw new Error(
        `Renamed relay migration ${upstreamName} is missing from ${migrationsFolder}.`,
      );
    }
    return [
      `UPDATE ${table}`,
      `SET name = ${literal(upstreamName)}, hash = ${literal(migration.hash)}, created_at = ${migration.folderMillis}`,
      `WHERE name = ${literal(forkName)}`,
      `AND NOT EXISTS (SELECT 1 FROM ${table} WHERE name = ${literal(upstreamName)});`,
    ].join(" ");
  });
  return [
    "DO $$ BEGIN",
    `IF to_regclass(${literal(table)}) IS NOT NULL THEN`,
    ...updates,
    "END IF;",
    "END $$;",
  ].join("\n");
}

const migrationDatabaseUrl = Config.Redacted("DATABASE_MIGRATION_URL").pipe(
  Config.orElse(() => Config.Redacted("DATABASE_URL")),
);

const program = Effect.gen(function* () {
  const database = yield* makeWithDefaults();
  yield* database.execute(sql.raw(forkMigrationJournalReconcileSql()));
  yield* migrate(database, {
    migrationsFolder: RELAY_MIGRATIONS_FOLDER,
    migrationsSchema: RELAY_MIGRATIONS_SCHEMA,
    migrationsTable: RELAY_MIGRATIONS_TABLE,
  });
  yield* Effect.logInfo("Relay database migrations are current.");
}).pipe(Effect.provide(PgClient.layerConfig({ url: migrationDatabaseUrl })));

if (import.meta.main) {
  NodeRuntime.runMain(program);
}
