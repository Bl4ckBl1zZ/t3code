/**
 * Merges the two independent dev-server signals into the rows a thread shows.
 *
 * They fail in different ways, which is why both exist:
 *
 * - **Listening sockets** (`apps/server/src/preview/PortScanner.ts`) are ground
 *   truth for *existence and liveness*, in any language, even for a server that
 *   prints nothing. They are blind to detached and containerised processes
 *   (whose PIDs never join the terminal's subtree), and degrade to probing a
 *   fixed port list with no attribution when `lsof` is unavailable.
 * - **Terminal output** (`./terminalUrlDetection.ts`) is the only source of the
 *   *intended* URL — scheme, base path, query — and lands instantly. It is
 *   blind to servers that announce nothing.
 *
 * So: sockets decide whether something is live, output decides how it is
 * presented, and a declared `ProjectScript.previewUrl` outranks both.
 *
 * A third input answers a different question. The project's `t3.json`
 * `previewUrl` is *pinned*: it is not evidence that anything is running, so it
 * is listed from the moment the thread opens and survives the server stopping.
 * It is also the only input allowed to name a host that is not loopback — a
 * tunnel or a staging origin — because it is the only one a human wrote down on
 * purpose. Neither signal that decides liveness can see such a host, so those
 * rows stay `idle`; they exist to be clicked, not to report a status.
 */

import { isLoopbackHost } from "./preview.ts";
import type { DetectedTerminalUrl } from "./terminalUrlDetection.ts";
import { NON_HTTP_DEV_PORTS, toDetectedUrl } from "./terminalUrlDetection.ts";

export type ThreadEndpointStatus =
  /** A live listening socket backs this endpoint. */
  | "live"
  /** Announced in output but not yet confirmed listening. */
  | "starting"
  /** Was live, has stopped answering — held briefly so restarts do not flicker. */
  | "stale"
  /** Pinned by configuration with nothing serving it. Only pinned rows reach this. */
  | "idle";

export type ThreadEndpointSource = "declared" | "stdout" | "scanner";

export interface ThreadEndpoint {
  /**
   * Stable identity across ticks. One local port is one endpoint, whichever
   * host form announced it; a remote endpoint is identified by `host:port`,
   * since there is no local port to collapse it onto.
   */
  readonly key: string;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly status: ThreadEndpointStatus;
  readonly source: ThreadEndpointSource;
  readonly terminalId: string | null;
  /** Project script attributed to the owning terminal, when there is one. */
  readonly scriptId: string | null;
  readonly processName: string | null;
  /**
   * True for the project's configured `previewUrl`: the row is listed whether
   * or not anything is serving it, and sorts above the discovered ones.
   */
  readonly pinned: boolean;
  /**
   * True when this endpoint lives on this machine's loopback, which is the only
   * place either liveness signal can see. False means the status is the absence
   * of evidence, not evidence of absence — callers presenting one should say so.
   */
  readonly local: boolean;
  /** Epoch ms when this endpoint was first observed; drives stable ordering. */
  readonly firstSeenAtMs: number;
}

/** The scanner fields this merge needs. Structurally satisfied by `DiscoveredLocalServer`. */
export interface ScannedEndpointInput {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly processName: string | null;
  readonly terminal: { readonly threadId: string; readonly terminalId: string } | null;
}

/** The terminal-summary fields this merge needs. */
export interface TerminalEndpointInput {
  readonly terminalId: string;
  readonly activeScriptId?: string | null | undefined;
  readonly detectedUrls?: ReadonlyArray<string> | undefined;
  /**
   * Whether the terminal still has a foreground process. Announced URLs
   * outlive the server that printed them — interrupting a dev server kills the
   * child but not the shell, so the detection is not cleared — which makes this
   * the only signal that a never-confirmed endpoint has died.
   */
  readonly hasRunningSubprocess?: boolean | undefined;
}

/**
 * How long an endpoint that stopped answering stays visible. Nodemon, Vite HMR
 * restarts, and `cargo watch` all drop the socket for well under a second; a
 * row that vanishes and returns reads as a glitch, so hold it as `stale` first.
 */
export const ENDPOINT_STALE_GRACE_MS = 5_000;

export interface PreviousEndpointState {
  readonly firstSeenAtMs: number;
  readonly lastLiveAtMs: number;
}

const SOURCE_RANK: Record<ThreadEndpointSource, number> = {
  declared: 0,
  stdout: 1,
  scanner: 2,
};

interface Candidate {
  readonly key: string;
  readonly port: number;
  readonly host: string;
  readonly local: boolean;
  readonly url: string;
  readonly source: ThreadEndpointSource;
  readonly hasPath: boolean;
  readonly terminalId: string | null;
  readonly scriptId: string | null;
  readonly processName: string | null;
  readonly listening: boolean;
  /** False once the announcing terminal has no foreground process left. */
  readonly announcerRunning: boolean;
  /** Configured as the project's preview URL, so the row is never dropped. */
  readonly pinned: boolean;
}

