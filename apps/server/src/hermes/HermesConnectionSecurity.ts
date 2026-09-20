export const HERMES_REMOTE_PAIRING_TOKEN_ENV = "HERMES_REMOTE_PAIRING_TOKEN";

export type HermesEndpointScope = "loopback" | "remote";

export type HermesConnectionSecurityCode =
  | "invalid_endpoint"
  | "remote_disabled"
  | "remote_instance_disabled"
  | "authentication_required";

export type HermesConnectionSecurityAssessment =
  | {
      readonly status: "ready";
      readonly scope: HermesEndpointScope;
      readonly endpoint: string;
      readonly diagnosticEndpoint: string;
      readonly authToken: string;
    }
  | {
      readonly status: "blocked" | "unsupported";
      readonly scope: HermesEndpointScope | undefined;
      readonly code: HermesConnectionSecurityCode;
      readonly diagnosticEndpoint: string;
      readonly message: string;
    };

export interface HermesConnectionSecurityInput {
  readonly endpoint: string;
  readonly gatewayToken: string | undefined;
  readonly remoteGloballyEnabled: boolean;
  readonly remoteInstanceEnabled: boolean;
  readonly remotePairingToken: string | undefined;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function sanitizeHermesEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "<invalid-endpoint>";
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  for (const key of new Set(parsed.searchParams.keys())) {
    parsed.searchParams.set(key, "<redacted>");
  }
  return parsed.toString();
}

export function hermesEndpointScope(endpoint: string): HermesEndpointScope | undefined {
  try {
    return LOOPBACK_HOSTS.has(new URL(endpoint).hostname) ? "loopback" : "remote";
  } catch {
    return undefined;
  }
}

export function isRemoteHermesEndpoint(endpoint: string): boolean {
  return hermesEndpointScope(endpoint) === "remote";
}

export function assessHermesConnectionSecurity(
  input: HermesConnectionSecurityInput,
): HermesConnectionSecurityAssessment {
  const diagnosticEndpoint = sanitizeHermesEndpoint(input.endpoint);
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    return blocked(
      "invalid_endpoint",
      undefined,
      diagnosticEndpoint,
      "Hermes endpoint must be a valid WebSocket URL.",
    );
  }

  const scope: HermesEndpointScope = LOOPBACK_HOSTS.has(endpoint.hostname) ? "loopback" : "remote";
  const hasQueryCredential = [...endpoint.searchParams.keys()].some((key) =>
    ["token", "ticket", "access_token"].includes(key.toLowerCase()),
  );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    hasQueryCredential ||
    (scope === "loopback"
      ? !["ws:", "wss:"].includes(endpoint.protocol)
      : endpoint.protocol !== "wss:")
  ) {
    return blocked(
      "invalid_endpoint",
      scope,
      diagnosticEndpoint,
      scope === "loopback"
        ? "Loopback Hermes endpoints must use credential-free ws:// or wss://."
        : "Remote Hermes endpoints must use credential-free wss://.",
    );
  }

  if (scope === "loopback") {
    const gatewayToken = input.gatewayToken?.trim();
    if (!gatewayToken) {
      return blocked(
        "invalid_endpoint",
        scope,
        diagnosticEndpoint,
        "Loopback Hermes requires a sensitive HERMES_GATEWAY_TOKEN.",
      );
    }
    return {
      status: "ready",
      scope,
      endpoint: endpoint.toString(),
      diagnosticEndpoint,
      authToken: gatewayToken,
    };
  }

  if (!input.remoteGloballyEnabled) {
    return blocked(
      "remote_disabled",
      scope,
      diagnosticEndpoint,
      "Remote Hermes is disabled by the independent server kill switch.",
    );
  }
  if (!input.remoteInstanceEnabled) {
    return blocked(
      "remote_instance_disabled",
      scope,
      diagnosticEndpoint,
      "This Hermes instance has not explicitly enabled remote access.",
    );
  }

  const authToken = input.remotePairingToken?.trim() || input.gatewayToken?.trim();
  if (!authToken) {
    return blocked(
      "authentication_required",
      scope,
      diagnosticEndpoint,
      "Remote Hermes requires a sensitive dashboard bearer token.",
    );
  }

  // The dashboard authenticates HTTPS management requests with this bearer
  // token and issues single-use tickets for WebSocket connections. TLS trust is
  // whatever the platform's certificate authorities say: T3 pins nothing here,
  // so a remote endpoint needs a certificate the host already trusts.
  return {
    status: "ready",
    scope,
    endpoint: endpoint.toString(),
    diagnosticEndpoint,
    authToken,
  };
}

function blocked(
  code: HermesConnectionSecurityCode,
  scope: HermesEndpointScope | undefined,
  diagnosticEndpoint: string,
  message: string,
): HermesConnectionSecurityAssessment {
  return { status: "blocked", scope, code, diagnosticEndpoint, message };
}
