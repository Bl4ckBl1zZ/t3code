import {
  LOCAL_BROWSER_AGENT_SESSION_ID,
  type AuthSessionId,
  type BrowserAgentId,
  type BrowserAgentListResult,
} from "@t3tools/contracts";
import {
  BROWSER_AGENT_AUTO_PAIR_PATH,
  BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH,
} from "@t3tools/shared/browserAgent";

import { selectPairingEndpoint } from "./advertisedEndpointSelection";
import { readPrimaryEnvironmentTarget } from "./environments/primary/target";
import { useUiStateStore } from "./uiStateStore";

export { BROWSER_AGENT_AUTO_PAIR_PATH, BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH };
const AUTO_PAIR_REQUEST_TYPE = "t3code.browserAgent.autoPair";
const AUTO_PAIR_RESULT_TYPE = "t3code.browserAgent.autoPair.result";
const AUTO_CONNECT_REQUEST_TYPE = "t3code.browserAgent.autoConnect";
const AUTO_CONNECT_RESULT_TYPE = "t3code.browserAgent.autoConnect.result";
const AUTO_PAIR_CONNECT_TIMEOUT_MS = 12_000;
const AUTO_PAIR_STRICT_SESSION_TIMEOUT_MS = 2_000;
const AUTO_PAIR_CONTENT_SCRIPT_TIMEOUT_MS = 8_000;
const AUTO_PAIR_CONTENT_SCRIPT_CONNECTED_FALLBACK_TIMEOUT_MS = 750;
const AUTO_CONNECT_CONTENT_SCRIPT_TIMEOUT_MS = 1_500;
const AUTO_PAIR_POLL_INTERVAL_MS = 250;
const BROWSER_AGENT_PAIRING_DEBUG_PREFIX = "[t3 browser-agent pairing]";

type BrowserAgentSnapshotAgent = BrowserAgentListResult["agents"][number];
type PreviewAgentSelectionKind = "exact-session" | "local-control" | "remote-fallback";

interface PreviewAgentSelection {
  readonly kind: PreviewAgentSelectionKind;
  readonly agent: BrowserAgentSnapshotAgent;
}

interface BrowserAgentListClient {
  readonly browserAgents: {
    readonly list: () => Promise<BrowserAgentListResult>;
  };
}

interface WaitForBrowserAgentConnectionOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sessionId?: AuthSessionId | string | null;
}

interface AutoPairContentScriptResult {
  readonly ok: boolean;
  readonly sessionId?: AuthSessionId;
  readonly error?: string;
}

interface AutoConnectContentScriptResult {
  readonly ok: boolean;
  readonly error?: string;
}

interface AutoPairBrowserAgentOptions {
  readonly baseUrl?: string | null | undefined;
  readonly allowExternalBrowserLaunch?: boolean;
}

export interface BrowserAgentPairingResult {
  readonly preferredAgentId: BrowserAgentId | null;
  readonly preferredSessionId: AuthSessionId | null;
}

export class BrowserAgentExtensionUnavailableError extends Error {
  readonly downloadUrl: string;
  readonly setupUrl: string;

