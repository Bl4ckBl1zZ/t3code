import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { CLOUD_REPLAY_RECORDS } from "../cloud/http.ts";
import { DPOP_REPLAY_RECORDS } from "./dpop.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

/** Every secret-store prefix used as a single-use replay ledger. */
export const REPLAY_RECORDS = [DPOP_REPLAY_RECORDS, ...CLOUD_REPLAY_RECORDS];
const FIRST_PASS_DELAY = Duration.seconds(30);
const PASS_INTERVAL = Duration.minutes(10);

const prunePass = ServerSecretStore.removeExpired(REPLAY_RECORDS).pipe(
  Effect.flatMap(({ removed, failed }) =>
    failed > 0
      ? Effect.logWarning("Could not remove some expired replay records.", { removed, failed })
      : Effect.logDebug("Removed expired replay records.", { removed }),
  ),
  Effect.ignoreCause({ log: true }),
);

/**
 * Deletes consumed DPoP proof and cloud nonce/jti records from the secret
 * store once they can no longer block a replay. Merge into the server layer
 * graph to activate.
 */
export const layer = Layer.effectDiscard(
  Effect.forkScoped(
    prunePass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL)), Effect.delay(FIRST_PASS_DELAY)),
  ),
);
