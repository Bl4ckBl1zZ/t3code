import { type ProjectScript } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inferPreviewDevServerUrl,
  normalizePreviewUrl,
  resolvePreviewUrl,
  resolveReachablePreviewUrl,
} from "./previewUrls";
import { useUiStateStore } from "./uiStateStore";

function script(command: string): ProjectScript {
  return {
    id: command,
    name: command,
    command,
    icon: "play",
    runOnWorktreeCreate: false,
  };
}

function installWindow(url: string, desktopBridge?: unknown) {
  vi.stubGlobal("window", {
    location: new URL(url),
    ...(desktopBridge ? { desktopBridge } : {}),
  });
}

function endpoint(input: {
  readonly id: string;
  readonly httpBaseUrl: string;
  readonly reachability: "loopback" | "private-network" | "lan";
  readonly isDefault?: boolean;
}) {
  return {
    id: input.id,
    label: input.id,
    provider: {
      id: input.id.startsWith("tailscale-") ? "tailscale" : "desktop-core",
      label: input.id.startsWith("tailscale-") ? "Tailscale" : "Desktop",
      kind: input.id.startsWith("tailscale-") ? "private-network" : "core",
      isAddon: input.id.startsWith("tailscale-"),
    },
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.httpBaseUrl.replace(/^http/u, "ws"),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp: input.httpBaseUrl.startsWith("https:")
        ? "compatible"
        : "mixed-content-blocked",
      desktopApp: "compatible",
    },
    source: "desktop-core",
    status: "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
  } as const;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
});

describe("inferPreviewDevServerUrl", () => {
  it("uses explicit script ports", () => {
    expect(inferPreviewDevServerUrl([script("pnpm dev --port 4173")])).toBe(
      "http://localhost:4173/",
    );
  });

  it("uses common framework defaults", () => {
    expect(inferPreviewDevServerUrl([script("pnpm next dev")])).toBe("http://localhost:3000/");
    expect(inferPreviewDevServerUrl([script("pnpm vite --host 0.0.0.0")])).toBe(
      "http://localhost:5173/",
    );
  });
});

describe("normalizePreviewUrl", () => {
  it("normalizes common localhost shorthand", () => {
    expect(normalizePreviewUrl(" localhost:4173/app ")).toBe("http://localhost:4173/app");
    expect(normalizePreviewUrl("localhost")).toBe("http://localhost");
    expect(normalizePreviewUrl(":5173")).toBe("http://localhost:5173");
  });

  it("preserves absolute and root-relative URLs", () => {
    expect(normalizePreviewUrl("https://preview.example.test/app")).toBe(
      "https://preview.example.test/app",
    );
    expect(normalizePreviewUrl("/preview")).toBe("/preview");
  });
});

describe("resolvePreviewUrl", () => {
  it("uses the project preview URL before detected or inferred URLs", () => {
    expect(
      resolvePreviewUrl({
        projectPreviewUrl: "localhost:4444",
        detectedDevServerUrl: "http://localhost:5173/",
        scripts: [script("pnpm next dev")],
      }),
    ).toBe("http://localhost:4444");
  });

  it("falls back to detected URLs but does not invent openable default ports", () => {
    expect(
      resolvePreviewUrl({
        detectedDevServerUrl: "http://localhost:5173/",
        scripts: [script("pnpm next dev")],
      }),
    ).toBe("http://localhost:5173/");

    expect(
      resolvePreviewUrl({
        detectedDevServerUrl: null,
        scripts: [script("pnpm next dev")],
      }),
    ).toBe("");
  });
});