/**
 * True when a candidate should replace the one already held for a port.
 *
 * Precedence is `declared` > `stdout`-with-path > `stdout` > `scanner`: a
 * user's own configuration wins, then the URL the server actually printed
 * (which alone knows `https` and base paths), then the bare socket.
 */
function outranks(next: Candidate, current: Candidate): boolean {
  const nextRank = SOURCE_RANK[next.source];
  const currentRank = SOURCE_RANK[current.source];
  if (nextRank !== currentRank) return nextRank < currentRank;
  if (next.hasPath !== current.hasPath) return next.hasPath;
  return false;
}

/** Merges a candidate into the map, keeping the best URL and the richest attribution. */
function absorb(byKey: Map<string, Candidate>, next: Candidate): void {
  const current = byKey.get(next.key);
  if (current === undefined) {
    byKey.set(next.key, next);
    return;
  }
  const winner = outranks(next, current) ? next : current;
  byKey.set(next.key, {
    ...winner,
    // Attribution and liveness accumulate regardless of which URL won: the
    // socket knows the process, the terminal knows the script.
    terminalId: current.terminalId ?? next.terminalId,
    scriptId: current.scriptId ?? next.scriptId,
    processName: current.processName ?? next.processName,
    listening: current.listening || next.listening,
    announcerRunning: current.announcerRunning || next.announcerRunning,
    // Pinning is a property of the port, not of whichever URL won: a dev server
    // that announces the pinned port must not turn the row back into a
    // droppable one when it exits.
    pinned: current.pinned || next.pinned,
  });
}

/**
 * Identity of a candidate. Local endpoints key on the port alone so every host
 * form of one server — `localhost`, `127.0.0.1`, `[::1]`, the bare socket —
 * collapses into a single row. A remote endpoint has no local port to collapse
 * onto, so it keys on its address; the colon keeps the two spaces disjoint.
 */
function candidateKey(host: string, port: number, local: boolean): string {
  return local ? String(port) : `${host}:${port}`;
}

function candidateFromUrl(
  rawUrl: string,
  source: ThreadEndpointSource,
  attribution: {
    readonly terminalId: string | null;
    readonly scriptId: string | null;
    readonly announcerRunning: boolean;
    readonly pinned?: boolean;
  },
): Candidate | null {
  const pinned = attribution.pinned ?? false;
  // Only a pinned URL may name a remote host: it is configuration, not text
  // scraped out of a dev server's banner, so there is no noise to filter.
  const detected: DetectedTerminalUrl | null = toDetectedUrl(rawUrl, { allowAnyHost: pinned });
  if (detected === null) return null;
  const local = isLoopbackHost(detected.host);
  return {
    key: candidateKey(detected.host, detected.port, local),
    port: detected.port,
    host: detected.host,
    local,
    url: detected.url,
    source,
    hasPath: detected.hasPath,
    terminalId: attribution.terminalId,
    scriptId: attribution.scriptId,
    processName: null,
    listening: false,
    announcerRunning: attribution.announcerRunning,
    pinned,
  };
}

export interface MergeThreadEndpointsInput {
  /** Scanner rows already filtered to this thread. */
  readonly scanned: ReadonlyArray<ScannedEndpointInput>;
  /** This thread's terminals, carrying their stdout detections. */
  readonly terminals: ReadonlyArray<TerminalEndpointInput>;
  /** `ProjectScript.previewUrl` values configured for the active project. */
  readonly declaredUrls: ReadonlyArray<string>;
  /**
   * `previewUrl` from the project's checked-in `t3.json`. Unlike every other
   * source these are not evidence that a server exists — they are the user
   * saying "this is where this project lives", so they are listed from the
   * moment the thread opens and stay listed after the server stops, and they
   * are the only input that may name a host off this machine.
   */
  readonly pinnedUrls?: ReadonlyArray<string> | undefined;
  /**
   * State carried from the previous merge, for ordering and the grace window,
   * keyed by {@link ThreadEndpoint.key}.
   */
  readonly previous: ReadonlyMap<string, PreviousEndpointState>;
  readonly nowMs: number;
  /** Local ports belonging to T3 itself, which must never be advertised as the thread's. */
  readonly excludedPorts?: ReadonlySet<number> | undefined;
}

/**
 * Pure, deterministic merge. Callers keep the returned `firstSeenAtMs` and
 * liveness in a ref and feed them back as `previous` on the next tick.
 */
