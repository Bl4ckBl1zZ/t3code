import * as Config from "effect/Config";

export const migrationDatabaseUrlConfig = Config.redacted("DATABASE_MIGRATION_URL").pipe(
  Config.orElse(() => Config.redacted("DATABASE_URL")),
);