describe("resolveReachablePreviewUrl", () => {
  it("rewrites loopback dev-server URLs through the remote browser origin", async () => {
    installWindow("http://100.105.249.96:3773/t3code/thread");

    await expect(resolveReachablePreviewUrl("http://localhost:3000/")).resolves.toBe(
      "http://100.105.249.96:3000/",
    );
  });

  it("prefers the remote browser origin over a loopback primary target", async () => {
    installWindow("http://100.105.249.96:3773/t3code/thread", {
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    });

    await expect(resolveReachablePreviewUrl("http://localhost:3000/")).resolves.toBe(
      "http://100.105.249.96:3000/",
    );
  });

  it("uses the default advertised Tailscale IP endpoint when desktop provides one", async () => {
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: "tailscale:ip:http" });
    installWindow("http://127.0.0.1:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          endpoint({
            id: "desktop-loopback:3773",
            httpBaseUrl: "http://127.0.0.1:3773/",
            reachability: "loopback",
          }),
          endpoint({
            id: "tailscale-ip:100.105.249.96",
            httpBaseUrl: "http://100.105.249.96:3773/",
            reachability: "private-network",
          }),
        ]),
    });

    await expect(resolveReachablePreviewUrl("http://localhost:5173/")).resolves.toBe(
      "http://100.105.249.96:5173/",
    );
  });

  it("uses the Tailscale HTTPS hostname when Tailscale IP is the saved default and HTTPS is enabled", async () => {
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: "tailscale:ip:http" });
    installWindow("http://127.0.0.1:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          endpoint({
            id: "desktop-loopback:3773",
            httpBaseUrl: "http://127.0.0.1:3773/",
            reachability: "loopback",
          }),
          endpoint({
            id: "tailscale-ip:100.105.249.96",
            httpBaseUrl: "http://100.105.249.96:3773/",
            reachability: "private-network",
          }),
          endpoint({
            id: "tailscale-magicdns:https://desktop.tail.ts.net/",
            httpBaseUrl: "https://desktop.tail.ts.net/",
            reachability: "private-network",
          }),
        ]),
    });

    await expect(resolveReachablePreviewUrl("http://localhost:5173/")).resolves.toBe(
      "http://desktop.tail.ts.net:5173/",
    );
  });

  it("uses the current remote browser origin before a Tailscale IP fallback", async () => {
    installWindow("http://100.105.249.97:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          endpoint({
            id: "desktop-loopback:3773",
            httpBaseUrl: "http://127.0.0.1:3773/",
            reachability: "loopback",
          }),
          endpoint({
            id: "tailscale-ip:100.105.249.96",
            httpBaseUrl: "http://100.105.249.96:3773/",
            reachability: "private-network",
          }),
        ]),
    });

    await expect(resolveReachablePreviewUrl("http://localhost:5173/")).resolves.toBe(
      "http://100.105.249.97:5173/",
    );
  });

  it("uses the active environment host before desktop advertised endpoints", async () => {
    installWindow("http://127.0.0.1:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          endpoint({
            id: "tailscale-ip:100.105.249.96",
            httpBaseUrl: "http://100.105.249.96:3773/",
            reachability: "private-network",
          }),
        ]),
    });

    await expect(
      resolveReachablePreviewUrl("http://localhost:5173/", {
        environmentHttpBaseUrl: "http://100.105.249.97:3773/",
      }),
    ).resolves.toBe("http://100.105.249.97:5173/");
  });

  it("keeps localhost when only loopback endpoints are available", async () => {
    installWindow("http://127.0.0.1:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          endpoint({
            id: "desktop-loopback:3773",
            httpBaseUrl: "http://127.0.0.1:3773/",
            reachability: "loopback",
            isDefault: true,
          }),
        ]),
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    });

    await expect(resolveReachablePreviewUrl("http://localhost:5173/")).resolves.toBe(
      "http://localhost:5173/",
    );
  });

  it("does not rewrite already remote dev-server URLs", async () => {
    installWindow("http://100.105.249.96:3773/t3code/thread");

    await expect(resolveReachablePreviewUrl("http://preview.example.test:3000/")).resolves.toBe(
      "http://preview.example.test:3000/",
    );
  });
});
