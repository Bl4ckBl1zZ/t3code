import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import { Effect, Layer, Schema } from "effect";
import { HermesSettings } from "@t3tools/contracts";
import { HermesDashboardClient } from "./HermesDashboardClient.ts";
import { HermesGatewayMutationIndeterminateError } from "./HermesGatewayClient.ts";
import {
  HermesWorkGroupsService,
  makeHermesWorkGroupsService,
  type HermesWorkGroupsClient,
} from "./HermesWorkGroupsService.ts";
const defaultSettings = Schema.decodeUnknownSync(HermesSettings)({});
const dashboard = Layer.succeed(HermesDashboardClient, {
  connection: () =>
    Effect.succeed({
      providerInstanceId: "hermes",
      displayName: "Hermes",
      profileKey: "default",
      endpoint: "ws://127.0.0.1:9119/api/ws",
      token: "secret",
      settings: defaultSettings,
    }),
  connections: () => Effect.succeed({ connections: [] }),
  request: () => Effect.succeed(null),
});
const layer = (client: HermesWorkGroupsClient) =>
  Layer.effect(
    HermesWorkGroupsService,
    makeHermesWorkGroupsService(() => client),
  ).pipe(Layer.provide(dashboard));
describe("HermesWorkGroupsService", () => {
  it.effect("closes the native connection after retrieving groups", () =>
    Effect.gen(function* () {
      const client = {
        connect: vi.fn().mockResolvedValue({}),
        close: vi.fn(),
        read: vi.fn().mockResolvedValue({ rooms: [], next_offset: null }),
        mutate: vi.fn(),
      };
      const result = yield* Effect.gen(function* () {
        const service = yield* HermesWorkGroupsService;
        return yield* service.query({ providerInstanceId: "hermes", profile: "research" });
      }).pipe(Effect.provide(layer(client)));
      expect(result.groups).toEqual([]);
      expect(client.close).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("closes failed mutation connections without retrying uncertain work", () =>
    Effect.gen(function* () {
      const client = {
        connect: vi.fn().mockResolvedValue({}),
        close: vi.fn(),
        read: vi.fn(),
        mutate: vi
          .fn()
          .mockRejectedValue(new HermesGatewayMutationIndeterminateError("op", "groups.stop")),
      };
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          const service = yield* HermesWorkGroupsService;
          return yield* service.mutate({
            providerInstanceId: "hermes",
            profile: "research",
            operationId: "op",
            command: { type: "stop", roomId: "room" },
          });
        }).pipe(Effect.provide(layer(client))),
      );
      expect(error.code).toBe("indeterminate");
      expect(client.mutate).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
    }),
  );
});
