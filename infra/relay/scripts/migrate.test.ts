import * as NodeURL from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  RELAY_MIGRATIONS_FOLDER,
  RELAY_MIGRATIONS_SCHEMA,
  RELAY_MIGRATIONS_TABLE,
  forkMigrationJournalReconcileSql,
} from "./migrate.ts";

// The fork's relay migrations as of fork main b8b25db0f3, which production ran.
const FORK_MIGRATIONS_FOLDER = NodeURL.fileURLToPath(
  new URL("./testdata/fork-migrations", import.meta.url),
);
// Fork-only table the voice rebuild drops; nothing reads it after the bridge.
const FORK_ONLY_TABLE = "relay_account_integrations";

const databases: PGlite[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

const openDatabase = async () => {
  const client = new PGlite();
  databases.push(client);
  return { client, db: drizzle({ client }) };
};

type Database = Awaited<ReturnType<typeof openDatabase>>;

const migrateFolder = ({ db }: Database, migrationsFolder: string) =>
  migrate(db, {
    migrationsFolder,
    migrationsSchema: RELAY_MIGRATIONS_SCHEMA,
    migrationsTable: RELAY_MIGRATIONS_TABLE,
  });

// What scripts/migrate.ts runs against production.
const migrateRelay = async (database: Database) => {
  await database.client.exec(forkMigrationJournalReconcileSql());
  await migrateFolder(database, RELAY_MIGRATIONS_FOLDER);
};

const rows = async (database: Database, query: string) =>
  (await database.client.query<Record<string, unknown>>(query)).rows;

const describeSchema = async (database: Database) => ({
  columns: await rows(
    database,
    `SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = 'public'
     ORDER BY table_name, column_name`,
  ),
  constraints: await rows(
    database,
    `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE connamespace = 'public'::regnamespace
     ORDER BY table_name, conname`,
  ),
  indexes: await rows(
    database,
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
     ORDER BY tablename, indexname`,
  ),
});

const withoutTable = (schema: Awaited<ReturnType<typeof describeSchema>>, table: string) => ({
  columns: schema.columns.filter((row) => row.table_name !== table),
  constraints: schema.constraints.filter((row) => row.table_name !== table),
  indexes: schema.indexes.filter((row) => row.tablename !== table),
});

const journalNames = async (database: Database) =>
  (
    await rows(
      database,
      `SELECT name FROM "${RELAY_MIGRATIONS_SCHEMA}"."${RELAY_MIGRATIONS_TABLE}" ORDER BY name`,
    )
  ).map((row) => row.name);

const forkMigratedDatabase = async () => {
  const database = await openDatabase();
  await migrateFolder(database, FORK_MIGRATIONS_FOLDER);
  return database;
};

describe("relay migrations on a fork-migrated database", () => {
  it("fails without the journal reconcile, because the fork renamed managed_endpoint_recovery", async () => {
    const database = await forkMigratedDatabase();

    await expect(migrateFolder(database, RELAY_MIGRATIONS_FOLDER)).rejects.toThrow(
      /recovery_enabled_at/,
    );
  });

  it("ends in the fresh upstream schema plus the fork-only integrations table", async () => {
    const fresh = await openDatabase();
    await migrateRelay(fresh);
    const forked = await forkMigratedDatabase();
    await migrateRelay(forked);

    const freshSchema = await describeSchema(fresh);
    expect(new Set(freshSchema.columns.map((row) => row.table_name))).toEqual(
      new Set([
        "relay_agent_activity_rows",
        "relay_delivery_attempts",
        "relay_dpop_proofs",
        "relay_environment_credentials",
        "relay_environment_links",
        "relay_live_activities",
        "relay_managed_endpoint_allocations",
        "relay_managed_tunnel_limits",
        "relay_mobile_devices",
        "relay_voice_input_settings",
        "relay_voice_transcription_requests",
      ]),
    );
    const forkedSchema = await describeSchema(forked);
    expect(withoutTable(forkedSchema, FORK_ONLY_TABLE)).toEqual(freshSchema);
    expect(forkedSchema.columns.some((row) => row.table_name === FORK_ONLY_TABLE)).toBe(true);
  });

  it("records every local migration once and leaves the fork's voice row", async () => {
    const forked = await forkMigratedDatabase();
    await migrateRelay(forked);
    await migrateRelay(forked);

    const localNames = readMigrationFiles({ migrationsFolder: RELAY_MIGRATIONS_FOLDER }).map(
      (migration) => migration.name,
    );
    expect(await journalNames(forked)).toEqual(
      [...localNames, "20260731110708_add_voice_input"].toSorted(),
    );
  });

  it("keeps existing rows and accepts thread ids longer than 191 characters", async () => {
    const forked = await forkMigratedDatabase();
    await forked.client.exec(`
      INSERT INTO relay_managed_endpoint_allocations
        (user_id, environment_id, hostname, tunnel_name, created_at, updated_at,
         recovery_enabled_at, recovery_environment_public_key, generation)
      VALUES ('user', 'env', 'host.example.com', 'tunnel', 't0', 't0', 't1', 'pk', 3);
      INSERT INTO relay_mobile_devices
        (user_id, device_id, platform, ios_major_version, preferences_json, created_at, updated_at)
      VALUES ('user', 'device', 'ios', 18, '{}', 't0', 't0');
      INSERT INTO relay_voice_input_settings (user_id, settings_json, created_at, updated_at)
      VALUES ('user', '{"language":"de"}', 't0', 't0');
    `);

    await migrateRelay(forked);

    expect(
      await rows(
        forked,
        `SELECT recovery_enabled_at, recovery_environment_public_key, generation
         FROM relay_managed_endpoint_allocations`,
      ),
    ).toEqual([
      { recovery_enabled_at: "t1", recovery_environment_public_key: "pk", generation: 3 },
    ]);
    expect(
      await rows(forked, `SELECT ios_major_version, android_api_level FROM relay_mobile_devices`),
    ).toEqual([{ ios_major_version: 18, android_api_level: null }]);
    expect(await rows(forked, `SELECT settings_json FROM relay_voice_input_settings`)).toEqual([
      { settings_json: { language: "de" } },
    ]);

    const longThreadId = "t".repeat(400);
    await forked.client.query(
      `INSERT INTO relay_agent_activity_rows
         (environment_id, environment_public_key, thread_id, state_json, updated_at, created_at)
       VALUES ('env', 'pk', $1, '{}', 't0', 't0')`,
      [longThreadId],
    );
    expect(
      await rows(forked, `SELECT length(thread_id) AS length FROM relay_agent_activity_rows`),
    ).toEqual([{ length: 400 }]);
  });
});
