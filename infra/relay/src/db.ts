import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Alchemy from "alchemy";
import * as Drizzle from "alchemy/Drizzle";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { existingRelayHyperdriveBinding, parseRelayDatabaseUrl } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export const RelayDatabase = Effect.gen(function* () {
  yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: `${import.meta.dirname}/persistence/schema.ts`,
    out: `${import.meta.dirname}/../migrations/postgres`,
    dialect: "postgres",
  });
  const databaseUrl = yield* Config.redacted("DATABASE_URL");
  const connection = parseRelayDatabaseUrl(Redacted.value(databaseUrl));
  return { connection, schema };
});

export const RelayHyperdriveBinding = Effect.gen(function* () {
  const { connection } = yield* RelayDatabase;
  const hyperdriveId = yield* Config.nonEmptyString("DATABASE_HYPERDRIVE_ID");
  const binding = existingRelayHyperdriveBinding(hyperdriveId, connection);
  return {
    ...binding,
    devOrigin: {
      ...binding.devOrigin,
      password: Redacted.make(binding.devOrigin.password),
    },
  };
});
