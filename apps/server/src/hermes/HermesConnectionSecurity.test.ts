import { describe, expect, it } from "vite-plus/test";

import {
  assessHermesConnectionSecurity,
  sanitizeHermesEndpoint,
} from "./HermesConnectionSecurity.ts";

const assess = (overrides: Partial<Parameters<typeof assessHermesConnectionSecurity>[0]> = {}) =>
  assessHermesConnectionSecurity({
    endpoint: "ws://127.0.0.1:9119/api/ws",
    gatewayToken: "local-token",
    remoteGloballyEnabled: false,
    remoteInstanceEnabled: false,
    remotePairingToken: undefined,
    ...overrides,
  });

describe("Hermes connection security", () => {
  it("preserves authenticated loopback ws behavior", () => {
    expect(assess()).toMatchObject({
      status: "ready",
      scope: "loopback",
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "local-token",
    });
  });

  it.each([
    "http://gateway.example.com/api/ws",
    "https://gateway.example.com/api/ws",
    "ws://gateway.example.com/api/ws",
    "wss://user:secret@gateway.example.com/api/ws",
    "wss://gateway.example.com/api/ws?TOKEN=secret",
  ])("rejects an insecure or credential-bearing remote endpoint: %s", (endpoint) => {
    expect(
      assess({
        endpoint,
        remoteGloballyEnabled: true,
        remoteInstanceEnabled: true,
      }),
    ).toMatchObject({ status: "blocked", code: "invalid_endpoint" });
  });

  it("requires independent global and instance remote opt-ins", () => {
    expect(assess({ endpoint: "wss://gateway.example.com/api/ws" })).toMatchObject({
      status: "blocked",
      code: "remote_disabled",
    });
    expect(
      assess({
        endpoint: "wss://gateway.example.com/api/ws",
        remoteGloballyEnabled: true,
      }),
    ).toMatchObject({ status: "blocked", code: "remote_instance_disabled" });
  });

  it("accepts a dashboard bearer token over secure remote transport", () => {
    expect(
      assess({
        endpoint: "wss://gateway.example.com/api/ws",
        remoteGloballyEnabled: true,
        remoteInstanceEnabled: true,
      }),
    ).toMatchObject({ status: "ready", scope: "remote", authToken: "local-token" });
  });

  it("uses an explicitly configured remote token when present", () => {
    expect(
      assess({
        endpoint: "wss://gateway.example.com/api/ws",
        remoteGloballyEnabled: true,
        remoteInstanceEnabled: true,
        remotePairingToken: "remote-token",
      }),
    ).toMatchObject({ status: "ready", authToken: "remote-token" });
  });

  it("requires authentication before creating a remote transport", () => {
    expect(
      assess({
        endpoint: "wss://gateway.example.com/api/ws",
        remoteGloballyEnabled: true,
        remoteInstanceEnabled: true,
        gatewayToken: undefined,
      }),
    ).toMatchObject({ status: "blocked", code: "authentication_required" });
  });

  it.each(["ticket", "access_token"])("rejects embedded %s credentials", (key) => {
    expect(assess({ endpoint: `ws://localhost:9119/api/ws?${key}=secret` })).toMatchObject({
      status: "blocked",
      code: "invalid_endpoint",
    });
  });

  it("sanitizes all query values, userinfo, and fragments in diagnostics", () => {
    const sanitized = sanitizeHermesEndpoint(
      "wss://user:password@gateway.example.com/api/ws?token=secret&workspace=private#fragment",
    );
    expect(sanitized).toBe(
      "wss://gateway.example.com/api/ws?token=%3Credacted%3E&workspace=%3Credacted%3E",
    );
  });
});
