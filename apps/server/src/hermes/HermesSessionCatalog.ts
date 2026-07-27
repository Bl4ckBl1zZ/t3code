import {
  type HermesGatewayCompatibility,
  type HermesGatewayStoredSessionSummary,
  HermesSessionsError,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { HermesGatewayClient } from "./HermesGatewayClient.ts";

export interface HermesSessionCatalogSnapshot {
  readonly providerInstanceId: ProviderInstanceId;
  readonly profileKey: string;
  readonly compatibility: HermesGatewayCompatibility;
  readonly sessions: ReadonlyArray<HermesGatewayStoredSessionSummary>;
}

export interface HermesSessionCatalogShape {
  readonly profileKey: string;
  readonly importEnabled: boolean;
  readonly list: (
    limit: number,
  ) => Effect.Effect<HermesSessionCatalogSnapshot, HermesSessionsError>;
}

export function makeHermesSessionCatalog(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authToken: string | undefined;
  readonly profileKey: string;
  readonly importEnabled: boolean;
  readonly clientFactory?: (options: {
    readonly endpoint: string;
    readonly authToken: string;
  }) => Pick<HermesGatewayClient, "connect" | "listSessions" | "close">;
}): HermesSessionCatalogShape {
  return {
    profileKey: input.profileKey,
    importEnabled: input.importEnabled,
    list: Effect.fn("HermesSessionCatalog.list")(function* (limit) {
      if (input.authToken === undefined || input.endpoint.trim().length === 0) {
        return yield* new HermesSessionsError({
          code: "provider_not_configured",
          message: "Hermes session discovery requires a configured endpoint and gateway token.",
        });
      }
      const client =
        input.clientFactory?.({ endpoint: input.endpoint, authToken: input.authToken }) ??
        new HermesGatewayClient({
          endpoint: input.endpoint,
          authToken: input.authToken,
        });
      return yield* Effect.tryPromise({
        try: async () => {
          try {
            const compatibility = await client.connect();
            const result = await client.listSessions({
              profile: input.profileKey,
              limit,
            });
            return {
              providerInstanceId: input.providerInstanceId,
              profileKey: input.profileKey,
              compatibility,
              sessions: result.sessions,
            };
          } finally {
            client.close();
          }
        },
        catch: (cause) =>
          new HermesSessionsError({
            code: "gateway_error",
            message: cause instanceof Error ? cause.message : "Hermes session discovery failed.",
          }),
      });
    }),
  };
}
