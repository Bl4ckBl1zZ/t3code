/**
 * Detects visitable dev-server URLs in terminal output.
 *
 * Start scripts announce themselves in stdout in every language and framework
 * ("Local: http://localhost:5173/", "Starting development server at
 * http://127.0.0.1:8000/"). Scraping that is the only signal that carries the
 * *intended* URL — scheme, base path, query — which a listening-socket scan
 * cannot recover. The socket scan (`apps/server/src/preview/PortScanner.ts`)
 * remains the source of truth for liveness; this is the source of truth for
 * presentation.
 *
 * Deliberately framework-agnostic: one generic URL match plus the shared
 * loopback gate in `./preview.ts`. There is no per-framework pattern table to
 * keep current, and no "listening on port N" dialect matching — the socket
 * scanner finds bound ports far more reliably than a regex ever would.
 */

import { isPreviewableUrl, normalizePreviewUrl } from "./preview.ts";

export interface DetectedTerminalUrl {
  /** Normalized `http(s)://host:port/path`, credentials stripped. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly scheme: "http" | "https";
  /** True when the URL carries a path beyond "/" — drives merge precedence. */
  readonly hasPath: boolean;
}

export interface TerminalUrlScanner {
  /**
   * Feed one chunk of terminal output. Returns only URLs not previously seen
   * by this scanner, so callers can treat every result as a new endpoint.
   */
  readonly push: (visibleText: string) => ReadonlyArray<DetectedTerminalUrl>;
  /** Forget both the pending line buffer and the dedupe set. */
  readonly reset: () => void;
}

const ESC = "\u001b";
const BEL = "\u0007";
const CSI_8BIT = "\u009b";

/**
 * Longest pending partial line we will hold. A dev-server banner line is well
 * under this; anything longer is log spew we would rather drop than buffer.
 */
const MAX_PENDING_LENGTH = 4096;

/** Default cap on distinct URLs remembered per terminal session. */
const DEFAULT_MAX_URLS = 8;

/** Trailing characters that punctuate a sentence rather than belong to a URL. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", '"', "`"]);

/** Closing brackets, paired so `(http://x)` trims but `http://x/a)` survives. */
const CLOSING_TO_OPENING: ReadonlyMap<string, string> = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  [">", "<"],
]);

const URL_PATTERN = /https?:\/\/[^\s]+/gu;

/** Bind-everything addresses, rewritten to `localhost` for display and navigation. */
export const WILDCARD_BIND_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * Ports that listen but never serve a page worth previewing. Dev stacks bring
 * these up from the same terminal (docker compose, a Rails app with sidecars),
 * so without this the panel fills with rows nobody can click.
 */
export const NON_HTTP_DEV_PORTS: ReadonlySet<number> = new Set([
  9229, // node --inspect
  9230, // node --inspect, second worker
  5432, // postgres
  6379, // redis
  3306, // mysql
  27017, // mongodb
  11211, // memcached
  9200, // elasticsearch
  5672, // rabbitmq
]);

/** True at a two-character ST (`ESC \`) terminator. */
function isStringTerminatorAt(input: string, index: number): boolean {
  return input[index] === ESC && input[index + 1] === "\\";
}

/**
 * Strips ANSI escape sequences so a URL reads as one token.
 *
 * This is not cosmetic. Vite emphasises the port *inside* the URL
 * (ESC[1m around the digits), so matching raw output yields `http://localhost:`
 * and silently loses the port. Every colouring dev server has some version of
 * this problem.
 *
 * OSC 8 hyperlinks are handled by `extractOsc8Uris` before this runs, since
 * their URI lives in the sequence body rather than in the visible text.
 */
export function stripAnsiSequences(input: string): string {
  let out = "";
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === ESC) {
      const next = input[index + 1];
      if (next === "[") {
        // CSI: parameters and intermediates, then a final byte in @..~.
        let cursor = index + 2;
        while (cursor < input.length) {
          const byte = input.charCodeAt(cursor);
          if (byte >= 0x40 && byte <= 0x7e) break;
          cursor += 1;
        }
        index = cursor + 1;
        continue;
      }
      if (next === "]" || next === "P" || next === "^" || next === "_") {
        // String sequences (OSC/DCS/PM/APC) run until BEL or ST.
        let cursor = index + 2;
        while (cursor < input.length) {
          if (input[cursor] === BEL) break;
          if (isStringTerminatorAt(input, cursor)) {
            cursor += 1;
            break;
          }
          cursor += 1;
        }
        index = cursor + 1;
        continue;
      }
      // Plain ESC <intermediates> <final>.
      let cursor = index + 1;
      while (cursor < input.length) {
        const byte = input.charCodeAt(cursor);
        if (byte >= 0x30 && byte <= 0x7e) break;
        cursor += 1;
      }
      index = cursor + 1;
      continue;
    }
    if (char === CSI_8BIT) {
      let cursor = index + 1;
      while (cursor < input.length) {
        const byte = input.charCodeAt(cursor);
        if (byte >= 0x40 && byte <= 0x7e) break;
        cursor += 1;
      }
      index = cursor + 1;
      continue;
    }
    // Carriage returns are progress-bar redraws, not content; treat as breaks
    // so a repainted line still terminates for the line-based scan below.
    out += char === "\r" ? "\n" : char;
    index += 1;
  }
  return out;
}

/**
 * Pulls URIs out of OSC 8 hyperlinks before the sequences are stripped. Modern
 * CLIs emit `ESC ] 8 ; params ; URI ST label ESC ] 8 ; ; ST`, where the URI is
 * never part of the visible text.
 */
