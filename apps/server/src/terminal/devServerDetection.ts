export interface ProcessTreeRow {
  readonly pid: number;
  readonly ppid: number;
}

export interface ListeningProcessPort {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
}

export interface DetectedWebServerCandidate extends ListeningProcessPort {
  readonly url: string;
}

export function parsePsPidPpidOutput(stdout: string): ProcessTreeRow[] {
  const rows: ProcessTreeRow[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
    const pid = Number.parseInt(pidRaw ?? "", 10);
    const ppid = Number.parseInt(ppidRaw ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid < 0) {
      continue;
    }
    rows.push({ pid, ppid });
  }
  return rows;
}

export function collectProcessTreePids(
  rows: readonly ProcessTreeRow[],
  rootPid: number,
): Set<number> {
  const pids = new Set<number>();
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return pids;
  }

  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid);
    if (children) {
      children.push(row.pid);
    } else {
      childrenByParent.set(row.ppid, [row.pid]);
    }
  }

  const queue = [rootPid];
  for (const pid of queue) {
    if (pids.has(pid)) {
      continue;
    }
    pids.add(pid);
    const children = childrenByParent.get(pid);
    if (!children) {
      continue;
    }
    queue.push(...children);
  }

  return pids;
}

export function normalizeListeningHost(host: string): string {
  const trimmed = host.trim();
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const lower = withoutBrackets.toLowerCase();
  if (
    lower.length === 0 ||
    lower === "*" ||
    lower === "0.0.0.0" ||
    lower === "::" ||
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1"
  ) {
    return "localhost";
  }
  return withoutBrackets;
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function buildLocalHttpUrl(host: string, port: number): string | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }
  const normalizedHost = normalizeListeningHost(host);
  try {
    return new URL(`http://${urlHost(normalizedHost)}:${port}/`).toString();
  } catch {
    return null;
  }
}

function parseLsofEndpoint(
  endpoint: string,
): { readonly host: string; readonly port: number } | null {
  const match = /^(.*):(\d{1,5})$/.exec(endpoint.trim());
  if (!match) {
    return null;
  }
  const host = normalizeListeningHost(match[1] ?? "");
  const port = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }
  return { host, port };
}

export function parseLsofListeningPorts(
  stdout: string,
  allowedPids: ReadonlySet<number>,
): ListeningProcessPort[] {
  const ports: ListeningProcessPort[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("COMMAND ")) {
      continue;
    }

    const columns = trimmed.split(/\s+/g);
    const pid = Number.parseInt(columns[1] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0 || !allowedPids.has(pid)) {
      continue;
    }

    const tcpMatch = /\bTCP\s+(.+?)\s+\(LISTEN\)\s*$/.exec(trimmed);
    const endpoint = tcpMatch?.[1];
    if (!endpoint) {
      continue;
    }

    const parsed = parseLsofEndpoint(endpoint);
    if (!parsed) {
      continue;
    }

    const key = `${pid}:${parsed.host}:${parsed.port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ports.push({
      pid,
      host: parsed.host,
      port: parsed.port,
    });
  }

  return ports.toSorted((left, right) => left.port - right.port || left.pid - right.pid);
}

export function listeningPortsToWebServerCandidates(
  ports: readonly ListeningProcessPort[],
): DetectedWebServerCandidate[] {
  const candidates: DetectedWebServerCandidate[] = [];
  const seen = new Set<string>();

  for (const port of ports) {
    const host = normalizeListeningHost(port.host);
    const url = buildLocalHttpUrl(host, port.port);
    if (!url) {
      continue;
    }
    const key = `${port.pid}:${url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ ...port, host, url });
  }

  return candidates;
}
