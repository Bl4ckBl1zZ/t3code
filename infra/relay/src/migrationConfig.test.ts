import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import { migrationDatabaseUrlConfig } from "./migrationConfig.ts";

const parseMigrationDatabaseUrl = (env: Record<string, string>) =>
  migrationDatabaseUrlConfig
    .parse(ConfigProvider.fromEnv({ env }))
    .pipe(Effect.map(Redacted.value), Effect.runPromise);

describe("migrationDatabaseUrlConfig", () => {
  it("prefers the dedicated migration tunnel URL", async () => {
    await expect(
      parseMigrationDatabaseUrl({
        DATABASE_MIGRATION_URL: "postgresql://migration.example/database",
        DATABASE_URL: "postgresql://runtime.example/database",
      }),
    ).resolves.toBe("postgresql://migration.example/database");
  });

  it("falls back to DATABASE_URL for local operators", async () => {
    await expect(
      parseMigrationDatabaseUrl({
        DATABASE_URL: "postgresql://runtime.example/database",
      }),
    ).resolves.toBe("postgresql://runtime.example/database");
  });
});
