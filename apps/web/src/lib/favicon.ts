import { isPublicFaviconHost } from "~/browser/browserTargetResolver";

/**
 * Favicon helpers for the preview tab strip and the thread's Ports panel.
 *
 * Uses Google's s2 favicon endpoint (same approach as ami's tab strip).
 * Callers should always render a `<Globe />` fallback when the returned URL
 * fails to load via an `onError` handler.
 */
const FAVICON_PROVIDER = "https://www.google.com/s2/favicons";

export function faviconUrlForOrigin(rawUrl: string | null | undefined, size = 32): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // A public favicon service can only answer for a host it can resolve
    // itself. Dev servers — the whole population of the Ports panel — live on
    // loopback, private ranges, or bare intranet names, so asking about them
    // costs a request, returns a broken image, and leaks the hostname.
    if (!isPublicFaviconHost(url.hostname)) return null;
    // Hostname without the port: the provider keys on the domain, and a
    // `:8443` suffix just makes the lookup miss.
    return `${FAVICON_PROVIDER}?domain=${encodeURIComponent(url.hostname)}&sz=${size}`;
  } catch {
    return null;
  }
}
