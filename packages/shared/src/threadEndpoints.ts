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
 */

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
  /** Stable identity across ticks. One port is one endpoint. */
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
  readonly port: number;
  readonly host: string;
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
function absorb(byPort: Map<number, Candidate>, next: Candidate): void {
  const current = byPort.get(next.port);
  if (current === undefined) {
    byPort.set(next.port, next);
    return;
  }
  const winner = outranks(next, current) ? next : current;
  byPort.set(next.port, {
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
  const detected: DetectedTerminalUrl | null = toDetectedUrl(rawUrl);
  if (detected === null) return null;
  return {
    port: detected.port,
    host: detected.host,
    url: detected.url,
    source,
    hasPath: detected.hasPath,
    terminalId: attribution.terminalId,
    scriptId: attribution.scriptId,
    processName: null,
    listening: false,
    announcerRunning: attribution.announcerRunning,
    pinned: attribution.pinned ?? false,
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
   * moment the thread opens and stay listed after the server stops.
   */
  readonly pinnedUrls?: ReadonlyArray<string> | undefined;
  /** Per-port state carried from the previous merge, for ordering and the grace window. */
  readonly previous: ReadonlyMap<number, PreviousEndpointState>;
  readonly nowMs: number;
  /** Ports belonging to T3 itself, which must never be advertised as the thread's. */
  readonly excludedPorts?: ReadonlySet<number> | undefined;
}

/**
 * Pure, deterministic merge. Callers keep the returned `firstSeenAtMs` and
 * liveness in a ref and feed them back as `previous` on the next tick.
 */
export function mergeThreadEndpoints(
  input: MergeThreadEndpointsInput,
): ReadonlyArray<ThreadEndpoint> {
  const byPort = new Map<number, Candidate>();

  // Configured URLs first so they seed the identity; they are not "listening"
  // until a socket or a terminal detection says so.
  for (const pinned of input.pinnedUrls ?? []) {
    const candidate = candidateFromUrl(pinned, "declared", {
      terminalId: null,
      scriptId: null,
      announcerRunning: false,
      pinned: true,
    });
    if (candidate !== null) absorb(byPort, candidate);
  }

  for (const declared of input.declaredUrls) {
    const candidate = candidateFromUrl(declared, "declared", {
      terminalId: null,
      scriptId: null,
      announcerRunning: false,
    });
    if (candidate !== null) absorb(byPort, candidate);
  }

  for (const terminal of input.terminals) {
    for (const rawUrl of terminal.detectedUrls ?? []) {
      const candidate = candidateFromUrl(rawUrl, "stdout", {
        terminalId: terminal.terminalId,
        scriptId: terminal.activeScriptId ?? null,
        announcerRunning: terminal.hasRunningSubprocess ?? true,
      });
      if (candidate !== null) absorb(byPort, candidate);
    }
  }

  const scriptByTerminalId = new Map(
    input.terminals.map((terminal) => [terminal.terminalId, terminal.activeScriptId ?? null]),
  );
  for (const scanned of input.scanned) {
    if (NON_HTTP_DEV_PORTS.has(scanned.port)) continue;
    const terminalId = scanned.terminal?.terminalId ?? null;
    absorb(byPort, {
      port: scanned.port,
      host: scanned.host,
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
  for (const candidate of byPort.values()) {
    // Applies to pinned rows too: T3's own port is never this thread's server,
    // whatever a project file claims.
    if (excluded?.has(candidate.port) === true) continue;
    const previous = input.previous.get(candidate.port);
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
      key: String(candidate.port),
      url: candidate.url,
      host: candidate.host,
      port: candidate.port,
      status,
      source: candidate.source,
      terminalId: candidate.terminalId,
      scriptId: candidate.scriptId,
      processName: candidate.processName,
      pinned: candidate.pinned,
      firstSeenAtMs,
    });
  }

  // Pinned first, then first-seen, then port: the project's own URL holds the
  // top row (surfaces above any "+N more" cut), and rows must never reshuffle
  // under the pointer when a sibling endpoint changes state.
  // .sort() on the local array, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods, and this runs on mobile.
  return endpoints.sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      left.firstSeenAtMs - right.firstSeenAtMs ||
      left.port - right.port,
  );
}

/**
 * Folds the merge result back into the state the next merge needs. Kept here so
 * the caller never has to reason about the grace window itself.
 */
export function nextEndpointState(
  endpoints: ReadonlyArray<ThreadEndpoint>,
  previous: ReadonlyMap<number, PreviousEndpointState>,
  nowMs: number,
): ReadonlyMap<number, PreviousEndpointState> {
  const next = new Map<number, PreviousEndpointState>();
  for (const endpoint of endpoints) {
    const prior = previous.get(endpoint.port);
    next.set(endpoint.port, {
      firstSeenAtMs: endpoint.firstSeenAtMs,
      lastLiveAtMs: endpoint.status === "live" ? nowMs : (prior?.lastLiveAtMs ?? 0),
    });
  }
  return next;
}
