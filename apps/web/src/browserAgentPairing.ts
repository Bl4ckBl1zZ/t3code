import {
  LOCAL_BROWSER_AGENT_SESSION_ID,
  type AuthSessionId,
  type BrowserAgentId,
  type BrowserAgentListResult,
  type BrowserAgentSessionResult,
} from "@t3tools/contracts";
import {
  BROWSER_AGENT_AUTO_PAIR_PATH,
  BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH,
  BROWSER_AGENT_SESSION_PATH,
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
const AUTO_CONNECT_CONTENT_SCRIPT_TIMEOUT_MS = 1_500;
const AUTO_PAIR_POLL_INTERVAL_MS = 250;

type BrowserAgentSnapshotAgent = BrowserAgentListResult["agents"][number];

interface BrowserAgentListClient {
  readonly browserAgents: {
    readonly list: () => Promise<BrowserAgentListResult>;
    readonly issueSession?: () => Promise<BrowserAgentSessionResult>;
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

async function createBrowserAgentSessionFromHttp(
  baseUrl: string,
): Promise<BrowserAgentSessionResult> {
  const response = await fetch(new URL(BROWSER_AGENT_SESSION_PATH, baseUrl), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Unable to create a browser-agent session (${response.status}).`);
  }

  const result = (await response.json()) as {
    readonly sessionId?: unknown;
    readonly sessionToken?: unknown;
  };
  if (typeof result.sessionId !== "string" || typeof result.sessionToken !== "string") {
    throw new Error("The backend did not return a browser-agent session token.");
  }
  return {
    sessionId: result.sessionId as AuthSessionId,
    sessionToken: result.sessionToken,
  };
}

async function createBrowserAgentSession(
  client: BrowserAgentListClient,
  baseUrl: string,
): Promise<BrowserAgentSessionResult> {
  const issueSession = client.browserAgents.issueSession;
  if (issueSession) {
    try {
      return await issueSession();
    } catch {
      // BACKWARD COMPATIBILITY: older servers do not expose the RPC method yet.
    }
  }
  return await createBrowserAgentSessionFromHttp(baseUrl);
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
    return null;
  }

  const requestId = randomRequestId();
  const timeoutMs = input.timeoutMs ?? AUTO_PAIR_CONTENT_SCRIPT_TIMEOUT_MS;

  return await new Promise<AutoPairContentScriptResult | null>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
    };
    const finish = (result: AutoPairContentScriptResult | null) => {
      if (settled) return;
      cleanup();
      if (!result) {
        resolve(null);
        return;
      }
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
    const timeoutId = window.setTimeout(() => finish(null), timeoutMs);

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

  if (sameOriginAsCurrentPage(baseUrl)) {
    let pairResult: AutoPairContentScriptResult | null = null;
    let session: BrowserAgentSessionResult;
    let issuedSessionSetupUrl: string | null = null;
    try {
      session = await createBrowserAgentSession(client, baseUrl);
      issuedSessionSetupUrl = buildBrowserAgentAutoPairUrl({
        baseUrl,
        sessionToken: session.sessionToken,
      });
      pairResult = await requestContentScriptPair({
        baseUrl,
        sessionToken: session.sessionToken,
      });
    } catch (error) {
      throw new BrowserAgentExtensionUnavailableError({
        downloadUrl,
        setupUrl: issuedSessionSetupUrl ?? setupUrl,
        cause: error,
      });
    }
    if (!pairResult) {
      throw new BrowserAgentExtensionUnavailableError({
        downloadUrl,
        setupUrl: issuedSessionSetupUrl ?? setupUrl,
      });
    }
    const preferredSessionId = pairResult.sessionId ?? session.sessionId;
    const initialSnapshot = await client.browserAgents.list().catch(() => null);
    if (initialSnapshot) {
      const exactAgent = selectConnectedBrowserAgent(initialSnapshot, preferredSessionId);
      if (exactAgent) {
        return { preferredAgentId: exactAgent.id, preferredSessionId };
      }
      const remoteAgents = selectConnectedRemotePairingAgents(initialSnapshot);
      const onlyRemoteAgent = remoteAgents[0];
      if (remoteAgents.length === 1 && onlyRemoteAgent) {
        return { preferredAgentId: onlyRemoteAgent.id, preferredSessionId };
      }
    }

    try {
      const agent = await waitForBrowserAgentMatch(client, {
        sessionId: preferredSessionId,
        timeoutMs: AUTO_PAIR_STRICT_SESSION_TIMEOUT_MS,
      });
      return { preferredAgentId: agent.id, preferredSessionId };
    } catch (error) {
      try {
        const fallbackAgent = await waitForBrowserAgentMatch(
          client,
          { timeoutMs: AUTO_PAIR_CONNECT_TIMEOUT_MS },
          selectConnectedRemotePairingAgent,
        );
        return {
          preferredAgentId: fallbackAgent.id,
          preferredSessionId,
        };
      } catch {
        throw new BrowserAgentExtensionUnavailableError({
          downloadUrl,
          setupUrl: issuedSessionSetupUrl ?? setupUrl,
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
    return { preferredAgentId: agent.id, preferredSessionId: null };
  }

  if (options?.allowExternalBrowserLaunch === false) {
    throw new BrowserAgentExtensionUnavailableError({ downloadUrl, setupUrl });
  }

  throw new BrowserAgentExtensionUnavailableError({ downloadUrl, setupUrl });
}
