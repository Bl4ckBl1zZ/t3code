import {
  AuthTerminalReadScope,
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  mergeThreadEndpoints,
  nextEndpointState,
  type PreviousEndpointState,
  type ThreadEndpoint,
} from "@t3tools/shared/threadEndpoints";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";

import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";
import { useEnvironmentScope, usePreparedConnection } from "./state/session";
import { terminalEnvironment } from "./state/terminal";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);
const EMPTY_ENDPOINTS: ReadonlyArray<ThreadEndpoint> = Object.freeze([]);
const EMPTY_DECLARED: ReadonlyArray<string> = Object.freeze([]);

interface DiscoveredPortsState {
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly configuredUrlProbing: boolean;
}

export function boundConfiguredLocalServerUrls(
  urls: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const bounded: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    if (raw.length === 0 || raw.length > PREVIEW_URL_MAX_LENGTH || raw.trim().length !== raw.length)
      continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!isLoopbackHost(url.hostname) || url.href.length > PREVIEW_URL_MAX_LENGTH) continue;
      const resourceUrl = new URL(url.href);
      resourceUrl.hash = "";
      if (seen.has(resourceUrl.href)) continue;
      seen.add(resourceUrl.href);
      bounded.push(url.href);
      if (bounded.length >= CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS) break;
    } catch {
      // Invalid and non-local project preview URLs are not discovery candidates.
    }
  }
  return bounded;
}

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
  configuredUrls?: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> {
  return useDiscoveredPortsState(environmentId, configuredUrls).servers;
}

export function useDiscoveredPortsState(
  environmentId: EnvironmentId | null,
  configuredUrls?: ReadonlyArray<string>,
): DiscoveredPortsState {
  const boundedConfiguredUrls = boundConfiguredLocalServerUrls(configuredUrls);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewEnvironment.discoveredServers({
          environmentId,
          input: boundedConfiguredUrls.length ? { configuredUrls: boundedConfiguredUrls } : {},
        }),
  );
  return useMemo(
    () => ({
      servers: query.data?.servers ?? EMPTY_PORTS,
      configuredUrlProbing: query.data?.configuredUrlProbing === true,
    }),
    [query.data?.configuredUrlProbing, query.data?.servers],
  );
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
function environmentOwnPorts(httpBaseUrl: string | null): ReadonlySet<number> {
  if (httpBaseUrl === null) return new Set();
  const port = portOfUrl(httpBaseUrl);
  return port === null ? new Set() : new Set([port]);
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
  readonly pinnedUrls?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<ThreadEndpoint> {
  const canReadTerminals = useEnvironmentScope(input.environmentId, AuthTerminalReadScope);
  const metadata = useEnvironmentQuery(
    input.environmentId === null || !canReadTerminals
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
  const pinnedUrls = input.pinnedUrls ?? EMPTY_DECLARED;
  // Subscribed rather than read imperatively: the panel usually mounts before
  // the connection is prepared, and a one-shot read at that moment would leave
  // T3's own port permanently un-excluded.
  const preparedConnection = usePreparedConnection(input.environmentId);
  const environmentHttpBaseUrl = Option.isSome(preparedConnection)
    ? preparedConnection.value.httpBaseUrl
    : null;
  const excludedPorts = useMemo(
    () => environmentOwnPorts(environmentHttpBaseUrl),
    [environmentHttpBaseUrl],
  );

  const previousRef = useRef<ReadonlyMap<string, PreviousEndpointState>>(new Map());
  // Endpoint history is keyed by endpoint, so it must not survive a change of
  // scope: the panel stays mounted across thread switches, and thread B's
  // freshly announced :3000 would otherwise inherit thread A's liveness and
  // appear stale — or be dropped outright — the moment it showed up.
  const scopeRef = useRef<string | null>(null);
  const scope = `${input.environmentId ?? ""}\u0000${input.threadId ?? ""}`;
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    previousRef.current = new Map();
  }
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
    // A socket attributed to *another* thread is never ours, even on a port we
    // once announced — otherwise a thread whose server died would adopt the
    // live one that took its port.
    const relevant = scanned.filter((server) =>
      server.terminal === null
        ? announcedPorts.has(server.port)
        : server.terminal.threadId === input.threadId,
    );
    return mergeThreadEndpoints({
      scanned: relevant,
      terminals,
      declaredUrls,
      pinnedUrls,
      previous: previousRef.current,
      nowMs: Date.now(),
      excludedPorts,
    });
    // `tick` is a deliberate dependency: it is what lets a stale endpoint age
    // out of the grace window when nothing else changes.
  }, [
    declaredUrls,
    excludedPorts,
    input.environmentId,
    input.threadId,
    pinnedUrls,
    scanned,
    terminals,
    tick,
  ]);

  useEffect(() => {
    previousRef.current = nextEndpointState(endpoints, previousRef.current, Date.now());
  }, [endpoints]);

  // `idle` is excluded deliberately: a pinned URL with nothing behind it has
  // nothing to age out of, and it is present on every thread of a configured
  // project — ticking for it would mean a re-render a second, forever.
  const awaitingExpiry = endpoints.some(
    (endpoint) => endpoint.status !== "live" && endpoint.status !== "idle",
  );
  useEffect(() => {
    if (!awaitingExpiry) return;
    const id = setInterval(() => setTick((value) => value + 1), ENDPOINT_TICK_MS);
    return () => clearInterval(id);
  }, [awaitingExpiry]);

  return endpoints;
}
