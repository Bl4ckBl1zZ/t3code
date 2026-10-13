// @effect-diagnostics nodeBuiltinImport:off -- PgClient takes a node:stream Duplex for custom transports.
import * as NodeStream from "node:stream";

import { PGlite } from "@electric-sql/pglite";
import * as PgClient from "@effect/sql-pg/PgClient";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Reactivity from "effect/reactivity/Reactivity";

import {
  RELAY_MIGRATIONS_FOLDER,
  RELAY_MIGRATIONS_SCHEMA,
  RELAY_MIGRATIONS_TABLE,
} from "../../scripts/migrate.ts";
import * as RelayDb from "../db.ts";

// PostgreSQL's SSLRequest code; PGlite does not answer it, so decline TLS here.
const SSL_REQUEST_CODE = 80877103;

/** Speaks the Postgres wire protocol to an in-memory PGlite, one message batch at a time. */
function pgliteStream(pglite: PGlite): () => NodeStream.Duplex {
  return () => {
    let pending = Promise.resolve();
    const stream: NodeStream.Duplex = new NodeStream.Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        pending = pending.then(async () => {
          const bytes = new Uint8Array(chunk);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          if (bytes.length === 8 && view.getInt32(4) === SSL_REQUEST_CODE) {
            stream.push(Buffer.from("N"));
            return;
          }
          const reply = await pglite.execProtocolRaw(bytes);
          if (reply.length > 0) stream.push(Buffer.from(reply));
        });
        pending.then(() => callback(), callback);
      },
    });
    return stream;
  };
}

/**
 * The relay's real Drizzle and `@effect/sql-pg` stack over an in-memory
 * PGlite with every relay migration applied. For tests.
 */
export const layer = Layer.effect(
  RelayDb.RelayDb,
  Effect.gen(function* () {
    const pglite = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const database = new PGlite();
        await database.waitReady;
        await migrate(drizzle({ client: database }), {
          migrationsFolder: RELAY_MIGRATIONS_FOLDER,
          migrationsSchema: RELAY_MIGRATIONS_SCHEMA,
          migrationsTable: RELAY_MIGRATIONS_TABLE,
        });
        return database;
      }),
      (database) => Effect.promise(() => database.close()),
    );
    const client = yield* PgClient.makeClient({
      stream: pgliteStream(pglite),
      username: "postgres",
      database: "postgres",
      password: Redacted.make("postgres"),
      prepare: false,
    }).pipe(Effect.orDie);
    return yield* makeWithDefaults().pipe(Effect.provideService(PgClient.PgClient, client));
  }),
).pipe(Layer.provide(Reactivity.layer));
