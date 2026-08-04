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
    const previous = new Map<string, PreviousEndpointState>([
      ["3000", { firstSeenAtMs: NOW - 60_000, lastLiveAtMs: NOW - 1_000 }],
    ]);
    const [endpoint] = merge({
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
      previous,
    });
    expect(endpoint?.status).toBe("stale");
  });

  it("drops a vanished endpoint after the grace window", () => {
    const previous = new Map<string, PreviousEndpointState>([
      ["3000", { firstSeenAtMs: NOW - 60_000, lastLiveAtMs: NOW - ENDPOINT_STALE_GRACE_MS - 1 }],
    ]);
    expect(
      merge({
        terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
        previous,
      }),
    ).toEqual([]);
  });

  it("drops a never-confirmed endpoint once its announcing process is gone", () => {
    // Found on a real PTY: interrupting a dev server kills the child but not
    // the shell, so `detectedUrls` is never retracted. Without the running
    // check this row sat on "Starting…" forever wherever the socket scan
    // cannot confirm it.
    expect(
      merge({
        terminals: [
          {
            terminalId: "term-1",
            detectedUrls: ["http://localhost:3000/"],
            hasRunningSubprocess: false,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps a never-confirmed endpoint while its process is still running", () => {
    // The socket scan cannot see containerised listeners, and degrades badly
    // without `lsof` — a healthy server must not vanish just because of that.
    const [endpoint] = merge({
      terminals: [
        {
          terminalId: "term-1",
          detectedUrls: ["http://localhost:3000/"],
          hasRunningSubprocess: true,
        },
      ],
    });
    expect(endpoint?.status).toBe("starting");
  });

  it("keeps a previously live endpoint in the grace window even once the process exits", () => {
    // Liveness beats the announcer: a socket-confirmed endpoint follows the
    // stale path so a restart does not flicker.
    const previous = new Map<string, PreviousEndpointState>([
      ["3000", { firstSeenAtMs: NOW - 10_000, lastLiveAtMs: NOW - 500 }],
    ]);
    const [endpoint] = merge({
      terminals: [
        {
          terminalId: "term-1",
          detectedUrls: ["http://localhost:3000/"],
          hasRunningSubprocess: false,
        },
      ],
      previous,
    });
    expect(endpoint?.status).toBe("stale");
  });

  it("does not show a declared URL that nothing is serving", () => {
    expect(merge({ declaredUrls: ["http://localhost:9999/"] })).toEqual([]);
  });

  it("shows a declared URL that a running process has announced", () => {
    // Configuration plus a live announcer, with the socket scan yet to catch
    // up (or unable to). Dropping this on the grounds that it is "declared"
    // hid the row for exactly the setup the previewUrl field exists for.
    const [endpoint] = merge({
      declaredUrls: ["http://localhost:3000/"],
      terminals: [
        {
          terminalId: "term-1",
          detectedUrls: ["http://localhost:3000/"],
          hasRunningSubprocess: true,
        },
      ],
    });
    expect(endpoint?.status).toBe("starting");
    expect(endpoint?.source).toBe("declared");
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

describe("pinned project preview url", () => {
  it("lists a pinned URL with nothing running at all", () => {
    const [endpoint] = merge({ pinnedUrls: ["http://localhost:5173/"] });
    expect(endpoint?.status).toBe("idle");
    expect(endpoint?.pinned).toBe(true);
    expect(endpoint?.url).toBe("http://localhost:5173/");
  });

  it("turns live once a socket confirms the pinned port", () => {
    const [endpoint] = merge({
      pinnedUrls: ["http://localhost:5173/app"],
      scanned: [scanned(5173)],
    });
    expect(endpoint?.status).toBe("live");
    // The pinned URL still decides presentation: the scanner cannot know the path.
    expect(endpoint?.url).toBe("http://localhost:5173/app");
  });

  it("returns to idle instead of disappearing when the server stops", () => {
    const first = merge({ pinnedUrls: ["http://localhost:5173/"], scanned: [scanned(5173)] });
    const carried = nextEndpointState(first, new Map(), NOW);
    const later = mergeThreadEndpoints({
      scanned: [],
      terminals: [],
      declaredUrls: [],
      pinnedUrls: ["http://localhost:5173/"],
      previous: carried,
      nowMs: NOW + ENDPOINT_STALE_GRACE_MS + 1,
    });
    expect(later).toHaveLength(1);
    expect(later[0]?.status).toBe("idle");
  });

  it("stays pinned after the announcing terminal exits", () => {
    const [endpoint] = merge({
      pinnedUrls: ["http://localhost:5173/"],
      terminals: [
        {
          terminalId: "term-1",
          detectedUrls: ["http://localhost:5173/"],
          hasRunningSubprocess: false,
        },
      ],
    });
    expect(endpoint?.status).toBe("idle");
    expect(endpoint?.pinned).toBe(true);
  });

  it("sorts above endpoints that were discovered first", () => {
    const previous = new Map<string, PreviousEndpointState>([
      ["3000", { firstSeenAtMs: NOW - 10_000, lastLiveAtMs: NOW }],
    ]);
    const endpoints = merge({
      pinnedUrls: ["http://localhost:5173/"],
      scanned: [scanned(3000)],
      previous,
    });
    expect(endpoints.map((endpoint) => endpoint.port)).toEqual([5173, 3000]);
  });

  it("never advertises T3's own port, pinned or not", () => {
    expect(
      merge({ pinnedUrls: ["http://localhost:13773/"], excludedPorts: new Set([13773]) }),
    ).toEqual([]);
  });
});

describe("pinned remote origins", () => {
  it("lists a pinned URL that is not a loopback address", () => {
    // A worktree behind a tunnel, or a shared staging origin: nothing local can
    // confirm it, but the project still says this is where it lives.
    const [endpoint] = merge({ pinnedUrls: ["https://wt1.example.org/"] });
    expect(endpoint?.url).toBe("https://wt1.example.org/");
    expect(endpoint?.pinned).toBe(true);
    expect(endpoint?.local).toBe(false);
    // Idle, not because we checked, but because neither signal can see it.
    expect(endpoint?.status).toBe("idle");
  });

  it("normalizes a pinned host written without a scheme", () => {
    const [endpoint] = merge({ pinnedUrls: ["wt1.example.org"] });
    expect(endpoint?.url).toBe("https://wt1.example.org/");
  });

  it("keeps a remote origin separate from the local server on its implied port", () => {
    // Both land on :443 — one because it is https, one because it is bound
    // there — and collapsing them would hide whichever lost the tiebreak.
    const endpoints = merge({
      pinnedUrls: ["https://wt1.example.org/"],
      scanned: [scanned(443)],
    });
    expect(endpoints.map((endpoint) => endpoint.key)).toEqual(["wt1.example.org:443", "443"]);
  });

  it("does not apply T3's own port exclusion to a remote origin", () => {
    // T3 itself served over https holds :443 locally; that says nothing about
    // someone else's origin that happens to answer on the same port.
    const [endpoint] = merge({
      pinnedUrls: ["https://wt1.example.org/"],
      excludedPorts: new Set([443]),
    });
    expect(endpoint?.host).toBe("wt1.example.org");
  });

  it("still ignores a remote URL that was only announced in output", () => {
    // The loopback gate is what drops docs links and telemetry notices printed
    // alongside a dev-server banner; only configuration is exempt from it.
    expect(
      merge({
        terminals: [{ terminalId: "term-1", detectedUrls: ["https://docs.example.org/guide"] }],
      }),
    ).toEqual([]);
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
    const previous = new Map<string, PreviousEndpointState>([
      ["9000", { firstSeenAtMs: NOW - 10_000, lastLiveAtMs: NOW }],
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
    expect(state.get("3000")).toEqual({ firstSeenAtMs: NOW, lastLiveAtMs: NOW });
  });

  it("preserves the last live time across a stale tick", () => {
    const previous = new Map<string, PreviousEndpointState>([
      ["3000", { firstSeenAtMs: NOW - 5_000, lastLiveAtMs: NOW - 1_000 }],
    ]);
    const endpoints = merge({
      terminals: [{ terminalId: "term-1", detectedUrls: ["http://localhost:3000/"] }],
      previous,
    });
    const state = nextEndpointState(endpoints, previous, NOW);
    expect(state.get("3000")?.lastLiveAtMs).toBe(NOW - 1_000);
  });

  it("forgets endpoints that dropped out", () => {
    const previous = new Map<string, PreviousEndpointState>([
      ["3000", { firstSeenAtMs: NOW, lastLiveAtMs: NOW }],
    ]);
    expect(nextEndpointState([], previous, NOW).size).toBe(0);
  });
});
