import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import { ConnectionBlockedError } from "./model.ts";

export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  // A server that names no version predates negotiation. Upstream reads that
  // as version 1, a protocol its clients genuinely cannot speak; here every
  // such server already speaks this wire, so blocking would strand every
  // deployment that has not been updated yet -- including remote, Tailscale
  // and T3 Connect ones the user cannot reach from the client.
  const serverProtocolVersion = descriptor.orchestrationProtocolVersion;
  if (
    serverProtocolVersion === undefined ||
    serverProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION
  ) {
    return null;
  }
  return new ConnectionBlockedError({
    reason: "unsupported",
    detail:
      serverProtocolVersion > ORCHESTRATION_PROTOCOL_VERSION
        ? `This client is not supported by this server. Update your app or use a compatible release to connect to ${descriptor.label}.`
        : `This client requires a newer server. Update T3 Code on ${descriptor.label} to connect.`,
  });
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}
