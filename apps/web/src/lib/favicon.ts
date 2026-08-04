/**
 * Favicon helpers for the preview tab strip and the thread's Ports panel.
 *
 * Uses Google's s2 favicon endpoint (same approach as ami's tab strip).
 * Callers should always render a `<Globe />` fallback when the returned URL
 * fails to load via an `onError` handler.
 */
import { isLoopbackHost } from "@t3tools/shared/preview";

const FAVICON_PROVIDER = "https://www.google.com/s2/favicons";

/** Address ranges that only ever resolve inside someone's own network. */
const PRIVATE_ADDRESS_PATTERN = /^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * A public favicon service can only answer for a host it can resolve itself.
 * Dev servers — the whole population of the Ports panel — live on loopback,
 * private ranges, or bare intranet names, so asking about them costs a request
 * and returns a broken image. Better to go straight to the globe fallback.
 */
function isPubliclyResolvableHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return false;
  if (hostname.endsWith(".local")) return false;
  if (PRIVATE_ADDRESS_PATTERN.test(hostname)) return false;
  // Single-label hosts (`buildbox:3000`) and bracketed IPv6 literals are
  // resolvable on the user's network, never on the provider's.
  return hostname.includes(".");
}

export function faviconUrlForOrigin(rawUrl: string | null | undefined, size = 32): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isPubliclyResolvableHost(url.hostname)) return null;
    // Hostname without the port: the provider keys on the domain, and a
    // `:8443` suffix just makes the lookup miss.
    return `${FAVICON_PROVIDER}?domain=${encodeURIComponent(url.hostname)}&sz=${size}`;
  } catch {
    return null;
  }
}
