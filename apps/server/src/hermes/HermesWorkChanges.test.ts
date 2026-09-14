import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { subscribeHermesWorkChanges, type HermesWorkChangesClient } from "./HermesWorkChanges.ts";
import type { HermesGatewayOrderedEvent } from "./HermesGatewayClient.ts";

const connection = () => Effect.succeed({ endpoint: "ws://127.0.0.1:8888/api/ws", token: "test" });
const event = (type: string): HermesGatewayOrderedEvent => ({
  transportSequence: 1,
  sessionSequence: 1,
  sessionId: undefined,
  eventId: undefined,
  eventSequence: undefined,
  emittedAt: undefined,
  sessionKey: undefined,
  runId: undefined,
  messageId: undefined,
  cursor: undefined,
  mutationId: undefined,
  frame: { jsonrpc: "2.0", method: "event", params: { type } },
});
it.effect(
  "forwards native global changes and reconnects, filters transcript, and releases watcher",
  () =>
    Effect.gen(function* () {
      let onEvent: Parameters<HermesWorkChangesClient["onEvent"]>[0] = () => {};
      let onReconnect: Parameters<HermesWorkChangesClient["onReconnected"]>[0] = () => {};
      let closed = false;
      let unsubscribed = 0;
      const result = yield* subscribeHermesWorkChanges(
        { connection },
        { providerInstanceId: "hermes" },
        () => ({
          onEvent: (listener) => {
            onEvent = listener;
            return () => {
              unsubscribed++;
            };
          },
          onReconnected: (listener) => {
            onReconnect = listener;
            return () => {
              unsubscribed++;
            };
          },
          connect: async () => {
            await onEvent(event("message.delta"));
            await onEvent(event("cron.changed"));
            await onEvent(event("sessions.changed"));
            await onReconnect({ epochChanged: true });
          },
          close: () => {
            closed = true;
          },
        }),
      ).pipe(Stream.take(4), Stream.runCollect);
      expect(result).toEqual([
        { providerInstanceId: "hermes", kind: "cron.changed" },
        { providerInstanceId: "hermes", kind: "sessions.changed" },
        { providerInstanceId: "hermes", kind: "reconnected" },
        { providerInstanceId: "hermes", kind: "reconnected" },
      ]);
      expect(closed).toBe(true);
      expect(unsubscribed).toBe(2);
    }),
);
it.effect("releases native watcher after connection failure", () =>
  Effect.gen(function* () {
    let closed = false;
    const result = yield* subscribeHermesWorkChanges(
      { connection },
      { providerInstanceId: "hermes" },
      () => ({
        onEvent: () => () => {},
        onReconnected: () => () => {},
        connect: async () => {
          throw new Error("secret endpoint");
        },
        close: () => {
          closed = true;
        },
      }),
    ).pipe(Stream.runCollect, Effect.result);
    expect(result._tag).toBe("Failure");
    expect(closed).toBe(true);
    if (result._tag === "Failure") {
      expect(result.failure.message).toBe(
        "Could not watch Hermes changes. Reconnect to refresh its state.",
      );
    }
  }),
);
