import {
  HermesWorkError,
  type HermesWorkChangeEvent,
  type HermesWorkSubscribeChangesInput,
} from "@t3tools/contracts";
import { Effect, Queue, Stream } from "effect";
import { HermesGatewayClient } from "./HermesGatewayClient.ts";

export type HermesWorkChangesClient = Pick<
  HermesGatewayClient,
  "close" | "onEvent" | "onReconnected"
> & { connect(): Promise<unknown> };

/** A scoped native watcher carries invalidations, never conversation content. */
export const subscribeHermesWorkChanges = (
  dashboard: {
    readonly connection: (
      providerInstanceId: string,
    ) => Effect.Effect<{ readonly endpoint: string; readonly token: string }, HermesWorkError>;
  },
  input: HermesWorkSubscribeChangesInput,
  clientFactory: (options: { endpoint: string; authToken: string }) => HermesWorkChangesClient = (
    options,
  ) => new HermesGatewayClient(options),
) =>
  Stream.callback<HermesWorkChangeEvent, HermesWorkError>(
    (queue) =>
      Effect.gen(function* () {
        const connection = yield* dashboard.connection(input.providerInstanceId);
        const client = yield* Effect.acquireRelease(
          Effect.sync(() =>
            clientFactory({ endpoint: connection.endpoint, authToken: connection.token }),
          ),
          (client) => Effect.sync(() => client.close()),
        );
        const publish = (kind: HermesWorkChangeEvent["kind"]) => {
          Queue.offerUnsafe(queue, { providerInstanceId: input.providerInstanceId, kind });
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const offEvent = client.onEvent((event) => {
              const kind = event.frame.params.type;
              if (kind === "cron.changed" || kind === "sessions.changed") publish(kind);
            });
            const offReconnect = client.onReconnected(() => publish("reconnected"));
            return () => {
              offEvent();
              offReconnect();
            };
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        yield* Effect.tryPromise({
          try: () => client.connect(),
          catch: () =>
            new HermesWorkError({
              code: "unavailable",
              message: "Could not watch Hermes changes. Reconnect to refresh its state.",
            }),
        });
        // Close the gap between the initial HTTP snapshot and opening the native watcher.
        publish("reconnected");
      }).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
    { bufferSize: 16, strategy: "sliding" },
  );
