#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PgClient from "@effect/sql-pg/PgClient";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Effect from "effect/Effect";

import { migrationDatabaseUrlConfig } from "../src/migrationConfig.ts";

const migrationsFolder = new URL("../migrations/postgres", import.meta.url).pathname;

const program = Effect.gen(function* () {
  const database = yield* makeWithDefaults();
  yield* migrate(database, {
    migrationsFolder,
    migrationsTable: "relay_migrations",
  });
  yield* Effect.logInfo("Relay database migrations are current.");
}).pipe(
  Effect.provide(
    PgClient.layerConfig({
      url: migrationDatabaseUrlConfig,
    }),
  ),
);

NodeRuntime.runMain(program);
