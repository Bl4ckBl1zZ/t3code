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
import { WILDCARD_BIND_HOSTS } from "./terminalUrlDetection.ts";

export type EndpointReachability =
  | {
      readonly kind: "reachable";
      readonly url: string;
      /** `direct` when the environment is this machine; otherwise routed over the LAN/tailnet. */
      readonly via: "direct" | "private-network";
    }
  | { readonly kind: "unreachable"; readonly reason: string };

/**
 * Strips IPv6 brackets, lowercases, and drops trailing dots, so classification
 * is host-form agnostic. A trailing dot is a valid absolute DNS name and must
 * not let `127.0.0.1.` slip past a loopback check.
 */
export function normalizeHostname(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/u, "");
}

function parseIpv4Address(host: string): ReadonlyArray<number> | null {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function parseIpv4MappedIpv6Address(host: string): ReadonlyArray<number> | null {
  const normalized = normalizeHostname(host);
  if (!normalized.startsWith("::ffff:")) return null;
  const suffix = normalized.slice("::ffff:".length);
  const dotted = parseIpv4Address(suffix);
  if (dotted) return dotted;
  const hextets = suffix.split(":");
  if (hextets.length !== 2 || hextets.some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
  const high = Number.parseInt(hextets[0]!, 16);
  const low = Number.parseInt(hextets[1]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

function parseIpv6Address(host: string): ReadonlyArray<number> | null {
  const normalized = normalizeHostname(host);
  if (!normalized.includes(":")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  if ([...head, ...tail].some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...head, ...Array.from({ length: missing }, () => "0"), ...tail].map((part) =>
    Number.parseInt(part, 16),
  );
}

function ipv6PrefixMatches(
  address: ReadonlyArray<number>,
  prefix: ReadonlyArray<number>,
  prefixLength: number,
): boolean {
  const fullHextets = Math.floor(prefixLength / 16);
  if (address.slice(0, fullHextets).some((part, index) => part !== prefix[index])) return false;
  const remainingBits = prefixLength % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (address[fullHextets]! & mask) === (prefix[fullHextets]! & mask);
}

function isPrivateIpv4Address(parts: ReadonlyArray<number>): boolean {
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 198 && parts[1]! >= 18 && parts[1]! <= 19)
  );
}

function isSpecialPurposeIpv4Address(parts: ReadonlyArray<number>): boolean {
  return (
    isPrivateIpv4Address(parts) ||
    parts[0]! >= 224 ||
    // Deliberately suppress the whole protocol-assignment block. IANA marks
    // .9 and .10 globally reachable, but privacy-safe false negatives are
    // preferable to disclosing another special-purpose address by mistake.
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
    (parts[0] === 192 && parts[1] === 88 && parts[2] === 99) ||
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
  );
}

export function isLocalLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
}

/**
 * Hosts a client can plausibly route to without a gateway: loopback, mDNS,
 * tailnet, RFC1918, CGNAT, link-local, benchmarking, single-label intranet
 * names, and IPv6 ULA/link-local.
 */
export function isPrivateNetworkHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (
    normalized === "::" ||
    isLocalLoopbackHost(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "home.arpa" ||
    normalized.endsWith(".home.arpa") ||
    (!normalized.includes(".") && !normalized.includes(":"))
  ) {
    return true;
  }
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4Address(normalized) ?? parseIpv4MappedIpv6Address(normalized);
  if (parts) return isPrivateIpv4Address(parts);
  const firstIpv6Token = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false;
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  );
}

/** Whether a hostname is eligible to be disclosed to a public favicon provider. */
export function isPublicFaviconHost(host: string): boolean {
  // A single trailing dot is a valid absolute DNS name. Repeated trailing
  // dots are malformed and can conceal legacy numeric forms such as 127.1.
  if (host.endsWith("..")) return false;
  const normalized = normalizeHostname(host);
  if (isPrivateNetworkHost(normalized)) return false;
  if (
    [".alt", ".example", ".internal", ".invalid", ".onion", ".test"].some(
      (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
    )
  ) {
    return false;
  }
  const ipv4 = parseIpv4Address(normalized) ?? parseIpv4MappedIpv6Address(normalized);
  if (ipv4) return !isSpecialPurposeIpv4Address(ipv4);
  if (!normalized.includes(":")) return true;
  const ipv6 = parseIpv6Address(normalized);
  if (!ipv6) return false;
  if (ipv6PrefixMatches(ipv6, [0x0064, 0xff9b, 0, 0, 0, 0, 0, 0], 96)) {
    const embeddedIpv4 = [ipv6[6]! >>> 8, ipv6[6]! & 0xff, ipv6[7]! >>> 8, ipv6[7]! & 0xff];
    return !isSpecialPurposeIpv4Address(embeddedIpv4);
  }
  const first = ipv6[0]!;
  if ((first & 0xe000) !== 0x2000) return false;
  if (ipv6PrefixMatches(ipv6, [0x2001, 0, 0, 0, 0, 0, 0, 0], 23)) {
    const publicProtocolAssignment =
      (ipv6[1] === 1 &&
        ipv6.slice(2, 7).every((part) => part === 0) &&
        [1, 2, 3].includes(ipv6[7]!)) ||
      ipv6PrefixMatches(ipv6, [0x2001, 3, 0, 0, 0, 0, 0, 0], 32) ||
      ipv6PrefixMatches(ipv6, [0x2001, 4, 0x0112, 0, 0, 0, 0, 0], 48) ||
      ipv6PrefixMatches(ipv6, [0x2001, 0x20, 0, 0, 0, 0, 0, 0], 28) ||
      ipv6PrefixMatches(ipv6, [0x2001, 0x30, 0, 0, 0, 0, 0, 0], 28);
    return publicProtocolAssignment;
  }
  if (ipv6PrefixMatches(ipv6, [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32)) return false;
  if (ipv6PrefixMatches(ipv6, [0x2002, 0, 0, 0, 0, 0, 0, 0], 16)) return false;
  if (first === 0x3fff && (ipv6[1]! & 0xf000) === 0) return false;
  return true;
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

  // A wildcard bind is an interface selector, not a destination — browsers
  // refuse it — so it always needs rewriting even though `::` is not itself
  // classified as a loopback host.
  const isWildcardBind = WILDCARD_BIND_HOSTS.has(parsed.hostname);

  // Non-loopback URLs are already absolute addresses; nothing to rewrite.
  if (!isLoopbackHost(parsed.hostname) && !isWildcardBind) {
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

  // The environment is this machine, so loopback already points at it. A
  // wildcard bind still needs rewriting: it is an interface selector, not a
  // destination, and browsers refuse it.
  if (isLocalLoopbackHost(environmentUrl.hostname) && !isWildcardBind) {
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
