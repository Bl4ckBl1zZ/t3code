import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isPublicFaviconHost,
  normalizeHostname,
  resolveEndpointUrl,
  type EndpointReachability,
} from "@t3tools/shared/endpointReachability";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

import { readPreparedConnection } from "~/state/session";

export type { EndpointReachability };
export { isLocalLoopbackHost, isPrivateNetworkHost, isPublicFaviconHost, normalizeHostname };

const readEnvironmentUrl = (environmentId: EnvironmentId): URL => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  environmentUrl: URL,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
    );
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  const resolvedHost = normalizedEnvironmentHost.includes(":")
    ? `[${normalizedEnvironmentHost}]`
    : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: requestedUrl ?? `${protocol}://localhost:${target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: isLocalLoopbackHost(normalizedEnvironmentHost)
      ? "direct"
      : "direct-private-network",
    environmentId,
  };
};

export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(normalizePreviewUrl(target.url));
    } catch {
      // Preserve the existing direct-navigation behavior so the preview host
      // reports malformed URL errors through its normal navigation path.
    }
    if (parsed && isLoopbackHost(parsed.hostname)) {
      const environmentUrl = readEnvironmentUrl(environmentId);
      if (parsed.hostname === "0.0.0.0" || !isLocalLoopbackHost(environmentUrl.hostname)) {
        return resolveEnvironmentPortTarget(
          environmentId,
          {
            kind: "environment-port",
            port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
            protocol: parsed.protocol === "https:" ? "https" : "http",
            path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
          },
          environmentUrl,
          target.url,
          parsed,
        );
      }
    }
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  return resolveEnvironmentPortTarget(environmentId, target, readEnvironmentUrl(environmentId));
}

/**
 * Whether this client can actually open a detected dev-server URL, and if not,
 * why.
 *
 * `resolveDiscoveredServerUrl` below swallows the failure and hands back the
 * raw loopback URL, which is right for the preview panel's own error surface
 * but wrong for a list of clickable rows: it would present a link that cannot
 * work with nothing to explain it. Callers rendering an affordance should use
 * this and disable the row instead.
 */
export function resolveEndpointReachability(
  environmentId: EnvironmentId,
  rawUrl: string,
): EndpointReachability {
  return resolveEndpointUrl({
    rawUrl,
    environmentHttpBaseUrl: readPreparedConnection(environmentId)?.httpBaseUrl ?? null,
  });
}

export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    return resolveBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: normalizedUrl,
    }).resolvedUrl;
  } catch {
    return rawUrl;
  }
}
