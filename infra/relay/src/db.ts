import type * as CloudflareRuntime from "@cloudflare/workers-types";
import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

/**
 * Regenerates migrations from `schema.ts` on a local deploy. The database is
 * self-hosted, so `scripts/migrate.ts` applies them before each deploy.
 */
export const RelaySchema = Drizzle.Schema("RelaySchema", {
  schema: "./src/persistence/schema.ts",
  out: "./migrations/postgres",
  dialect: "postgres",
});

const RELAY_HYPERDRIVE_BINDING = "RELAY_HYPERDRIVE";

/**
 * Binds the existing `DATABASE_HYPERDRIVE_ID` config instead of owning it: Alchemy cannot
 * describe its Workers VPC route to the private PostgreSQL, and keeping it outside never
 * binds the database password into the Worker.
 */
export const RelayHyperdrive = Effect.gen(function* () {
  const hyperdriveId = yield* Config.NonEmptyString("DATABASE_HYPERDRIVE_ID");
  const worker = yield* Cloudflare.Worker;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    yield* worker.bind(RELAY_HYPERDRIVE_BINDING, {
      bindings: [{ type: "hyperdrive", name: RELAY_HYPERDRIVE_BINDING, id: hyperdriveId }],
    });
  }
  const environment = yield* Cloudflare.WorkerEnvironment;
  return {
    connectionString: Effect.sync(() =>
      Redacted.make(
        (environment as Record<string, CloudflareRuntime.Hyperdrive>)[RELAY_HYPERDRIVE_BINDING]!
          .connectionString,
      ),
    ),
  };
});
