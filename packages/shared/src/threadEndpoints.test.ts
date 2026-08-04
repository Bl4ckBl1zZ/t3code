import { describe, expect, it } from "vite-plus/test";

import {
  ENDPOINT_STALE_GRACE_MS,
  mergeThreadEndpoints,
  nextEndpointState,
  type MergeThreadEndpointsInput,
  type PreviousEndpointState,
  type ThreadEndpoint,
} from "./threadEndpoints.ts";

const NOW = 1_700_000_000_000;

const merge = (overrides: Partial<MergeThreadEndpointsInput>): ReadonlyArray<ThreadEndpoint> =>
  mergeThreadEndpoints({
    scanned: [],
    terminals: [],
    declaredUrls: [],
    previous: new Map(),
    nowMs: NOW,
    ...overrides,
  });

const scanned = (port: number, terminalId: string | null = "term-1") => ({
  host: "localhost",
  port,
  url: `http://localhost:${port}`,
  processName: "node",
  terminal: terminalId === null ? null : { threadId: "thread-1", terminalId },
});

describe("source precedence", () => {
  it("prefers the stdout URL over the scanner's bare origin", () => {
    const [endpoint] = merge({
      scanned: [scanned(5173)],
      terminals: [{ terminalId: "term-1", detectedUrls: ["https://localhost:5173/app/"] }],
    });
    // The scanner can only ever say http://host:port — it cannot know the
    // scheme or the base path, and opening the wrong one breaks the preview.
    expect(endpoint?.url).toBe("https://localhost:5173/app/");
    expect(endpoint?.status).toBe("live");
  });

  it("prefers a declared previewUrl over both", () => {
    const [endpoint] = merge({
      scanned: [scanned(3000)],
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/detected"] }],
      declaredUrls: ["http://localhost:3000/declared"],
    });
    expect(endpoint?.url).toBe("http://localhost:3000/declared");
    expect(endpoint?.source).toBe("declared");
  });

  it("prefers a stdout URL with a path over one without", () => {
    const [endpoint] = merge({
      terminals: [
        { terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] },
        { terminalId: "term-2", detectedUrls: ["http://localhost:3000/app"] },
      ],
    });
    expect(endpoint?.url).toBe("http://localhost:3000/app");
  });

  it("keeps scanner attribution even when the stdout URL wins", () => {
    const [endpoint] = merge({
      scanned: [scanned(5173)],
      terminals: [
        { terminalId: "term-1", activeScriptId: "dev", detectedUrls: ["http://localhost:5173/a"] },
      ],
    });
    expect(endpoint?.processName).toBe("node");
    expect(endpoint?.terminalId).toBe("term-1");
    expect(endpoint?.scriptId).toBe("dev");
  });
});

describe("attribution", () => {
  it("attributes a scanner row to the owning terminal's script", () => {
    const [endpoint] = merge({
      scanned: [scanned(4321)],
      terminals: [{ terminalId: "term-1", activeScriptId: "start" }],
    });
    expect(endpoint?.scriptId).toBe("start");
  });

  it("keeps an unattributed scanner row", () => {
    // `lsof` may see the socket a tick before the process tree is registered,
    // and containerised servers never join it at all.
    const [endpoint] = merge({ scanned: [scanned(8080, null)] });
    expect(endpoint?.terminalId).toBeNull();
    expect(endpoint?.status).toBe("live");
  });

  it("rescues a detached server through its terminal output", () => {
    // docker compose / pm2: the listener PID is never in our subtree, so the
    // scanner cannot attribute it — only the printed URL can.
    const [endpoint] = merge({
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
    });
    expect(endpoint?.terminalId).toBe("term-1");
    expect(endpoint?.status).toBe("starting");
  });
});

