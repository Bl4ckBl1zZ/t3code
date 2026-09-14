import * as Stream from "effect/Stream";
import {
  orchestrationV2TurnItemStatusIsTerminal,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";

/** Ignore transcript tokens and ephemeral thinking; refresh only native detail boundaries. */
export function createHermesThreadInvalidationFilter() {
  const signatures = new Map<string, string>();
  return (item: OrchestrationV2ThreadStreamItem): boolean => {
    if (item.kind === "snapshot") return true;
    if (item.kind !== "event") return false;
    const event = item.event;
    let identity: string;
    let signature: string;
    switch (event.type) {
      case "provider-session.attached":
      case "provider-session.updated":
        identity = `session:${event.payload.id}`;
        signature = JSON.stringify([
          event.payload.providerInstanceId,
          event.payload.status,
          event.payload.cwd,
        ]);
        break;
      case "provider-session.detached":
        signatures.delete(`session:${event.payload.providerSessionId}`);
        return true;
      case "thread.provider-switched":
        return true;
      case "provider-thread.updated":
        identity = `binding:${event.payload.id}`;
        signature = JSON.stringify([
          event.payload.providerInstanceId,
          event.payload.providerSessionId,
          event.payload.nativeThreadRef,
          event.payload.status,
        ]);
        break;
      case "run.created":
      case "run.updated":
        identity = `run:${event.payload.id}`;
        signature = event.payload.status;
        break;
      case "turn-item.updated":
        if (event.payload.type !== "dynamic_tool") return false;
        identity = `tool:${event.payload.id}`;
        if (!orchestrationV2TurnItemStatusIsTerminal(event.payload.status)) {
          signatures.delete(identity);
          return false;
        }
        signature = event.payload.status;
        break;
      default:
        return false;
    }
    if (signatures.get(identity) === signature) return false;
    signatures.set(identity, signature);
    if (signatures.size > 256) signatures.delete(signatures.keys().next().value!);
    return true;
  };
}

/** Flush bounded batches even when native activity never becomes quiet. */
export function batchHermesInvalidations<A, E, R>(stream: Stream.Stream<A, E, R>) {
  return stream.pipe(
    Stream.groupedWithin(256, "200 millis"),
    Stream.flatMap((events) => Stream.fromIterable(events.slice(-1))),
  );
}
