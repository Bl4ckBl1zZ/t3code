import type { DiscoveredLocalServer, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  mergeThreadEndpoints,
  nextEndpointState,
  type PreviousEndpointState,
  type ThreadEndpoint,
} from "@t3tools/shared/threadEndpoints";
import { useEffect, useMemo, useRef, useState } from "react";

import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";
import { readPreparedConnection } from "./state/session";
import { terminalEnvironment } from "./state/terminal";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);
const EMPTY_ENDPOINTS: ReadonlyArray<ThreadEndpoint> = Object.freeze([]);
const EMPTY_DECLARED: ReadonlyArray<string> = Object.freeze([]);

function portOfUrl(rawUrl: string): number | null {
  try {
    const parsed = new URL(rawUrl);
    const explicit = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : null;
    const implied = parsed.protocol === "https:" ? 443 : 80;
    const port = explicit ?? implied;
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

export function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DiscoveredLocalServer> {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewEnvironment.discoveredServers({ environmentId, input: {} }),
  );
  return query.data?.servers ?? EMPTY_PORTS;
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId
        ? ports.filter((port) => port.terminal?.threadId === input.threadId)
        : EMPTY_PORTS,
    [input.threadId, ports],
  );
}

export function useTerminalDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly terminalId: string | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId && input.terminalId
        ? ports.filter(
            (port) =>
              port.terminal?.threadId === input.threadId &&
              port.terminal.terminalId === input.terminalId,
          )
        : EMPTY_PORTS,
    [input.terminalId, input.threadId, ports],
  );
}

/**
 * Ports T3 itself is listening on. Without this every thread advertises the
 * server it is running inside as one of its own endpoints.
 */
function environmentOwnPorts(environmentId: EnvironmentId | null): ReadonlySet<number> {
  if (environmentId === null) return new Set();
  try {
    const connection = readPreparedConnection(environmentId);
    if (!connection) return new Set();
    const url = new URL(connection.httpBaseUrl);
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : null;
    return port === null || !Number.isInteger(port) ? new Set() : new Set([port]);
  } catch {
    return new Set();
  }
}

/** How often to re-evaluate while an endpoint is waiting out the stale grace window. */
const ENDPOINT_TICK_MS = 1_000;

/**
 * Live dev-server endpoints owned by one thread.
 *
 * Merges the two signals that each cover the other's blind spot: URLs the
 * process announced in its output (instant, and the only source of scheme and
 * base path) and sockets the scanner sees listening (ground truth for
 * liveness, in any language).
 *
 * The scanner subscription is deliberately conditional. Retaining it makes the
 * server shell out to `lsof` every few seconds, so it is only held while this
 * thread actually has something running — output detection means the section
 * still appears the instant a server starts, before the scanner is consulted.
 */
export function useThreadEndpoints(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly declaredUrls?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<ThreadEndpoint> {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({ environmentId: input.environmentId, input: null }),
  );

  const terminals = useMemo(
    () =>
      input.threadId === null
        ? []
        : (metadata.data ?? []).filter((summary) => summary.threadId === input.threadId),
    [metadata.data, input.threadId],
  );

  const hasLiveWork = terminals.some(
    (summary) => summary.hasRunningSubprocess || (summary.detectedUrls?.length ?? 0) > 0,
  );
  const scanned = useDiscoveredPorts(hasLiveWork ? input.environmentId : null);

  const declaredUrls = input.declaredUrls ?? EMPTY_DECLARED;
  const excludedPorts = useMemo(
    () => environmentOwnPorts(input.environmentId),
    [input.environmentId],
  );

  const previousRef = useRef<ReadonlyMap<number, PreviousEndpointState>>(new Map());
  const [tick, setTick] = useState(0);

  const endpoints = useMemo(() => {
    if (input.environmentId === null || input.threadId === null) return EMPTY_ENDPOINTS;
    const announcedPorts = new Set<number>();
    for (const summary of terminals) {
      for (const rawUrl of summary.detectedUrls ?? []) {
        const port = portOfUrl(rawUrl);
        if (port !== null) announcedPorts.add(port);
      }
    }
    // Unattributed sockets still belong to this thread when it announced the
    // same port: `lsof` can see the listener a tick before the process tree is
    // registered, and never sees containerised or detached servers at all.
    const relevant = scanned.filter(
      (server) => server.terminal?.threadId === input.threadId || announcedPorts.has(server.port),
    );
    return mergeThreadEndpoints({
      scanned: relevant,
      terminals,
      declaredUrls,
      previous: previousRef.current,
      nowMs: Date.now(),
      excludedPorts,
    });
    // `tick` is a deliberate dependency: it is what lets a stale endpoint age
    // out of the grace window when nothing else changes.
  }, [declaredUrls, excludedPorts, input.environmentId, input.threadId, scanned, terminals, tick]);

  useEffect(() => {
    previousRef.current = nextEndpointState(endpoints, previousRef.current, Date.now());
  }, [endpoints]);

  const awaitingExpiry = endpoints.some((endpoint) => endpoint.status !== "live");
  useEffect(() => {
    if (!awaitingExpiry) return;
    const id = setInterval(() => setTick((value) => value + 1), ENDPOINT_TICK_MS);
    return () => clearInterval(id);
  }, [awaitingExpiry]);

  return endpoints;
}