describe("status", () => {
  it("marks a socket-backed endpoint live", () => {
    expect(merge({ scanned: [scanned(3000)] })[0]?.status).toBe("live");
  });

  it("marks an announced but unconfirmed endpoint starting", () => {
    const [endpoint] = merge({
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
    });
    expect(endpoint?.status).toBe("starting");
  });

  it("holds a vanished endpoint as stale inside the grace window", () => {
    const previous = new Map<number, PreviousEndpointState>([
      [3000, { firstSeenAtMs: NOW - 60_000, lastLiveAtMs: NOW - 1_000 }],
    ]);
    const [endpoint] = merge({
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
      previous,
    });
    expect(endpoint?.status).toBe("stale");
  });

  it("drops a vanished endpoint after the grace window", () => {
    const previous = new Map<number, PreviousEndpointState>([
      [3000, { firstSeenAtMs: NOW - 60_000, lastLiveAtMs: NOW - ENDPOINT_STALE_GRACE_MS - 1 }],
    ]);
    expect(
      merge({
        terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
        previous,
      }),
    ).toEqual([]);
  });

  it("does not show a declared URL that nothing is serving", () => {
    expect(merge({ declaredUrls: ["http://localhost:9999/"] })).toEqual([]);
  });

  it("shows a declared URL once a socket confirms it", () => {
    const [endpoint] = merge({
      declaredUrls: ["http://localhost:3000/"],
      scanned: [scanned(3000)],
    });
    expect(endpoint?.status).toBe("live");
    expect(endpoint?.source).toBe("declared");
  });
});

describe("dedupe and filtering", () => {
  it("collapses every signal for one port into a single row", () => {
    const endpoints = merge({
      scanned: [scanned(3000)],
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
      declaredUrls: ["http://localhost:3000/"],
    });
    expect(endpoints).toHaveLength(1);
  });

  it("collapses ipv4 and ipv6 announcements of one server", () => {
    const endpoints = merge({
      terminals: [
        {
          terminalId: "term-1",
          detectedUrls: ["http://127.0.0.1:3000/", "http://[::1]:3000/"],
        },
      ],
    });
    expect(endpoints).toHaveLength(1);
  });

  it("drops known non-http listeners", () => {
    expect(merge({ scanned: [scanned(5432), scanned(6379)] })).toEqual([]);
  });

  it("drops T3's own ports", () => {
    const endpoints = merge({
      scanned: [scanned(3000), scanned(13773)],
      excludedPorts: new Set([13773]),
    });
    expect(endpoints.map((endpoint) => endpoint.port)).toEqual([3000]);
  });

  it("ignores unparseable and non-loopback declared urls", () => {
    expect(
      merge({ declaredUrls: ["", "not a url", "https://example.com/"], scanned: [scanned(3000)] }),
    ).toHaveLength(1);
  });
});

describe("ordering", () => {
  it("sorts by first-seen, then port", () => {
    const previous = new Map<number, PreviousEndpointState>([
      [9000, { firstSeenAtMs: NOW - 10_000, lastLiveAtMs: NOW }],
    ]);
    const endpoints = merge({
      scanned: [scanned(3000), scanned(9000), scanned(4000)],
      previous,
    });
    // 9000 was here first, so it stays on top even though its port is highest.
    expect(endpoints.map((endpoint) => endpoint.port)).toEqual([9000, 3000, 4000]);
  });

  it("keeps a row in place when its status changes", () => {
    const first = merge({ scanned: [scanned(3000), scanned(4000)] });
    const carried = nextEndpointState(first, new Map(), NOW);
    const second = mergeThreadEndpoints({
      scanned: [scanned(4000)],
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
      declaredUrls: [],
      previous: carried,
      nowMs: NOW + 1_000,
    });
    expect(second.map((endpoint) => endpoint.port)).toEqual([3000, 4000]);
    expect(second[0]?.status).toBe("stale");
  });
});

describe("nextEndpointState", () => {
  it("stamps liveness only while an endpoint is live", () => {
    const endpoints = merge({ scanned: [scanned(3000)] });
    const state = nextEndpointState(endpoints, new Map(), NOW);
    expect(state.get(3000)).toEqual({ firstSeenAtMs: NOW, lastLiveAtMs: NOW });
  });

  it("preserves the last live time across a stale tick", () => {
    const previous = new Map<number, PreviousEndpointState>([
      [3000, { firstSeenAtMs: NOW - 5_000, lastLiveAtMs: NOW - 1_000 }],
    ]);
    const endpoints = merge({
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
      previous,
    });
    const state = nextEndpointState(endpoints, previous, NOW);
    expect(state.get(3000)?.lastLiveAtMs).toBe(NOW - 1_000);
  });

  it("forgets endpoints that dropped out", () => {
    const previous = new Map<number, PreviousEndpointState>([
      [3000, { firstSeenAtMs: NOW, lastLiveAtMs: NOW }],
    ]);
    expect(nextEndpointState([], previous, NOW).size).toBe(0);
  });
});
