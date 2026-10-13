import type { DiscoveredLocalServer, ThreadId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

export interface ThreadPortRow {
  readonly key: string;
  /** The URL as the environment sees it; loopback until a client resolves it. */
  readonly url: string;
  /** host:port and base path, never the query, where access tokens live. */
  readonly label: string;
  /**
   * `running` and `stopped` are known for loopback only, the one place the
   * scanner can see. A pinned remote origin is just `pinned`: its liveness is
   * not something this environment can report.
   */
  readonly status: "running" | "stopped" | "pinned";
  /** From the project's `t3.json`: listed whether or not anything serves it. */
  readonly pinned: boolean;
  readonly processName: string | null;
}

function serverKey(host: string, port: number): string {
  const normalized = host.toLowerCase();
  return `${isLoopbackHost(normalized) ? "loopback" : normalized}:${port}`;
}

function urlPort(url: URL): number {
  if (url.port.length > 0) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" ? 443 : 80;
}

function urlLabel(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
  return `${url.host}${path}`;
}

function parseHttpUrl(raw: string | null | undefined): URL | null {
  if (raw == null) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** True when the pinned URL is a local server whose liveness the scanner should probe. */
export function isLoopbackPreviewUrl(raw: string | null | undefined): boolean {
  const url = parseHttpUrl(raw);
  return url !== null && isLoopbackHost(url.hostname);
}

/**
 * The servers a thread runs, by the terminals that started or announced them,
 * with the project's pinned `previewUrl` first.
 */
export function threadPortRows(input: {
  readonly threadId: ThreadId;
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly pinnedUrl: string | null | undefined;
}): ReadonlyArray<ThreadPortRow> {
  const rows: Array<ThreadPortRow> = [];
  const pinned = parseHttpUrl(input.pinnedUrl);
  let pinnedKey: string | null = null;
  if (pinned !== null) {
    const local = isLoopbackHost(pinned.hostname);
    pinnedKey = serverKey(pinned.hostname, urlPort(pinned));
    const live = local
      ? input.servers.find((server) => serverKey(server.host, server.port) === pinnedKey)
      : undefined;
    rows.push({
      key: `pinned:${pinnedKey}`,
      url: pinned.href,
      label: urlLabel(pinned),
      status: !local ? "pinned" : live === undefined ? "stopped" : "running",
      pinned: true,
      processName: live?.processName ?? null,
    });
  }
  const own = input.servers
    .filter(
      (server) =>
        server.terminal?.threadId === input.threadId &&
        serverKey(server.host, server.port) !== pinnedKey,
    )
    .toSorted((left, right) => left.port - right.port);
  for (const server of own) {
    const url = parseHttpUrl(server.url);
    rows.push({
      key: serverKey(server.host, server.port),
      url: server.url,
      label: url === null ? `${server.host}:${server.port}` : urlLabel(url),
      status: "running",
      pinned: false,
      processName: server.processName,
    });
  }
  return rows;
}