export function mergeThreadEndpoints(
  input: MergeThreadEndpointsInput,
): ReadonlyArray<ThreadEndpoint> {
  const byKey = new Map<string, Candidate>();

  // Configured URLs first so they seed the identity; they are not "listening"
  // until a socket or a terminal detection says so.
  for (const pinned of input.pinnedUrls ?? []) {
    const candidate = candidateFromUrl(pinned, "declared", {
      terminalId: null,
      scriptId: null,
      announcerRunning: false,
      pinned: true,
    });
    if (candidate !== null) absorb(byKey, candidate);
  }

  for (const declared of input.declaredUrls) {
    const candidate = candidateFromUrl(declared, "declared", {
      terminalId: null,
      scriptId: null,
      announcerRunning: false,
    });
    if (candidate !== null) absorb(byKey, candidate);
  }

  for (const terminal of input.terminals) {
    for (const rawUrl of terminal.detectedUrls ?? []) {
      const candidate = candidateFromUrl(rawUrl, "stdout", {
        terminalId: terminal.terminalId,
        scriptId: terminal.activeScriptId ?? null,
        announcerRunning: terminal.hasRunningSubprocess ?? true,
      });
      if (candidate !== null) absorb(byKey, candidate);
    }
  }

  const scriptByTerminalId = new Map(
    input.terminals.map((terminal) => [terminal.terminalId, terminal.activeScriptId ?? null]),
  );
  for (const scanned of input.scanned) {
    if (NON_HTTP_DEV_PORTS.has(scanned.port)) continue;
    const terminalId = scanned.terminal?.terminalId ?? null;
    absorb(byKey, {
      // The scanner only ever reports sockets on this machine, so a scanned row
      // is local by construction whatever host form `lsof` printed.
      key: candidateKey(scanned.host, scanned.port, true),
      port: scanned.port,
      host: scanned.host,
      local: true,
      url: scanned.url,
      source: "scanner",
      hasPath: false,
      // A live socket is its own proof; it does not need an announcer.
      announcerRunning: true,
      terminalId,
      scriptId: terminalId === null ? null : (scriptByTerminalId.get(terminalId) ?? null),
      processName: scanned.processName,
      listening: true,
      pinned: false,
    });
  }

  const excluded = input.excludedPorts;
  const endpoints: Array<ThreadEndpoint> = [];
  for (const candidate of byKey.values()) {
    // Applies to pinned rows too: T3's own port is never this thread's server,
    // whatever a project file claims. Only locally, though — T3 holding :443
    // says nothing about a remote origin that happens to serve on the same one.
    if (candidate.local && excluded?.has(candidate.port) === true) continue;
    const previous = input.previous.get(candidate.key);
    const firstSeenAtMs = previous?.firstSeenAtMs ?? input.nowMs;

    let status: ThreadEndpointStatus;
    if (candidate.listening) {
      status = "live";
    } else if (previous !== undefined && previous.lastLiveAtMs > 0) {
      // Was live and went quiet: hold it briefly, then drop it entirely.
      if (input.nowMs - previous.lastLiveAtMs > ENDPOINT_STALE_GRACE_MS) {
        if (!candidate.pinned) continue;
        status = "idle";
      } else {
        status = "stale";
      }
    } else if (candidate.pinned && !candidate.announcerRunning) {
      // Configuration with nothing behind it yet — the case this whole flag
      // exists for. Never "starting": nothing has been started.
      status = "idle";
    } else if (!candidate.announcerRunning) {
      // Nothing is backing this endpoint: either it is configuration with no
      // process behind it yet, or it was announced by a process that has since
      // gone. Interrupting a dev server kills the child without killing the
      // shell, so the announcement itself is never retracted — without this
      // the row would sit on "Starting…" forever wherever the socket scan
      // cannot confirm it (no `lsof`, or a containerised listener).
      //
      // Note this deliberately does not special-case `declared`: a configured
      // previewUrl that a *running* process has also announced is exactly the
      // case that should show as starting.
      continue;
    } else {
      status = "starting";
    }

    endpoints.push({
      key: candidate.key,
      url: candidate.url,
      host: candidate.host,
      port: candidate.port,
      status,
      source: candidate.source,
      terminalId: candidate.terminalId,
      scriptId: candidate.scriptId,
      processName: candidate.processName,
      pinned: candidate.pinned,
      local: candidate.local,
      firstSeenAtMs,
    });
  }

  // Pinned first, then first-seen, then port, then key: the project's own URL
  // holds the top row (surfaces above any "+N more" cut), and rows must never
  // reshuffle under the pointer when a sibling endpoint changes state. The key
  // breaks the last tie, which two remote origins on :443 would otherwise hit.
  // .sort() on the local array, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods, and this runs on mobile.
  return endpoints.sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      left.firstSeenAtMs - right.firstSeenAtMs ||
      left.port - right.port ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
}

/**
 * Folds the merge result back into the state the next merge needs. Kept here so
 * the caller never has to reason about the grace window itself.
 */
export function nextEndpointState(
  endpoints: ReadonlyArray<ThreadEndpoint>,
  previous: ReadonlyMap<string, PreviousEndpointState>,
  nowMs: number,
): ReadonlyMap<string, PreviousEndpointState> {
  const next = new Map<string, PreviousEndpointState>();
  for (const endpoint of endpoints) {
    const prior = previous.get(endpoint.key);
    next.set(endpoint.key, {
      firstSeenAtMs: endpoint.firstSeenAtMs,
      lastLiveAtMs: endpoint.status === "live" ? nowMs : (prior?.lastLiveAtMs ?? 0),
    });
  }
  return next;
}
