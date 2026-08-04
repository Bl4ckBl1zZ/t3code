import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MobileThreadEndpoint } from "../../state/use-thread-endpoints";
import {
  openableEndpoints,
  portEndpointIcon,
  portEndpointLabel,
  portEndpointSubtitle,
  portsMenuAccessibilityLabel,
  portsMenuTintColor,
  PORTS_LIVE_TINT,
} from "./threadPortsMenu";

const endpoint = (overrides: Partial<MobileThreadEndpoint> = {}): MobileThreadEndpoint => ({
  key: "5173",
  url: "http://localhost:5173/",
  host: "localhost",
  port: 5173,
  status: "live",
  source: "stdout",
  terminalId: "term-1",
  scriptId: null,
  processName: null,
  pinned: false,
  local: true,
  firstSeenAtMs: 0,
  reachability: { kind: "reachable", url: "http://192.168.1.24:5173/", via: "private-network" },
  displayAddress: "192.168.1.24:5173",
  ...overrides,
});

const script = (overrides: Partial<ProjectScript> = {}): ProjectScript =>
  ({
    id: "dev",
    name: "Dev",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
    ...overrides,
  }) as ProjectScript;

describe("portEndpointLabel", () => {
  it("prefers the script the user ran", () => {
    expect(portEndpointLabel(endpoint({ scriptId: "dev" }), [script()])).toBe("Dev");
  });

  it("falls back to the serving process", () => {
    expect(portEndpointLabel(endpoint({ processName: "node" }), [])).toBe("node");
  });

  it("falls back to the bare port", () => {
    expect(portEndpointLabel(endpoint(), [])).toBe("Port 5173");
  });

  it("ignores a script id that no longer resolves", () => {
    expect(portEndpointLabel(endpoint({ scriptId: "deleted" }), [script()])).toBe("Port 5173");
  });
});

describe("portEndpointSubtitle", () => {
  it("shows the resolved address, never the announced one", () => {
    // localhost would name the phone, not the machine running the server.
    const subtitle = portEndpointSubtitle(endpoint());
    expect(subtitle).toBe("192.168.1.24:5173");
    expect(subtitle).not.toContain("localhost");
  });

  it("explains an unreachable endpoint instead of offering an address", () => {
    expect(
      portEndpointSubtitle(
        endpoint({
          reachability: { kind: "unreachable", reason: "Not directly reachable." },
          displayAddress: null,
        }),
      ),
    ).toBe("Not directly reachable.");
  });

  it("reports a starting endpoint", () => {
    expect(portEndpointSubtitle(endpoint({ status: "starting" }))).toBe("Starting…");
  });

  it("marks a stale endpoint alongside its address", () => {
    expect(portEndpointSubtitle(endpoint({ status: "stale" }))).toBe(
      "192.168.1.24:5173 · no longer responding",
    );
  });
});

describe("portEndpointIcon", () => {
  it.each([
    [endpoint(), "globe"],
    [endpoint({ status: "starting" }), "clock"],
    [endpoint({ status: "stale" }), "moon.zzz"],
    [endpoint({ reachability: { kind: "unreachable", reason: "x" } }), "exclamationmark.triangle"],
  ])("maps state to an icon", (input, expected) => {
    expect(portEndpointIcon(input)).toBe(expected);
  });

  it("prioritises unreachable over status so the warning is never hidden", () => {
    expect(
      portEndpointIcon(
        endpoint({ status: "live", reachability: { kind: "unreachable", reason: "x" } }),
      ),
    ).toBe("exclamationmark.triangle");
  });
});

describe("portsMenuTintColor", () => {
  it("tints the toolbar icon once something is live", () => {
    expect(portsMenuTintColor([endpoint()])).toBe(PORTS_LIVE_TINT);
  });

  it("stays untinted while everything is still starting", () => {
    expect(portsMenuTintColor([endpoint({ status: "starting" })])).toBeUndefined();
  });

  it("stays untinted when nothing is serving", () => {
    expect(portsMenuTintColor([])).toBeUndefined();
  });
});

describe("portsMenuAccessibilityLabel", () => {
  it("singularises", () => {
    expect(portsMenuAccessibilityLabel([endpoint()])).toBe("1 port in this thread");
  });

  it("pluralises", () => {
    expect(portsMenuAccessibilityLabel([endpoint(), endpoint({ key: "3000", port: 3000 })])).toBe(
      "2 ports in this thread",
    );
  });

  it("does not claim a starting or stale port is serving", () => {
    const label = portsMenuAccessibilityLabel([
      endpoint({ status: "starting" }),
      endpoint({ key: "3000", port: 3000, status: "stale" }),
    ]);
    expect(label).not.toContain("serving");
  });
});

describe("openableEndpoints", () => {
  it("excludes unreachable and stale entries", () => {
    const rows = [
      endpoint({ key: "5173" }),
      endpoint({ key: "3000", status: "stale" }),
      endpoint({ key: "4000", reachability: { kind: "unreachable", reason: "x" } }),
    ];
    expect(openableEndpoints(rows).map((row) => row.key)).toEqual(["5173"]);
  });
});
