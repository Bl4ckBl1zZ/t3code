import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  endpointDisplayAddress,
  resolveEndpointUrl,
  type EndpointReachability,
} from "@t3tools/shared/endpointReachability";
import {
  mergeThreadEndpoints,
  nextEndpointState,
  type PreviousEndpointState,
  type ThreadEndpoint,
} from "@t3tools/shared/threadEndpoints";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef, useState } from "react";

import { previewEnvironment } from "./preview";
import { useEnvironmentQuery } from "./query";
import { usePreparedConnection } from "./session";
import { terminalEnvironment } from "./terminal";

/**
 * A thread endpoint plus how this device can actually reach it.
 *
 * Reachability is resolved here rather than at the call site because on a phone
 * it is not optional detail: `localhost` names the handset, so the announced
 * URL is meaningless until it has been rewritten against the environment.
 */
export interface MobileThreadEndpoint extends ThreadEndpoint {
  readonly reachability: EndpointReachability;
  /** Resolved `host:port` to display, or null when unreachable. */
  readonly displayAddress: string | null;
}

const EMPTY: ReadonlyArray<MobileThreadEndpoint> = Object.freeze([]);
const EMPTY_DECLARED: ReadonlyArray<string> = Object.freeze([]);

/** How often to re-evaluate while an endpoint waits out the stale grace window. */
const ENDPOINT_TICK_MS = 1_000;

function portOfUrl(rawUrl: string): number | null {
  try {
    const parsed = new URL(rawUrl);
    const explicit = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : null;
    const port = explicit ?? (parsed.protocol === "https:" ? 443 : 80);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

/**
 * Dev servers this thread is running, with a device-reachable URL for each.
 *
 * Merges the two server-side signals — URLs announced in terminal output and
 * sockets seen listening — using the same pure merge as the desktop panel. The
 * port-scanner subscription is only retained while the thread actually has
 * something running, since retaining it makes the server shell out to `lsof`
 * every few seconds.
 */
export function useThreadEndpoints(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly declaredUrls?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<MobileThreadEndpoint> {
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
  const discovered = useEnvironmentQuery(
    hasLiveWork && input.environmentId !== null
      ? previewEnvironment.discoveredServers({ environmentId: input.environmentId, input: {} })
      : null,
  );
  const scanned = discovered.data?.servers;

  const preparedConnection = usePreparedConnection(input.environmentId);
  const environmentHttpBaseUrl = Option.isSome(preparedConnection)
    ? preparedConnection.value.httpBaseUrl
    : null;

  const excludedPorts = useMemo(() => {
    // The environment's own port is not one of the thread's servers.
    if (environmentHttpBaseUrl === null) return new Set<number>();
    const port = portOfUrl(environmentHttpBaseUrl);
    return port === null ? new Set<number>() : new Set([port]);
  }, [environmentHttpBaseUrl]);

  const declaredUrls = input.declaredUrls ?? EMPTY_DECLARED;
  const previousRef = useRef<ReadonlyMap<string, PreviousEndpointState>>(new Map());
  // Endpoint history is keyed by endpoint, so it must not survive a change of
  // scope: thread B's freshly announced :3000 would otherwise inherit thread
  // A's liveness and appear stale — or be dropped — the moment it showed up.
  const scopeRef = useRef<string | null>(null);
  const scope = `${input.environmentId ?? ""} ${input.threadId ?? ""}`;
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    previousRef.current = new Map();
  }
  const [tick, setTick] = useState(0);

  const endpoints = useMemo(() => {
    if (input.environmentId === null || input.threadId === null) return EMPTY;

    const announcedPorts = new Set<number>();
    for (const summary of terminals) {
      for (const rawUrl of summary.detectedUrls ?? []) {
        const port = portOfUrl(rawUrl);
        if (port !== null) announcedPorts.add(port);
      }
    }
    // Unattributed sockets still belong to this thread when it announced the
    // same port: the scanner can see a listener before the process tree is
    // registered, and never sees containerised or detached servers at all.
    // A socket attributed to *another* thread is never ours, even on a port we
    // once announced — otherwise a thread whose server died would adopt the
    // live one that took its port.
    const relevant = (scanned ?? []).filter((server) =>
      server.terminal === null
        ? announcedPorts.has(server.port)
        : server.terminal.threadId === input.threadId,
    );

    return mergeThreadEndpoints({
      scanned: relevant,
      terminals,
      declaredUrls,
      previous: previousRef.current,
      nowMs: Date.now(),
      excludedPorts,
    }).map((endpoint) => {
      const reachability = resolveEndpointUrl({
        rawUrl: endpoint.url,
        environmentHttpBaseUrl,
      });
      return { ...endpoint, reachability, displayAddress: endpointDisplayAddress(reachability) };
    });
    // `tick` is a deliberate dependency: it is what lets a stale endpoint age
    // out of the grace window when nothing else changes.
  }, [
    declaredUrls,
    environmentHttpBaseUrl,
    excludedPorts,
    input.environmentId,
    input.threadId,
    scanned,
    terminals,
    tick,
  ]);

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
