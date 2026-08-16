import type { ProjectScript } from "@t3tools/contracts";
import type { SFSymbol } from "expo-symbols";

import type { MobileThreadEndpoint } from "../../state/use-thread-endpoints";

/**
 * Presentation for the thread's Ports header menu.
 *
 * Mobile inverts the desktop hierarchy: the name leads and the address follows.
 * A phone is never the machine running the server, so the announced
 * `localhost:5173` names the handset and would be a lie — only the *resolved*
 * address is worth showing, and only once it is known to be reachable.
 */

/** Tint applied to the toolbar icon once something is actually serving. */
export const PORTS_LIVE_TINT = "#10b981";

export function portsMenuTintColor(
  endpoints: ReadonlyArray<MobileThreadEndpoint>,
): string | undefined {
  return endpoints.some((endpoint) => endpoint.status === "live") ? PORTS_LIVE_TINT : undefined;
}

/**
 * Neutral wording: rows can be starting or no longer responding, so describing
 * them all as "serving" would announce something untrue.
 */
export function portsMenuAccessibilityLabel(
  endpoints: ReadonlyArray<MobileThreadEndpoint>,
): string {
  if (endpoints.length === 1) return "1 port in this thread";
  return `${endpoints.length} ports in this thread`;
}

/** SF Symbol per endpoint state, so the list reads without relying on colour. */
export function portEndpointIcon(endpoint: MobileThreadEndpoint): SFSymbol {
  if (endpoint.reachability.kind === "unreachable") return "exclamationmark.triangle";
  if (endpoint.status === "starting") return "clock";
  if (endpoint.status === "stale") return "moon.zzz";
  // Pinned rows keep the pin while idle: nothing is expected to be serving a
  // configured address, so the sleeping icon every other idle row gets would
  // read as a fault rather than as the project's standing address.
  if (endpoint.pinned) return "pin.fill";
  return endpoint.status === "idle" ? "moon.zzz" : "globe";
}

/**
 * Primary line: what the user recognises. The script they ran, else the process
 * serving it, else the bare port.
 */
export function portEndpointLabel(
  endpoint: MobileThreadEndpoint,
  scripts: ReadonlyArray<ProjectScript>,
): string {
  const script = scripts.find((candidate) => candidate.id === endpoint.scriptId);
  if (script) return script.name;
  if (endpoint.processName && endpoint.processName.trim().length > 0) {
    return endpoint.processName;
  }
  // A pinned remote origin is named by its host, never by its port: nothing
  // announced it, so there is no script or process to name it after, and
  // "Port 443" says nothing about which host the row would open.
  if (endpoint.pinned && !endpoint.local) return endpoint.host;
  return `Port ${endpoint.port}`;
}

/**
 * Secondary line: the address this device will actually hit, or why it cannot.
 * Never the announced URL — that is the one thing guaranteed to be wrong here.
 */
export function portEndpointSubtitle(endpoint: MobileThreadEndpoint): string {
  if (endpoint.reachability.kind === "unreachable") return endpoint.reachability.reason;
  if (endpoint.status === "starting") return "Starting…";
  const address = endpoint.displayAddress ?? `port ${endpoint.port}`;
  if (endpoint.status === "stale") return `${address} · no longer responding`;
  if (endpoint.status !== "idle") return endpoint.pinned ? `Pinned · ${address}` : address;
  // Both liveness signals only ever see the machine running the environment, so
  // "not running" is a claim only a local endpoint earns. A pinned remote origin
  // — a tunnel, a staging host — is reported as what it is: configuration.
  return endpoint.local ? `${address} · not running` : "Pinned";
}

/** Endpoints that can be opened right now, in menu order. */
export function openableEndpoints(
  endpoints: ReadonlyArray<MobileThreadEndpoint>,
): ReadonlyArray<MobileThreadEndpoint> {
  return endpoints.filter(
    (endpoint) => endpoint.reachability.kind === "reachable" && endpoint.status !== "stale",
  );
}
