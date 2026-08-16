import { describe, expect, it } from "vite-plus/test";

import {
  endpointDisplayAddress,
  isPrivateNetworkHost,
  resolveEndpointUrl,
} from "./endpointReachability.ts";

const resolve = (rawUrl: string, environmentHttpBaseUrl: string | null) =>
  resolveEndpointUrl({ rawUrl, environmentHttpBaseUrl });

describe("local environment", () => {
  it("leaves a loopback URL alone when the environment is this machine", () => {
    expect(resolve("http://localhost:5173/", "http://127.0.0.1:3773")).toEqual({
      kind: "reachable",
      url: "http://localhost:5173/",
      via: "direct",
    });
  });

  it.each(["http://0.0.0.0:5000/", "http://[::]:5000/"])(
    "rewrites the wildcard bind %s on a local environment",
    (rawUrl) => {
      // Both forms are interface selectors rather than destinations; browsers
      // refuse them, so neither may be handed back as directly reachable.
      const result = resolve(rawUrl, "http://localhost:3773");
      expect(endpointDisplayAddress(result)).toBe("localhost:5000");
    },
  );

  it("rewrites a wildcard bind even on a local environment", () => {
    // Browsers refuse 0.0.0.0 as a destination, so it must not survive.
    const result = resolve("http://0.0.0.0:5000/", "http://localhost:3773");
    expect(result).toMatchObject({ kind: "reachable" });
    expect(endpointDisplayAddress(result)).toBe("localhost:5000");
  });
});

describe("remote environment on a private network", () => {
  it("swaps the loopback host for the environment host, keeping the port", () => {
    // This is what makes the feature work at all on a phone: localhost names
    // the device holding it, never the machine running the server.
    const result = resolve("http://localhost:5173/app", "http://192.168.1.24:3773");
    expect(result).toEqual({
      kind: "reachable",
      url: "http://192.168.1.24:5173/app",
      via: "private-network",
    });
  });

  it("preserves the path, query, and scheme", () => {
    const result = resolve("https://localhost:8888/lab?token=abc", "http://mac.local:3773");
    expect(result).toMatchObject({
      kind: "reachable",
      url: "https://mac.local:8888/lab?token=abc",
    });
  });

  it("works for a tailnet host", () => {
    expect(resolve("http://localhost:3000/", "https://box.tail1234.ts.net")).toMatchObject({
      url: "http://box.tail1234.ts.net:3000/",
      via: "private-network",
    });
  });

  it("brackets an ipv6 environment host", () => {
    const result = resolve("http://localhost:3000/", "http://[fd00::1]:3773");
    expect(result).toMatchObject({ kind: "reachable", url: "http://[fd00::1]:3000/" });
  });
});

describe("unreachable", () => {
  it("refuses a relay environment rather than returning a broken loopback URL", () => {
    const result = resolve("http://localhost:5173/", "https://relay.t3.app/abc");
    expect(result.kind).toBe("unreachable");
    expect(result.kind === "unreachable" && result.reason).toMatch(/not directly reachable/i);
  });

  it("reports a disconnected environment", () => {
    expect(resolve("http://localhost:5173/", null)).toMatchObject({ kind: "unreachable" });
  });

  it("reports an unusable endpoint URL", () => {
    expect(resolve("", "http://localhost:3773")).toMatchObject({ kind: "unreachable" });
  });

  it("passes a non-loopback endpoint straight through", () => {
    // Nothing to rewrite; the address already names a reachable host.
    expect(resolve("http://192.168.1.9:8080/", "https://relay.t3.app/abc")).toMatchObject({
      kind: "reachable",
      via: "direct",
    });
  });
});

describe("isPrivateNetworkHost", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["mac.local", true],
    ["box.tail1234.ts.net", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["192.168.1.5", true],
    ["100.64.0.1", true],
    ["100.128.0.1", false],
    ["169.254.1.1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["2606:4700::1", false],
    ["relay.t3.app", false],
    ["8.8.8.8", false],
  ])("%s -> %s", (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });
});