export function extractOsc8Uris(input: string): ReadonlyArray<string> {
  const opener = `${ESC}]8;`;
  const uris: string[] = [];
  let index = input.indexOf(opener);
  while (index >= 0) {
    const bodyStart = index + opener.length;
    let cursor = bodyStart;
    let terminator = -1;
    while (cursor < input.length) {
      if (input[cursor] === BEL || isStringTerminatorAt(input, cursor)) {
        terminator = cursor;
        break;
      }
      cursor += 1;
    }
    if (terminator < 0) break;
    // Body is `params;URI`; the closing half of the pair carries an empty URI.
    const body = input.slice(bodyStart, terminator);
    const separator = body.indexOf(";");
    const uri = separator < 0 ? "" : body.slice(separator + 1).trim();
    if (uri.length > 0) uris.push(uri);
    index = input.indexOf(opener, terminator + 1);
  }
  return uris;
}

/**
 * Trims characters that terminate the surrounding sentence rather than the
 * URL: `at http://localhost:3000.` and `(http://localhost:3000)` both end at
 * the port, but `http://localhost:3000/a)` keeps its bracket because the URL
 * opened one.
 */
export function trimUrlBoundary(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const char = raw[end - 1] ?? "";
    if (TRAILING_PUNCTUATION.has(char)) {
      end -= 1;
      continue;
    }
    const opening = CLOSING_TO_OPENING.get(char);
    if (opening !== undefined) {
      const candidate = raw.slice(0, end - 1);
      const opens = candidate.split(opening).length - 1;
      const closes = candidate.split(char).length - 1;
      if (opens <= closes) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return raw.slice(0, end);
}

/**
 * Validates and normalizes one candidate. Returns null for anything that is
 * not a previewable loopback dev server — which is what drops documentation
 * links, telemetry notices, and npm audit URLs printed alongside the banner.
 *
 * `allowAnyHost` lifts both of those noise filters — the loopback host gate and
 * the non-HTTP port list — for URLs that were not scraped out of a stream of
 * arbitrary text but written down deliberately, where there is no noise to
 * reject and the address may legitimately be a tunnel or a staging host.
 */
export function toDetectedUrl(
  candidate: string,
  options?: { readonly allowAnyHost?: boolean },
): DetectedTerminalUrl | null {
  const allowAnyHost = options?.allowAnyHost === true;
  const trimmed = trimUrlBoundary(candidate.trim());
  if (trimmed.length === 0) return null;
  if (!allowAnyHost && !isPreviewableUrl(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(trimmed));
  } catch {
    return null;
  }
  // Credentials in a dev URL are noise at best and a leak in the UI at worst.
  parsed.username = "";
  parsed.password = "";
  // `0.0.0.0` and `::` are bind addresses, not destinations — Safari refuses
  // them outright. Servers that print them (Flask, python -m http.server) mean
  // "every interface", so the loopback name is both correct and clickable.
  if (WILDCARD_BIND_HOSTS.has(parsed.hostname)) parsed.hostname = "localhost";

  const scheme = parsed.protocol === "https:" ? "https" : "http";
  const defaultPort = scheme === "https" ? 443 : 80;
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : defaultPort;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  if (!allowAnyHost && NON_HTTP_DEV_PORTS.has(port)) return null;

  return {
    url: parsed.href,
    host: parsed.hostname,
    port,
    scheme,
    hasPath: parsed.pathname !== "/" || parsed.search.length > 0,
  };
}

/**
 * Creates a per-session scanner.
 *
 * Output arrives in arbitrary PTY-sized chunks, so a URL can straddle two
 * reads. Buffering until a newline sidesteps that entirely: a URL never spans
 * a line break unless the PTY wrapped it, and script terminals are opened wide
 * enough (120 columns) that real banners do not wrap.
 */
export function createTerminalUrlScanner(options?: {
  readonly maxUrls?: number;
}): TerminalUrlScanner {
  const maxUrls = options?.maxUrls ?? DEFAULT_MAX_URLS;
  let pending = "";
  const seen = new Set<number>();

  const consider = (candidate: string, out: Array<DetectedTerminalUrl>): void => {
    if (seen.size >= maxUrls) return;
    const detected = toDetectedUrl(candidate);
    if (detected === null) return;
    // Keyed on port alone: every host that clears `isPreviewableUrl` is
    // loopback, so one port is one server. Rails announces the same server
    // twice (127.0.0.1 and [::1]) and must not become two rows.
    if (seen.has(detected.port)) return;
    seen.add(detected.port);
    out.push(detected);
  };

  return {
    push: (visibleText: string) => {
      if (visibleText.length === 0 || seen.size >= maxUrls) return [];

      const found: Array<DetectedTerminalUrl> = [];
      for (const uri of extractOsc8Uris(visibleText)) consider(uri, found);

      pending = `${pending}${stripAnsiSequences(visibleText)}`;
      const lastBreak = pending.lastIndexOf("\n");
      if (lastBreak < 0) {
        // No complete line yet: keep buffering, but never without bound.
        if (pending.length > MAX_PENDING_LENGTH) pending = pending.slice(-MAX_PENDING_LENGTH);
        return found;
      }

      const complete = pending.slice(0, lastBreak);
      pending = pending.slice(lastBreak + 1);
      if (pending.length > MAX_PENDING_LENGTH) pending = pending.slice(-MAX_PENDING_LENGTH);

      // Cheap gate so build and test log floods cost one substring search.
      if (!complete.includes("://")) return found;

      for (const match of complete.matchAll(URL_PATTERN)) {
        consider(match[0], found);
        if (seen.size >= maxUrls) break;
      }
      return found;
    },
    reset: () => {
      pending = "";
      seen.clear();
    },
  };
}
