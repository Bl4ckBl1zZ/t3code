/**
 * Decides whether a detected dev-server URL can actually be opened from the
 * client looking at it, and rewrites it when it can.
 *
 * A server announces itself as `http://localhost:5173`, which is only true on
 * the machine running it. That is usually the same machine on desktop and
 * essentially never the same machine on a phone, so the loopback host has to be
 * swapped for the environment's own address — keeping the port — before the URL
 * means anything to the client.
 *
 * Pure so both the web renderer and the mobile app can share one definition of
 * "reachable"; callers supply the environment's HTTP base URL rather than this
 * module reaching into any connection store.
 */

import { isLoopbackHost, normalizePreviewUrl } from "./preview.ts";

export type EndpointReachability =
  | {
      readonly kind: "reachable";
      readonly url: string;
      /** `direct` when the environment is this machine; otherwise routed over the LAN/tailnet. */
      readonly via: "direct" | "private-network";
    }
  | { readonly kind: "unreachable"; readonly reason: string };

/** Strips IPv6 brackets and lowercases, so classification is host-form agnostic. */
export function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

function parseIpv4Address(host: string): ReadonlyArray<number> | null {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

export function isLocalLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
}

/**
 * Hosts a client can plausibly route to without a gateway: loopback, mDNS,
 * tailnet, RFC1918, CGNAT, link-local, and IPv6 ULA/link-local.
 */
export function isPrivateNetworkHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (isLocalLoopbackHost(normalized) || normalized.endsWith(".local")) return true;
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4Address(normalized);
  if (parts) {
    return (
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  const firstIpv6Token = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false;
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  );
}

/** Re-brackets an IPv6 literal so it is valid inside a URL authority. */
function toUrlHost(hostname: string): string {
  const bare = normalizeHostname(hostname);
  return bare.includes(":") ? `[${bare}]` : bare;
}

export const ENDPOINT_UNREACHABLE_RELAY_REASON =
  "This environment is not directly reachable from this device, so its ports cannot be opened yet.";

/**
 * Resolves a detected endpoint URL against the environment serving it.
 *
 * Returns a reason rather than throwing: a list of endpoint rows needs to
 * explain why one is not clickable, not fail opaquely or — worse — hand back a
 * loopback URL that silently resolves to the wrong machine.
 */
export function resolveEndpointUrl(input: {
  readonly rawUrl: string;
  /** The environment's HTTP base URL, or null when it is not connected. */
  readonly environmentHttpBaseUrl: string | null;
}): EndpointReachability {
  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(input.rawUrl));
  } catch {
    return { kind: "unreachable", reason: "This port has no valid URL to open." };
  }

  // Non-loopback URLs are already absolute addresses; nothing to rewrite.
  if (!isLoopbackHost(parsed.hostname)) {
    return { kind: "reachable", url: parsed.toString(), via: "direct" };
  }

  if (input.environmentHttpBaseUrl === null) {
    return { kind: "unreachable", reason: "This environment is not connected." };
  }

  let environmentUrl: URL;
  try {
    environmentUrl = new URL(input.environmentHttpBaseUrl);
  } catch {
    return { kind: "unreachable", reason: "This environment has no usable address." };
  }

  // The environment is this machine, so loopback already points at it. `0.0.0.0`
  // still needs rewriting: it is a bind address and browsers refuse it.
  if (isLocalLoopbackHost(environmentUrl.hostname) && parsed.hostname !== "0.0.0.0") {
    return { kind: "reachable", url: parsed.toString(), via: "direct" };
  }

  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    return { kind: "unreachable", reason: ENDPOINT_UNREACHABLE_RELAY_REASON };
  }

  const resolved = new URL(parsed.toString());
  resolved.hostname = toUrlHost(environmentUrl.hostname);
  return {
    kind: "reachable",
    url: resolved.toString(),
    via: isLocalLoopbackHost(environmentUrl.hostname) ? "direct" : "private-network",
  };
}

/**
 * The `host:port` a client will actually hit. Mobile shows this instead of the
 * announced host, where `localhost` would name the phone rather than the server.
 */
export function endpointDisplayAddress(reachability: EndpointReachability): string | null {
  if (reachability.kind !== "reachable") return null;
  try {
    return new URL(reachability.url).host;
  } catch {
    return null;
  }
}
