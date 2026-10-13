/**
 * Dev-server URLs announced in terminal output ("Local: http://localhost:5173/app/").
 *
 * The port scanner already sees which listening sockets a terminal owns; what
 * it cannot see is the URL the server meant, with its base path, or a server
 * whose listener is not in the terminal's process tree (a container, a
 * detached child). The announcement fills both gaps and lands the moment the
 * server prints it.
 */

/** URLs a single terminal may announce before older ones stop counting. */
export const TERMINAL_ANNOUNCED_URLS_MAX = 8;

/** A partial line carried between chunks; longer lines are not URLs worth keeping. */
const PARTIAL_LINE_MAX = 1_024;

/** CSI and OSC sequences. Vite colours the port inside its URL. */
const TERMINAL_CONTROL_SEQUENCES = new RegExp(
  ["\\u001B\\[[0-9;?]*[ -/]*[@-~]", "\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)"].join("|"),
  "gu",
);

const LOOPBACK_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:[/?#][^\s"'`<>()[\]{}]*)?/giu;

/**
 * Ports whose servers speak something other than HTTP. A log line naming
 * `http://localhost:5432` is a misconfiguration, not a preview.
 */
const NON_HTTP_PORTS = new Set([22, 25, 3306, 5432, 5672, 6379, 9229, 11211, 27017]);

/** Normalizes an announced URL to the form the scanner probes, or null when it is not one. */
export function normalizeAnnouncedUrl(raw: string): string | null {
  let url: URL;
  try {
    // Trailing punctuation belongs to the sentence, not the URL.
    url = new URL(raw.replace(/[.,;:!]+$/u, ""));
  } catch {
    return null;
  }
  if (url.port.length === 0) return null;
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536 || NON_HTTP_PORTS.has(port)) {
    return null;
  }
  // A wildcard bind is reachable on loopback, which is what the scanner probes.
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "localhost";
  url.hash = "";
  return url.href;
}

/**
 * Incremental scanner over one terminal's output: carries a partial line
 * between chunks so a URL split across two writes is still found. Returns every
 * URL on the completed lines; the port scanner deduplicates.
 */
export function createTerminalUrlScanner() {
  let partial = "";
  return {
    push(chunk: string): ReadonlyArray<string> {
      const text = `${partial}${chunk}`;
      const lastNewline = text.lastIndexOf("\n");
      partial = (lastNewline === -1 ? text : text.slice(lastNewline + 1)).slice(-PARTIAL_LINE_MAX);
      if (lastNewline === -1) return [];
      const raw = text.slice(0, lastNewline);
      // Most output names no URL; skip the escape stripping and the match for it.
      if (!raw.includes("://")) return [];
      const found = new Set<string>();
      const complete = raw.replaceAll(TERMINAL_CONTROL_SEQUENCES, "");
      for (const match of complete.matchAll(LOOPBACK_URL)) {
        const url = normalizeAnnouncedUrl(match[0]);
        if (url !== null) found.add(url);
      }
      return [...found];
    },
    reset(): void {
      partial = "";
    },
  };
}

export type TerminalUrlScanner = ReturnType<typeof createTerminalUrlScanner>;
