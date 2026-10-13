// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "./src/db.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

// Self-hosted stack: PostgreSQL and its Hyperdrive config already exist and
// are referenced by DATABASE_HYPERDRIVE_ID; `scripts/migrate.ts` migrates the
// database before each deploy. No tracing backend is provisioned.
export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* RelayDb.RelaySchema;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const api = yield* RelayWorker.Api;

    return {
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