  constructor(input: {
    readonly downloadUrl: string;
    readonly setupUrl?: string;
    readonly cause?: unknown;
  }) {
    super(
      "The T3 Code Browser Agent Chrome extension is not installed or is not running in this browser.",
    );
    this.name = "BrowserAgentExtensionUnavailableError";
    this.downloadUrl = input.downloadUrl;
    this.setupUrl = input.setupUrl ?? input.downloadUrl;
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function randomRequestId(): string {
  return `browser-agent-auto-pair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function logBrowserAgentPairingDebug(event: string, details: Record<string, unknown>): void {
  if (typeof console === "undefined") {
    return;
  }
  console.info(`${BROWSER_AGENT_PAIRING_DEBUG_PREFIX} ${event}`, details);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function summarizeBrowserAgentSnapshot(snapshot: BrowserAgentListResult): string {
  const currentSessionId = snapshot.currentSessionId ?? null;
  const connectedAgents = snapshot.agents.filter((agent) => agent.connected);
  const currentSessionAgents =
    currentSessionId === null
      ? connectedAgents
      : connectedAgents.filter((agent) => agent.sessionId === currentSessionId);
  const connectedSessionIds = Array.from(
    new Set(connectedAgents.map((agent) => agent.sessionId ?? "unknown")),
  );
  const connectedAgentIds = connectedAgents.map((agent) => {
    const localControl = agent.sessionId === LOCAL_BROWSER_AGENT_SESSION_ID ? ":local-control" : "";
    return `${agent.id ?? "unknown"}@${agent.sessionId ?? "unknown"}${localControl}`;
  });

  return [
    `currentSessionId=${currentSessionId ?? "none"}`,
    `currentSessionAgents=${currentSessionAgents.length}`,
    `connectedAgents=${connectedAgents.length}`,
    `agentCount=${snapshot.agents.length}`,
    connectedSessionIds.length > 0
      ? `connectedSessionIds=${connectedSessionIds.join(",")}`
      : "connectedSessionIds=none",
    connectedAgentIds.length > 0
      ? `connectedAgentIds=${connectedAgentIds.join(",")}`
      : "connectedAgentIds=none",
  ].join(", ");
}

function selectMostRecentAgent(
  agents: readonly BrowserAgentSnapshotAgent[],
): BrowserAgentSnapshotAgent | null {
  return (
    agents.toSorted((left, right) =>
      String(right.lastSeenAt ?? "").localeCompare(String(left.lastSeenAt ?? "")),
    )[0] ?? null
  );
}

function selectConnectedBrowserAgent(
  snapshot: BrowserAgentListResult,
  sessionId?: AuthSessionId | string | null,
): BrowserAgentSnapshotAgent | null {
  return selectMostRecentAgent(
    snapshot.agents.filter(
      (agent) =>
        agent.connected &&
        (sessionId === undefined || sessionId === null || agent.sessionId === sessionId),
    ),
  );
}

function selectConnectedRemotePairingAgent(
  snapshot: BrowserAgentListResult,
): BrowserAgentSnapshotAgent | null {
  return selectMostRecentAgent(selectConnectedRemotePairingAgents(snapshot));
}

function selectConnectedLocalControlBrowserAgent(
  snapshot: BrowserAgentListResult,
): BrowserAgentSnapshotAgent | null {
  return selectMostRecentAgent(
    snapshot.agents.filter(
      (agent) => agent.connected && agent.sessionId === LOCAL_BROWSER_AGENT_SESSION_ID,
    ),
  );
}

function selectConnectedPreviewPairingAgent(
  snapshot: BrowserAgentListResult,
): BrowserAgentSnapshotAgent | null {
  return (
    selectConnectedLocalControlBrowserAgent(snapshot) ?? selectConnectedRemotePairingAgent(snapshot)
  );
}

function selectPreviewAgentFromSnapshot(
  snapshot: BrowserAgentListResult,
  preferredSessionId: AuthSessionId | null,
): PreviewAgentSelection | null {
  const exactAgent =
    preferredSessionId === null ? null : selectConnectedBrowserAgent(snapshot, preferredSessionId);
  if (exactAgent) {
    return { kind: "exact-session", agent: exactAgent };
  }

  const localControlAgent = selectConnectedLocalControlBrowserAgent(snapshot);
  if (localControlAgent) {
    return { kind: "local-control", agent: localControlAgent };
  }

  const remoteAgents = selectConnectedRemotePairingAgents(snapshot);
  const onlyRemoteAgent = remoteAgents[0];
  return remoteAgents.length === 1 && onlyRemoteAgent
    ? { kind: "remote-fallback", agent: onlyRemoteAgent }
    : null;
}

function pairingResultForSelection(
  selection: PreviewAgentSelection,
  preferredSessionId: AuthSessionId | null,
): BrowserAgentPairingResult {
  return {
    preferredAgentId: selection.agent.id,
    preferredSessionId:
      selection.kind === "exact-session" && selection.agent.sessionId === preferredSessionId
        ? preferredSessionId
        : null,
  };
}

function autoPairSelectionLogEvent(selection: PreviewAgentSelection): string {
  switch (selection.kind) {
    case "exact-session":
      return "auto-pair-complete-exact-agent";
    case "local-control":
      return "auto-pair-complete-local-control-agent";
    case "remote-fallback":
      return "auto-pair-complete-remote-fallback-agent";
  }
}

function logAutoPairSelection(input: {
  readonly baseUrl: string;
  readonly selection: PreviewAgentSelection;
  readonly preferredSessionId: AuthSessionId | null;
  readonly snapshot?: BrowserAgentListResult;
  readonly event?: string;
}): void {
  logBrowserAgentPairingDebug(input.event ?? autoPairSelectionLogEvent(input.selection), {
    baseUrl: input.baseUrl,
    preferredAgentId: input.selection.agent.id,
    selectedSessionId: input.selection.agent.sessionId,
    selectionKind: input.selection.kind,
    preferredSessionId: input.preferredSessionId,
    ...(input.snapshot ? { snapshot: summarizeBrowserAgentSnapshot(input.snapshot) } : {}),
  });
}

function selectConnectedRemotePairingAgents(
  snapshot: BrowserAgentListResult,
): readonly BrowserAgentSnapshotAgent[] {
  return snapshot.agents.filter(
    (agent) => agent.connected && agent.sessionId !== LOCAL_BROWSER_AGENT_SESSION_ID,
  );
}

function normalizeBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sameOriginAsCurrentPage(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

function uniqueBaseUrls(baseUrls: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const baseUrl of baseUrls) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

export async function resolveBrowserAgentBackendBaseUrl(): Promise<string> {
  const getAdvertisedEndpoints = window.desktopBridge?.getAdvertisedEndpoints;
  const advertisedEndpoints = getAdvertisedEndpoints
    ? await getAdvertisedEndpoints().catch(() => [])
    : undefined;
  if (advertisedEndpoints && advertisedEndpoints.length > 0) {
    const endpoint = selectPairingEndpoint(
      advertisedEndpoints,
      useUiStateStore.getState().defaultAdvertisedEndpointKey,
    );
    if (endpoint) {
      return normalizeBaseUrl(endpoint.httpBaseUrl);
    }
  }

  const target = readPrimaryEnvironmentTarget();
  if (!target) {
    throw new Error("Unable to resolve the primary environment URL for browser pairing.");
  }
  return normalizeBaseUrl(target.target.httpBaseUrl);
}

export async function resolveBrowserAgentAutoConnectBaseUrls(
  pairingBaseUrl: string,
): Promise<readonly string[]> {
  const getAdvertisedEndpoints = window.desktopBridge?.getAdvertisedEndpoints;
  const advertisedEndpoints = getAdvertisedEndpoints
    ? await getAdvertisedEndpoints().catch(() => [])
    : [];
  const loopbackEndpoints = advertisedEndpoints
    .filter((endpoint) => endpoint.reachability === "loopback")
    .map((endpoint) => endpoint.httpBaseUrl);
  const target = readPrimaryEnvironmentTarget();
  return uniqueBaseUrls([
    ...loopbackEndpoints,
    ...(target ? [target.target.httpBaseUrl] : []),
    pairingBaseUrl,
  ]);
}

export function buildBrowserAgentAutoPairUrl(input: {
  readonly baseUrl: string;
  readonly credential?: string;
  readonly sessionToken?: string;
  readonly useBrowserSession?: boolean;
}): string {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const url = new URL(BROWSER_AGENT_AUTO_PAIR_PATH, baseUrl);
  url.searchParams.set("t3BrowserAgentPair", "1");
  url.searchParams.set("t3BrowserAgentBaseUrl", baseUrl);
  url.searchParams.set("t3BrowserAgentClose", "1");
  if (input.useBrowserSession === true) {
    url.searchParams.set("t3BrowserAgentUseBrowserSession", "1");
  }
  const hashParams = new URLSearchParams();
  if (input.credential) {
    hashParams.set("t3BrowserAgentCredential", input.credential);
  }
  if (input.sessionToken) {
    hashParams.set("t3BrowserAgentSessionToken", input.sessionToken);
  }
  url.hash = hashParams.toString();
  return url.toString();
}

export function buildBrowserAgentExtensionDownloadUrl(input: { readonly baseUrl: string }): string {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const url = new URL(BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH, baseUrl);
  return url.toString();
}

export function isBrowserAgentExtensionUnavailableError(
  error: unknown,
): error is BrowserAgentExtensionUnavailableError {
  return error instanceof BrowserAgentExtensionUnavailableError;
}

export function isNoBrowserAgentConnectedError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "no-agent-connected"
  ) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return /no (paired browser extension|browser extension local-control session) is connected/i.test(
    message,
  );
}

async function requestContentScriptPair(input: {
  readonly baseUrl: string;
  readonly credential?: string;
  readonly sessionToken?: string;
  readonly useBrowserSession?: boolean;
  readonly timeoutMs?: number;
}): Promise<AutoPairContentScriptResult | null> {
  if (!sameOriginAsCurrentPage(input.baseUrl)) {
    logBrowserAgentPairingDebug("content-script-pair-skipped-cross-origin", {
      baseUrl: input.baseUrl,
      currentOrigin: window.location.origin,
    });
    return null;
  }

  const requestId = randomRequestId();
  const timeoutMs = input.timeoutMs ?? AUTO_PAIR_CONTENT_SCRIPT_TIMEOUT_MS;
  logBrowserAgentPairingDebug("content-script-pair-request", {
    requestId,
    baseUrl: input.baseUrl,
    hasCredential: Boolean(input.credential),
    hasSessionToken: Boolean(input.sessionToken),
    useBrowserSession: input.useBrowserSession === true,
    timeoutMs,
  });

  return await new Promise<AutoPairContentScriptResult | null>((resolve, reject) => {
    let settled = false;
    let timeoutId: number | null = null;
    const cleanup = () => {
      settled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("message", onMessage);
    };
    const finish = (result: AutoPairContentScriptResult | null) => {
      if (settled) return;
      cleanup();
      if (!result) {
        logBrowserAgentPairingDebug("content-script-pair-timeout", {
          requestId,
          baseUrl: input.baseUrl,
          timeoutMs,
        });
        resolve(null);
        return;
      }
      logBrowserAgentPairingDebug("content-script-pair-result", {
        requestId,
        baseUrl: input.baseUrl,
        ok: result.ok,
        sessionId: result.sessionId ?? null,
        error: result.error ?? null,
      });
      if (result.ok) {
        resolve(result);
        return;
      }
      reject(new Error(result.error ?? "The browser extension rejected the pairing request."));
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as
        | {
            readonly type?: unknown;
            readonly requestId?: unknown;
            readonly ok?: unknown;
            readonly sessionId?: unknown;
            readonly error?: unknown;
          }
        | undefined;
      if (data?.type !== AUTO_PAIR_RESULT_TYPE || data.requestId !== requestId) {
        return;
      }
      finish({
        ok: data.ok === true,
        ...(typeof data.sessionId === "string"
          ? { sessionId: data.sessionId as AuthSessionId }
          : {}),
        ...(typeof data.error === "string" ? { error: data.error } : {}),
      });
    };
    timeoutId = window.setTimeout(() => finish(null), timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        type: AUTO_PAIR_REQUEST_TYPE,
        requestId,
        baseUrl: input.baseUrl,
        ...(input.credential ? { credential: input.credential } : {}),
        ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
        ...(input.useBrowserSession ? { useBrowserSession: true } : {}),
      },
      window.location.origin,
    );
  });
}

async function requestContentScriptAutoConnect(input: {
  readonly pageBaseUrl: string;
  readonly baseUrls: readonly string[];
  readonly timeoutMs?: number;
}): Promise<boolean> {
  if (!sameOriginAsCurrentPage(input.pageBaseUrl)) {
    return false;
  }

  const requestId = randomRequestId();
  const timeoutMs = input.timeoutMs ?? AUTO_CONNECT_CONTENT_SCRIPT_TIMEOUT_MS;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
    };
    const finish = (result: AutoConnectContentScriptResult | null) => {
      if (settled) return;
      cleanup();
      resolve(result?.ok === true);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as
        | {
            readonly type?: unknown;
            readonly requestId?: unknown;
            readonly ok?: unknown;
            readonly error?: unknown;
          }
        | undefined;
      if (data?.type !== AUTO_CONNECT_RESULT_TYPE || data.requestId !== requestId) {
        return;
      }
      finish({
        ok: data.ok === true,
        ...(typeof data.error === "string" ? { error: data.error } : {}),
      });
    };
    const timeoutId = window.setTimeout(() => finish(null), timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        type: AUTO_CONNECT_REQUEST_TYPE,
        requestId,
        pageBaseUrl: input.pageBaseUrl,
        baseUrls: input.baseUrls,
      },
      window.location.origin,
    );
  });
}

async function waitForBrowserAgentMatch(
  client: BrowserAgentListClient,
  options?: WaitForBrowserAgentConnectionOptions,
  selectAgent: (snapshot: BrowserAgentListResult) => BrowserAgentSnapshotAgent | null = (
    snapshot,
  ) => selectConnectedBrowserAgent(snapshot, options?.sessionId),
): Promise<BrowserAgentSnapshotAgent> {
  const timeoutMs = options?.timeoutMs ?? AUTO_PAIR_CONNECT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? AUTO_PAIR_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let lastSnapshot: BrowserAgentListResult | null = null;

  do {
    try {
      const snapshot = await client.browserAgents.list();
      lastSnapshot = snapshot;
      const agent = selectAgent(snapshot);
      if (agent) {
        return agent;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);

  const snapshotDetail = lastSnapshot
    ? ` Last browser-agent snapshot: ${summarizeBrowserAgentSnapshot(lastSnapshot)}.`
    : "";
  if (lastError instanceof Error) {
    throw new Error(
      `Browser extension did not connect after pairing: ${lastError.message}.${snapshotDetail}`,
    );
  }
  throw new Error(
    `Browser extension did not connect after pairing. Reload the T3 Code Browser Agent extension and try again.${snapshotDetail}`,
  );
}

export async function waitForBrowserAgentConnection(
  client: BrowserAgentListClient,
  options?: WaitForBrowserAgentConnectionOptions,
): Promise<void> {
  await waitForBrowserAgentMatch(client, options);
}

export async function autoPairBrowserAgent(
  client: BrowserAgentListClient,
  options?: AutoPairBrowserAgentOptions,
): Promise<BrowserAgentPairingResult> {
  const baseUrl = options?.baseUrl
    ? normalizeBaseUrl(options.baseUrl)
    : await resolveBrowserAgentBackendBaseUrl();
  const downloadUrl = buildBrowserAgentExtensionDownloadUrl({ baseUrl });
  const setupUrl = buildBrowserAgentAutoPairUrl({ baseUrl, useBrowserSession: true });
  logBrowserAgentPairingDebug("auto-pair-start", {
    baseUrl,
    currentOrigin: typeof window !== "undefined" ? window.location.origin : null,
    sameOrigin: sameOriginAsCurrentPage(baseUrl),
    allowExternalBrowserLaunch: options?.allowExternalBrowserLaunch !== false,
    setupUrlMode: "browser-session",
  });

  if (sameOriginAsCurrentPage(baseUrl)) {
    const fallbackSnapshot = await client.browserAgents.list().catch(() => null);
    const fallbackSelection = fallbackSnapshot
      ? selectPreviewAgentFromSnapshot(fallbackSnapshot, null)
      : null;
    if (fallbackSelection && fallbackSnapshot) {
      logBrowserAgentPairingDebug("auto-pair-existing-agent-before-content-script", {
        baseUrl,
        contentScriptTimeoutMs: AUTO_PAIR_CONTENT_SCRIPT_CONNECTED_FALLBACK_TIMEOUT_MS,
        fallbackAgentId: fallbackSelection.agent.id,
        fallbackSessionId: fallbackSelection.agent.sessionId ?? null,
        fallbackKind: fallbackSelection.kind,
        snapshot: summarizeBrowserAgentSnapshot(fallbackSnapshot),
      });
    }
    let pairResult: AutoPairContentScriptResult | null = null;
    try {
      pairResult = await requestContentScriptPair({
        baseUrl,
        useBrowserSession: true,
        ...(fallbackSelection
          ? { timeoutMs: AUTO_PAIR_CONTENT_SCRIPT_CONNECTED_FALLBACK_TIMEOUT_MS }
          : {}),
      });
    } catch (error) {
      logBrowserAgentPairingDebug("auto-pair-browser-session-pair-failed", {
        baseUrl,
        setupUrl,
        error: errorMessage(error),
      });
      throw new BrowserAgentExtensionUnavailableError({
        downloadUrl,
        setupUrl,
        cause: error,
      });
    }
    if (!pairResult) {
      if (fallbackSelection) {
        logAutoPairSelection({
          baseUrl,
          selection: fallbackSelection,
          preferredSessionId: null,
          ...(fallbackSnapshot ? { snapshot: fallbackSnapshot } : {}),
          event: "auto-pair-complete-existing-agent-no-content-script",
        });
        return pairingResultForSelection(fallbackSelection, null);
      }
      logBrowserAgentPairingDebug("auto-pair-no-content-script-result", {
        baseUrl,
        setupUrl,
      });
      throw new BrowserAgentExtensionUnavailableError({
        downloadUrl,
        setupUrl,
      });
    }
    const preferredSessionId = pairResult.sessionId ?? null;
    const initialSnapshot = await client.browserAgents.list().catch(() => null);
    if (initialSnapshot) {
      logBrowserAgentPairingDebug("auto-pair-initial-snapshot", {
        baseUrl,
        preferredSessionId,
        snapshot: summarizeBrowserAgentSnapshot(initialSnapshot),
      });
      const initialSelection = selectPreviewAgentFromSnapshot(initialSnapshot, preferredSessionId);
      if (initialSelection) {
        logAutoPairSelection({
          baseUrl,
          selection: initialSelection,
          preferredSessionId,
        });
        return pairingResultForSelection(initialSelection, preferredSessionId);
      }
    }

    try {
      const agent =
        preferredSessionId === null
          ? await waitForBrowserAgentMatch(
              client,
              { timeoutMs: AUTO_PAIR_CONNECT_TIMEOUT_MS },
              selectConnectedPreviewPairingAgent,
            )
          : await waitForBrowserAgentMatch(client, {
              sessionId: preferredSessionId,
              timeoutMs: AUTO_PAIR_STRICT_SESSION_TIMEOUT_MS,
            });
      const selection: PreviewAgentSelection = {
        kind:
          preferredSessionId !== null && agent.sessionId === preferredSessionId
            ? "exact-session"
            : agent.sessionId === LOCAL_BROWSER_AGENT_SESSION_ID
              ? "local-control"
              : "remote-fallback",
        agent,
      };
      logAutoPairSelection({
        baseUrl,
        selection,
        preferredSessionId,
        ...(selection.kind === "exact-session"
          ? { event: "auto-pair-complete-wait-exact-agent" }
          : {}),
      });
      return pairingResultForSelection(selection, preferredSessionId);
    } catch (error) {
      try {
        if (preferredSessionId === null) {
          throw error;
        }
        const fallbackAgent = await waitForBrowserAgentMatch(
          client,
          { timeoutMs: AUTO_PAIR_CONNECT_TIMEOUT_MS },
          selectConnectedPreviewPairingAgent,
        );
        const fallbackSelection: PreviewAgentSelection = {
          kind:
            fallbackAgent.sessionId === LOCAL_BROWSER_AGENT_SESSION_ID
              ? "local-control"
              : "remote-fallback",
          agent: fallbackAgent,
        };
        return {
          ...pairingResultForSelection(fallbackSelection, preferredSessionId),
        };
      } catch {
        logBrowserAgentPairingDebug("auto-pair-no-agent-after-pair", {
          baseUrl,
          setupUrl,
          preferredSessionId,
          error: errorMessage(error),
        });
        throw new BrowserAgentExtensionUnavailableError({
          downloadUrl,
          setupUrl,
          cause: error,
        });
      }
    }
  }

  const autoConnected = await requestContentScriptAutoConnect({
    pageBaseUrl: baseUrl,
    baseUrls: await resolveBrowserAgentAutoConnectBaseUrls(baseUrl),
  });
  if (autoConnected) {
    const agent = await waitForBrowserAgentMatch(client);
    logBrowserAgentPairingDebug("auto-pair-complete-auto-connect", {
      baseUrl,
      preferredAgentId: agent.id,
    });
    return { preferredAgentId: agent.id, preferredSessionId: null };
  }

  if (options?.allowExternalBrowserLaunch === false) {
    logBrowserAgentPairingDebug("auto-pair-needs-manual-setup-no-launch", {
      baseUrl,
      setupUrl,
    });
    throw new BrowserAgentExtensionUnavailableError({ downloadUrl, setupUrl });
  }

  logBrowserAgentPairingDebug("auto-pair-needs-manual-setup", {
    baseUrl,
    setupUrl,
  });
  throw new BrowserAgentExtensionUnavailableError({ downloadUrl, setupUrl });
}
