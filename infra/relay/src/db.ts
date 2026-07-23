import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { parseRelayDatabaseUrl, resolveRelayHyperdriveTls } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export const RelayDatabase = Effect.gen(function* () {
  yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });
  const databaseUrl = yield* Config.redacted("DATABASE_URL");
  const connection = parseRelayDatabaseUrl(Redacted.value(databaseUrl));
  return { connection, schema };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const { connection } = yield* RelayDatabase;
  const accessClientId = yield* Config.redacted("DATABASE_ACCESS_CLIENT_ID").pipe(Config.option);
  const accessClientSecret = yield* Config.redacted("DATABASE_ACCESS_CLIENT_SECRET").pipe(
    Config.option,
  );
  const caCertificateId = yield* Config.nonEmptyString("DATABASE_CA_CERTIFICATE_ID").pipe(
    Config.option,
  );
  if (Option.isSome(accessClientId) !== Option.isSome(accessClientSecret)) {
    return yield* Effect.die(
      new Error(
        "DATABASE_ACCESS_CLIENT_ID and DATABASE_ACCESS_CLIENT_SECRET must be configured together.",
      ),
    );
  }

  const origin =
    Option.isSome(accessClientId) && Option.isSome(accessClientSecret)
      ? {
          scheme: connection.scheme,
          host: connection.host,
          database: connection.database,
          user: connection.user,
          password: Redacted.make(connection.password),
          accessClientId: accessClientId.value,
          accessClientSecret: accessClientSecret.value,
        }
      : {
          scheme: connection.scheme,
          host: connection.host,
          port: connection.port,
          database: connection.database,
          user: connection.user,
          password: Redacted.make(connection.password),
        };

  return yield* Cloudflare.Hyperdrive("RelayHyperdrive", {
    origin,
    caching: {
      disabled: true,
    },
    mtls: resolveRelayHyperdriveTls(Option.getOrUndefined(caCertificateId)),
    originConnectionLimit: 20,
  });
});
