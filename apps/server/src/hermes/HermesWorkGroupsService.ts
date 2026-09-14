import {
  HermesWorkError,
  type HermesWorkGroupsQueryInput,
  type HermesWorkGroupsQueryResult,
  type HermesWorkGroupsMutateInput,
  type HermesWorkGroupsMutateResult,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { HermesDashboardClient } from "./HermesDashboardClient.ts";
import {
  HermesGatewayClient,
  HermesGatewayCapabilityError,
  HermesGatewayRpcError,
  HermesGatewayMutationIndeterminateError,
  HermesGatewayMutationsBlockedError,
} from "./HermesGatewayClient.ts";
import {
  queryHermesWorkGroups,
  mutateHermesWorkGroups,
  type HermesWorkGroupsTransport,
} from "./HermesWorkGroups.ts";

export class HermesWorkGroupsService extends Context.Service<
  HermesWorkGroupsService,
  {
    readonly query: (
      input: HermesWorkGroupsQueryInput,
    ) => Effect.Effect<HermesWorkGroupsQueryResult, HermesWorkError>;
    readonly mutate: (
      input: HermesWorkGroupsMutateInput,
    ) => Effect.Effect<HermesWorkGroupsMutateResult, HermesWorkError>;
  }
>()("t3/hermes/HermesWorkGroupsService") {}

const isWorkError = Schema.is(HermesWorkError);
function failure(cause: unknown): HermesWorkError {
  if (isWorkError(cause)) return cause;
  if (
    cause instanceof HermesGatewayMutationIndeterminateError ||
    cause instanceof HermesGatewayMutationsBlockedError ||
    (cause instanceof HermesGatewayRpcError && cause.disposition === "indeterminate")
  )
    return new HermesWorkError({
      code: "indeterminate",
      message:
        "Hermes did not confirm this group operation. Refresh the group before trying again.",
    });
  if (
    cause instanceof HermesGatewayCapabilityError ||
    (cause instanceof HermesGatewayRpcError && cause.code === -32601)
  )
    return new HermesWorkError({
      code: "unsupported",
      message: "This Hermes version does not support groups.",
    });
  if (cause instanceof HermesGatewayRpcError && cause.code === -32602)
    return new HermesWorkError({
      code: "invalid_input",
      message: "Hermes rejected this group operation. Review the selected assistants and values.",
    });
  return new HermesWorkError({
    code: "unavailable",
    message: "Could not connect to Hermes groups. Check that its background service is running.",
  });
}

export interface HermesWorkGroupsClient extends HermesWorkGroupsTransport {
  connect(): Promise<unknown>;
  close(): void;
}
export const makeHermesWorkGroupsService = (
  clientFactory: (input: { endpoint: string; authToken: string }) => HermesWorkGroupsClient = (
    input,
  ) => new HermesGatewayClient({ ...input, reconnect: { maxAttempts: 0 } }),
) =>
  Effect.gen(function* () {
    const dashboard = yield* HermesDashboardClient;
    const withClient = Effect.fn("HermesWorkGroupsService.withClient")(function* <A>(
      providerInstanceId: string,
      operation: (client: HermesWorkGroupsTransport) => Promise<A>,
    ) {
      const connection = yield* dashboard.connection(providerInstanceId);
      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          clientFactory({ endpoint: connection.endpoint, authToken: connection.token }),
        ),
        (client) =>
          Effect.tryPromise({
            try: async () => {
              await client.connect();
              return await operation(client);
            },
            catch: failure,
          }),
        (client) => Effect.sync(() => client.close()),
      );
    });
    const query = Effect.fn("HermesWorkGroupsService.query")(function* (
      input: HermesWorkGroupsQueryInput,
    ) {
      return yield* withClient(input.providerInstanceId, (client) =>
        queryHermesWorkGroups(client, input),
      );
    });
    const mutate = Effect.fn("HermesWorkGroupsService.mutate")(function* (
      input: HermesWorkGroupsMutateInput,
    ) {
      return yield* withClient(input.providerInstanceId, (client) =>
        mutateHermesWorkGroups(client, input),
      );
    });
    return HermesWorkGroupsService.of({ query, mutate });
  });
export const hermesWorkGroupsServiceLayer = Layer.effect(
  HermesWorkGroupsService,
  makeHermesWorkGroupsService(),
);
