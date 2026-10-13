#!/usr/bin/env node
// @effect-diagnostics anyUnknownInErrorContext:off - drizzle's effect-postgres migrator types its errors as any.
// Applies the relay Postgres migrations to a self-hosted database.
//
//   DATABASE_MIGRATION_URL=postgresql://... node scripts/migrate.ts
//
//   ... node scripts/migrate.ts --check   # read-only: list applied and pending migrations
//
// DATABASE_MIGRATION_URL falls back to DATABASE_URL. Drizzle tracks applied
// migrations by folder name in drizzle.relay_migrations, so before migrating
// this renames journal rows the fork recorded under other names. The first run
// on a fork database first copies every table into the `relay_backup_fork`
// schema, so the pre-upgrade data stays restorable in place.
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

export const FORK_BACKUP_SCHEMA = "relay_backup_fork";

/**
 * One idempotent statement that copies every `public` table and the migration
 * journal into `relay_backup_fork`, once, and only while the journal still has
 * a fork-only row (before the first upgrade reconciles it).
 */
export function forkBackupSql(): string {
  const journal = `"${RELAY_MIGRATIONS_SCHEMA}"."${RELAY_MIGRATIONS_TABLE}"`;
  const forkNames = Object.keys(FORK_RENAMED_MIGRATIONS).map(literal).join(", ");
  return [
    "DO $$ DECLARE t record; has_fork_row boolean; BEGIN",
    `IF to_regclass(${literal(journal)}) IS NULL`,
    `OR to_regnamespace(${literal(FORK_BACKUP_SCHEMA)}) IS NOT NULL THEN RETURN; END IF;`,
    // Dynamic, so a database without the journal never plans this query.
    `EXECUTE ${literal(`SELECT EXISTS (SELECT 1 FROM ${journal} WHERE name IN (${forkNames}))`)} INTO has_fork_row;`,
    "IF NOT has_fork_row THEN RETURN; END IF;",
    `CREATE SCHEMA "${FORK_BACKUP_SCHEMA}";`,
    "FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP",
    `EXECUTE format('CREATE TABLE %I.%I AS TABLE public.%I', ${literal(FORK_BACKUP_SCHEMA)}, t.tablename, t.tablename);`,
    "END LOOP;",
    `CREATE TABLE "${FORK_BACKUP_SCHEMA}"."${RELAY_MIGRATIONS_TABLE}" AS TABLE ${journal};`,
    "END $$;",
  ].join("\n");
}

const migrationDatabaseUrl = Config.Redacted("DATABASE_MIGRATION_URL").pipe(
  Config.orElse(() => Config.Redacted("DATABASE_URL")),
);

const check = Effect.gen(function* () {
  const database = yield* makeWithDefaults();
  const journal = `"${RELAY_MIGRATIONS_SCHEMA}"."${RELAY_MIGRATIONS_TABLE}"`;
  const exists = yield* database.execute<{ readonly present: string | null }>(
    sql.raw(`SELECT to_regclass(${literal(journal)})::text AS present`),
  );
  const applied = exists[0]?.present
    ? (yield* database.execute<{ readonly name: string }>(
        sql.raw(`SELECT name FROM ${journal} ORDER BY id`),
      )).map((row) => row.name)
    : [];
  const appliedSet = new Set(applied.map((name) => FORK_RENAMED_MIGRATIONS[name] ?? name));
  const pending = readMigrationFiles({ migrationsFolder: RELAY_MIGRATIONS_FOLDER })
    .map((migration) => migration.name)
    .filter((name) => !appliedSet.has(name));
  const local = new Set(
    readMigrationFiles({ migrationsFolder: RELAY_MIGRATIONS_FOLDER }).map((m) => m.name),
  );
  const unknown = applied.filter((name) => !local.has(FORK_RENAMED_MIGRATIONS[name] ?? name));
  yield* Effect.logInfo("Relay migration check (read-only)").pipe(
    Effect.annotateLogs({ applied, pending, appliedButNotInThisBuild: unknown }),
  );
}).pipe(Effect.provide(PgClient.layerConfig({ url: migrationDatabaseUrl })));

const program = Effect.gen(function* () {
  const database = yield* makeWithDefaults();
  yield* database.execute(sql.raw(forkBackupSql()));
  yield* database.execute(sql.raw(forkMigrationJournalReconcileSql()));
  yield* migrate(database, {
    migrationsFolder: RELAY_MIGRATIONS_FOLDER,
    migrationsSchema: RELAY_MIGRATIONS_SCHEMA,
    migrationsTable: RELAY_MIGRATIONS_TABLE,
  });
  yield* Effect.logInfo("Relay database migrations are current.");
}).pipe(Effect.provide(PgClient.layerConfig({ url: migrationDatabaseUrl })));

if (import.meta.main) {
  NodeRuntime.runMain(process.argv.includes("--check") ? check : program);
}
