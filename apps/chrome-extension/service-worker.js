const BACKEND_KEY = "t3code.browserAgent.backend";
const LINKS_KEY = "t3code.browserAgent.workspaceLinks";
const ACTIVE_LINK_KEY = "t3code.browserAgent.activeWorkspaceLink";
const SIDEBAR_SESSION_TOKENS_KEY = "t3code.browserAgent.sidebarSessionTokens";
const DIAGNOSTIC_LOG_LIMIT = 300;
const SIDE_PANEL_PATH = "sidepanel.html";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const AUTO_CONNECT_PATH = "/browser-agent/auto-connect";
const LOCAL_CONTROL_WS_PATH = "/browser-agent/local-ws";
const AUTO_CONNECT_ALARM_NAME = "t3code.browserAgent.autoConnect";
const AUTO_CONNECT_INTERVAL_MINUTES = 1;
const AUTO_CONNECT_REQUEST_TIMEOUT_MS = 800;
const AUTO_CONNECT_PORT_START = 3773;
const AUTO_CONNECT_PORT_COUNT = 12;
const WEBSOCKET_OPEN_TIMEOUT_MS = 5_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RUNTIME_PROTOCOL_VERSION = 2;
const RUNTIME_PRIMITIVES = [
  "preview.openOrFocus",
  "annotation.activate",
  "annotation.cancel",
  "annotation.captureElement",
  "workspace.create",
  "workspace.restore",
  "workspace.detach",
  "workspace.pauseControl",
  "workspace.resumeControl",
  "workspace.snapshot",
  "tab.create",
  "tab.attachActive",
  "tab.openOrFocusPrimary",
  "tab.focus",
  "tab.close",
  "tab.promoteToPrimary",
  "tab.rename",
  "tab.setPurpose",
  "tab.navigate",
  "tab.back",
  "tab.forward",
  "tab.reload",
  "tab.input",
  "tab.snapshot",
  "tab.screenshot",
  "tab.stream.start",
  "tab.stream.stop",
  "tab.capture.start",
  "tab.capture.stop",
  "sidePanel.open",
  "sidePanel.setThread",
  "sidePanel.clearThread",
  "sidePanel.syncActiveTab",
  "sidePanel.showOpenPrompt",
  "sidePanel.hideOpenPrompt",
  "cdp.send",
  "cdp.runtime.evaluate",
  "cdp.input.dispatch",
  "cdp.network.enable",
  "cdp.network.disable",
  "cdp.accessibility.snapshot",
  "cdp.console.read",
  "diagnostics.snapshot",
  "diagnostics.logs",
  "diagnostics.pingBackend",
  "diagnostics.forceReconnect",
  "diagnostics.clear",
  "threadTab.openOrFocus",
  "threadTab.attachActive",
  "threadTab.detach",
  "threadTab.capture.start",
  "threadTab.capture.stop",
  "threadTab.history",
  "threadTab.navigate",
  "threadTab.input",
  "threadTab.snapshot",
  "threadTab.screenshot",
  "tabs.snapshot",
];

let socket = null;
let socketBaseUrl = null;
let localControlBaseUrl = null;
let socketEventController = null;
let reconnectTimer = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
let currentBackend = null;
let connecting = null;
let workspaceLinksCache = [];
let lastConnectionAttemptAt = null;
let lastConnectionOpenedAt = null;
let lastConnectionError = null;
let lastHelloSentAt = null;
let lastTabsSnapshotSentAt = null;
let autoConnectInFlight = null;
let diagnosticLogs = [];
let cdpAttachedTabIds = new Set();
let liveCaptureWorkspaceLinkIds = new Set();
let cdpScreencastSessions = new Map();
let nextCdpScreencastFrameSequence = 0;
let sidebarSessionTokensCache = null;

function addDiagnosticLog(level, message, details = null) {
  diagnosticLogs.push({
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
  });
  if (diagnosticLogs.length > DIAGNOSTIC_LOG_LIMIT) {
    diagnosticLogs = diagnosticLogs.slice(-DIAGNOSTIC_LOG_LIMIT);
  }
}

function detectBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("brave")) return "brave";
  if (ua.includes("chromium")) return "chromium";
  if (ua.includes("chrome")) return "chrome";
  return "unknown";
}

function capabilityGroups() {
  return {
    workspace: RUNTIME_PRIMITIVES.filter(
      (primitive) => primitive.startsWith("workspace.") || primitive.startsWith("tab."),
    ),
    sidePanel: RUNTIME_PRIMITIVES.filter((primitive) => primitive.startsWith("sidePanel.")),
    annotation: RUNTIME_PRIMITIVES.filter((primitive) => primitive.startsWith("annotation.")),
    cdp: chrome.debugger
      ? RUNTIME_PRIMITIVES.filter((primitive) => primitive.startsWith("cdp."))
      : [],
    diagnostics: RUNTIME_PRIMITIVES.filter((primitive) => primitive.startsWith("diagnostics.")),
  };
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (url.pathname === "") {
      url.pathname = "/";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function wsUrlFor(baseUrl, token) {
  const url = new URL(`${baseUrl}/browser-agent/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsToken", token);
  return url.toString();
}

function localControlWsUrlFor(baseUrl) {
  const url = new URL(LOCAL_CONTROL_WS_PATH, `${baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function chatUrlForWorkspaceLink(baseUrl, link, sidebarSessionToken) {
  const url = new URL(
    `/${encodeURIComponent(link.environmentId)}/${encodeURIComponent(link.threadId)}`,
    `${baseUrl}/`,
  );
  url.searchParams.set("browserAgentSidebar", "1");
  url.searchParams.set("browserWorkspaceLinkId", link.id);
  if (typeof sidebarSessionToken === "string" && sidebarSessionToken.length > 0) {
    url.hash = new URLSearchParams([["token", sidebarSessionToken]]).toString();
  }
  return url.toString();
}

function activeBrowserAgentBaseUrl(backend = currentBackend) {
  return socketBaseUrl ?? localControlBaseUrl ?? backend?.baseUrl ?? null;
}

function hasActiveBrowserAgentTransport(backend = currentBackend) {
  return Boolean(backend) || socket?.readyState === WebSocket.OPEN || Boolean(localControlBaseUrl);
}

async function workspaceLinkForContent(link, tab = null, options = {}) {
  const backend = await readActivePairedBackend();
  const baseUrl = activeBrowserAgentBaseUrl(backend);
  const tabUrl = typeof tab?.url === "string" && tab.url.length > 0 ? tab.url : null;
  const workspaceId =
    typeof link.workspaceId === "string" && link.workspaceId.length > 0
      ? link.workspaceId
      : link.id;
  const browserControlState =
    link.controlState === "paused-by-user" || link.controlState === "paused-by-policy"
      ? "paused"
      : link.controlState === "unavailable"
        ? "off"
        : "deep";
  const nextLink = {
    ...link,
    workspaceId,
    browserControlState,
    deepControlEnabled: browserControlState === "deep",
    cdpAttached:
      link.cdpAttached === true || (tab?.id !== undefined && cdpAttachedTabIds.has(Number(tab.id))),
    role: link.role ?? "primary",
    purpose: link.purpose ?? null,
    owner: link.owner ?? { kind: "user" },
    lifecycle: link.lifecycle ?? "persistent",
    streamState: link.streamState ?? (link.captureState === "off" ? "off" : link.captureState),
    ...(link.devServerUrl === "about:blank" && tabUrl ? { devServerUrl: tabUrl } : {}),
    ...(tab?.id !== undefined ? { tabId: tab.id } : {}),
    ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
    ...(tabUrl ? { url: tabUrl } : {}),
    ...(typeof tab?.title === "string" ? { title: tab.title } : {}),
  };
  if (!baseUrl) {
    return nextLink;
  }
  const explicitSidebarSessionToken =
    typeof options.sidebarSessionToken === "string" && options.sidebarSessionToken.length > 0
      ? options.sidebarSessionToken
      : null;
  if (explicitSidebarSessionToken) {
    await writeSidebarSessionToken(nextLink.id, explicitSidebarSessionToken);
  }
  const sidebarSessionToken =
    explicitSidebarSessionToken ??
    backend?.sessionToken ??
    (await readSidebarSessionToken(nextLink.id));
  return {
    ...nextLink,
    t3Url: chatUrlForWorkspaceLink(baseUrl, nextLink, sidebarSessionToken),
  };
}

async function applyDefaultDeepControl(link, tab) {
  if (link.browserControlState !== "deep" || tab?.id === undefined) {
    return link;
  }
  try {
    await attachCdpToTab(tab.id);
    return {
      ...link,
      deepControlEnabled: true,
      cdpAttached: true,
    };
  } catch (error) {
    addDiagnosticLog("warn", "Default deep control attach failed", {
      tabId: tab.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ...link,
      deepControlEnabled: true,
      cdpAttached: false,
    };
  }
}

async function readBackend() {
  const stored = await chrome.storage.local.get(BACKEND_KEY);
  const backend = stored[BACKEND_KEY];
  if (!backend || typeof backend.baseUrl !== "string" || typeof backend.sessionToken !== "string") {
    return null;
  }
  return backend;
}

async function readActivePairedBackend() {
  return localControlBaseUrl ? null : (currentBackend ?? (await readBackend()));
}

async function writeBackend(backend) {
  localControlBaseUrl = null;
  currentBackend = backend;
  await chrome.storage.local.set({ [BACKEND_KEY]: backend });
}

async function clearBackend() {
  localControlBaseUrl = null;
  currentBackend = null;
  workspaceLinksCache = [];
  sidebarSessionTokensCache = null;
  closeSocket();
  await detachAllCdpTargets();
  await Promise.all([
    chrome.storage.local.remove([BACKEND_KEY, LINKS_KEY, ACTIVE_LINK_KEY]),
    sidebarSessionTokenStorageArea()
      .remove(SIDEBAR_SESSION_TOKENS_KEY)
      .catch(() => undefined),
  ]);
  await disableNativeSidePanelForAllTabs();
}

async function readLinks() {
  const stored = await chrome.storage.local.get(LINKS_KEY);
  const links = stored[LINKS_KEY];
  workspaceLinksCache = Array.isArray(links) ? links : [];
  return workspaceLinksCache;
}

async function upsertLink(link) {
  const links = await readLinks();
  const next = links.filter((entry) => {
    if (entry.id === link.id) {
      return false;
    }
    if (link.tabId === undefined || link.windowId === undefined) {
      return true;
    }
    return (
      String(entry.tabId) !== String(link.tabId) || String(entry.windowId) !== String(link.windowId)
    );
  });
  next.push(link);
  workspaceLinksCache = next;
  await chrome.storage.local.set({ [LINKS_KEY]: next });
}

function tabsHaveSameIdentity(left, right) {
  return (
    left?.tabId !== undefined &&
    left?.windowId !== undefined &&
    right?.tabId !== undefined &&
    right?.windowId !== undefined &&
    String(left.tabId) === String(right.tabId) &&
    String(left.windowId) === String(right.windowId)
  );
}

function linkForStorage(link) {
  if (typeof link.t3Url !== "string" || link.t3Url.length === 0) {
    return link;
  }
  try {
    const url = new URL(link.t3Url);
    url.hash = "";
    return { ...link, t3Url: url.toString() };
  } catch {
    return link;
  }
}

function sidebarSessionTokenStorageArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

function normalizeSidebarSessionTokenEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = {};
  for (const [linkId, record] of Object.entries(value)) {
    if (
      typeof linkId === "string" &&
      linkId.length > 0 &&
      record &&
      typeof record === "object" &&
      typeof record.token === "string" &&
      record.token.length > 0
    ) {
      entries[linkId] = {
        token: record.token,
        updatedAt:
          typeof record.updatedAt === "string" && record.updatedAt.length > 0
            ? record.updatedAt
            : new Date().toISOString(),
      };
    }
  }
  return entries;
}

async function readSidebarSessionTokens() {
  if (sidebarSessionTokensCache) {
    return sidebarSessionTokensCache;
  }
  const stored = await sidebarSessionTokenStorageArea()
    .get(SIDEBAR_SESSION_TOKENS_KEY)
    .catch(() => ({}));
  sidebarSessionTokensCache = normalizeSidebarSessionTokenEntries(
    stored[SIDEBAR_SESSION_TOKENS_KEY],
  );
  return sidebarSessionTokensCache;
}

async function writeSidebarSessionToken(linkId, token) {
  if (typeof linkId !== "string" || linkId.length === 0) {
    return;
  }
  if (typeof token !== "string" || token.length === 0) {
    return;
  }
  const tokens = {
    ...(await readSidebarSessionTokens()),
    [linkId]: {
      token,
      updatedAt: new Date().toISOString(),
    },
  };
  sidebarSessionTokensCache = tokens;
  await sidebarSessionTokenStorageArea()
    .set({ [SIDEBAR_SESSION_TOKENS_KEY]: tokens })
    .catch(() => undefined);
}

async function readSidebarSessionToken(linkId) {
  if (typeof linkId !== "string" || linkId.length === 0) {
    return null;
  }
  const tokens = await readSidebarSessionTokens();
  return tokens[linkId]?.token ?? null;
}

async function removeSidebarSessionToken(linkId) {
  if (typeof linkId !== "string" || linkId.length === 0) {
    return;
  }
  const current = await readSidebarSessionTokens();
  if (!current[linkId]) {
    return;
  }
  const { [linkId]: _removed, ...tokens } = current;
  sidebarSessionTokensCache = tokens;
  await sidebarSessionTokenStorageArea()
    .set({ [SIDEBAR_SESSION_TOKENS_KEY]: tokens })
    .catch(() => undefined);
}

async function readActiveWorkspaceLink() {
  const stored = await chrome.storage.local.get(ACTIVE_LINK_KEY);
  const record = stored[ACTIVE_LINK_KEY];
  return record && typeof record.linkId === "string" ? record : null;
}

async function writeActiveWorkspaceLink(link) {
  await chrome.storage.local.set({
    [ACTIVE_LINK_KEY]: {
      linkId: link.id,
      ...(link.tabId !== undefined ? { tabId: link.tabId } : {}),
      ...(link.windowId !== undefined ? { windowId: link.windowId } : {}),
      updatedAt: new Date().toISOString(),
    },
  });
}

async function fetchJson(baseUrl, path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json?.error ?? json?.message ?? text;
    } catch {
      // Keep the raw response text.
    }
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return await response.json();
}

function localAutoConnectBaseUrls() {
  return Array.from(
    { length: AUTO_CONNECT_PORT_COUNT },
    (_value, index) => `http://127.0.0.1:${AUTO_CONNECT_PORT_START + index}`,
  );
}

function normalizeAutoConnectBaseUrls(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value
    .map((entry) => normalizeBaseUrl(entry))
    .filter((entry) => typeof entry === "string" && entry.length > 0);
  return normalized.length > 0 ? normalized : null;
}

async function fetchAutoConnectSession(baseUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTO_CONNECT_REQUEST_TIMEOUT_MS);
  try {
    return await fetchJson(baseUrl, AUTO_CONNECT_PATH, {
      method: "POST",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function shouldSkipAutoConnectProbe() {
  return (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING ||
    Boolean(connecting)
  );
}

function currentTransportConnectionResult() {
  if (socket?.readyState !== WebSocket.OPEN) {
    return null;
  }
  const baseUrl = socketBaseUrl ?? localControlBaseUrl ?? currentBackend?.baseUrl ?? null;
  return {
    connected: true,
    ...(baseUrl ? { baseUrl } : {}),
    transport: localControlBaseUrl ? "local-control" : "paired",
  };
}

function connectionErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function discardFailedConnectionState(baseUrl, error, message) {
  const errorMessage = connectionErrorMessage(error);
  lastConnectionError = errorMessage;
  addDiagnosticLog("warn", message, { baseUrl, error: errorMessage });
  closeSocket();
  if (currentBackend?.baseUrl === baseUrl) {
    currentBackend = null;
  }
  if (localControlBaseUrl === baseUrl) {
    localControlBaseUrl = null;
  }
  reconnectDelayMs = RECONNECT_MIN_MS;
}

async function connectAutoConnectCandidate(baseUrl, sessionToken) {
  const backend = {
    baseUrl,
    sessionToken,
    pairedAt: new Date().toISOString(),
  };
  currentBackend = backend;
  try {
    await connectBackend({ force: true });
  } catch (error) {
    discardFailedConnectionState(
      baseUrl,
      error,
      "Auto-connect candidate authenticated but the WebSocket failed.",
    );
    throw error;
  }
  await writeBackend(backend);
}

async function autoConnectLocalBackend(options = {}) {
  const customBaseUrls = normalizeAutoConnectBaseUrls(options.baseUrls);
  if (autoConnectInFlight && !customBaseUrls) {
    return autoConnectInFlight;
  }

  const connect = async () => {
    if (customBaseUrls && autoConnectInFlight) {
      await autoConnectInFlight.catch(() => undefined);
    }

    if (customBaseUrls && connecting) {
      const result = await connecting.catch(() => null);
      const activeTransport = currentTransportConnectionResult();
      if (activeTransport && customBaseUrls.includes(activeTransport.baseUrl)) {
        return activeTransport;
      }
      if (result?.connected === true && customBaseUrls.includes(result.baseUrl)) {
        return result;
      }
    }

    const activeTransport = currentTransportConnectionResult();
    if (activeTransport && (!customBaseUrls || customBaseUrls.includes(activeTransport.baseUrl))) {
      return activeTransport;
    }

    if (customBaseUrls && socket) {
      closeSocket();
    }
    if (customBaseUrls) {
      currentBackend = null;
      localControlBaseUrl = null;
    }

    if (shouldSkipAutoConnectProbe()) {
      return { connected: false, skipped: true };
    }

    const candidateBaseUrls = customBaseUrls ?? localAutoConnectBaseUrls();
    let lastError = null;
    for (const baseUrl of candidateBaseUrls) {
      if (shouldSkipAutoConnectProbe()) {
        return { connected: false, skipped: true };
      }
      try {
        const result = await connectLocalControlBackend(baseUrl);
        addDiagnosticLog("info", "Connected browser agent through local control socket", {
          baseUrl,
        });
        return { ...result, baseUrl };
      } catch (error) {
        lastError = error;
      }
    }

    const existingBackend = await readActivePairedBackend();
    if (existingBackend && !customBaseUrls) {
      try {
        return await connectBackend();
      } catch (error) {
        discardFailedConnectionState(
          existingBackend.baseUrl,
          error,
          "Saved browser-agent backend failed; probing authenticated local candidates.",
        );
      }
    }

    for (const baseUrl of candidateBaseUrls) {
      if (shouldSkipAutoConnectProbe()) {
        return { connected: false, skipped: true };
      }
      try {
        const result = await fetchAutoConnectSession(baseUrl);
        if (typeof result?.sessionToken !== "string" || result.sessionToken.length === 0) {
          continue;
        }
        await connectAutoConnectCandidate(baseUrl, result.sessionToken);
        addDiagnosticLog("info", "Auto-connected browser agent to local T3 Code backend", {
          baseUrl,
        });
        return { connected: true, baseUrl };
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      lastConnectionError = connectionErrorMessage(lastError);
    }
    return { connected: false };
  };

  if (customBaseUrls) {
    return await connect();
  }

  autoConnectInFlight = connect();

  try {
    return await autoConnectInFlight;
  } finally {
    autoConnectInFlight = null;
  }
}

function autoConnectInBackground(reason) {
  void autoConnectLocalBackend().catch((error) => {
    lastConnectionError = connectionErrorMessage(error);
    console.warn(`[T3 Code] failed to auto-connect browser agent after ${reason}`, error);
  });
}

async function ensureBrowserAgentTransport() {
  if (socket?.readyState === WebSocket.OPEN) {
    return { connected: true };
  }
  const result = await autoConnectLocalBackend();
  if (result.connected !== true) {
    throw new Error("T3 Code browser-agent transport is not connected.");
  }
  return result;
}

function isExtensionPageSender(sender) {
  return typeof sender?.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

function isTrustedAutoConnectHostname(hostname) {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".ts.net")) {
    return true;
  }
  const parts = normalized.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

function isTrustedAutoConnectContentSender(sender, message) {
  if (typeof sender?.url !== "string" || typeof message?.pageBaseUrl !== "string") {
    return false;
  }
  try {
    const senderUrl = new URL(sender.url);
    const pageBaseUrl = new URL(message.pageBaseUrl);
    return (
      senderUrl.origin === pageBaseUrl.origin && isTrustedAutoConnectHostname(pageBaseUrl.hostname)
    );
  } catch {
    return false;
  }
}

async function pairBackend(input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new Error("Enter a valid T3 Code backend URL.");
  }
  const providedSessionToken = String(input.sessionToken ?? "").trim();
  if (providedSessionToken) {
    const session = await fetchJson(baseUrl, "/api/auth/session", {
      token: providedSessionToken,
    });
    if (!session?.authenticated) {
      throw new Error("The backend rejected the browser agent session token.");
    }
    const backend = {
      baseUrl,
      sessionToken: providedSessionToken,
      pairedAt: new Date().toISOString(),
    };
    await writeBackend(backend);
    await connectBackend({ force: true });
    return { ok: true };
  }

  const credential = String(input.credential ?? "").trim();
  if (!credential) {
    throw new Error("Enter a pairing token or browser agent session token.");
  }
  const result = await fetchJson(baseUrl, "/api/auth/bootstrap/bearer", {
    method: "POST",
    body: { credential },
  });
  if (typeof result.sessionToken !== "string") {
    throw new Error("The backend did not return a bearer session token.");
  }
  const backend = {
    baseUrl,
    sessionToken: result.sessionToken,
    pairedAt: new Date().toISOString(),
  };
  await writeBackend(backend);
  await connectBackend({ force: true });
  return { ok: true };
}

async function getWsToken(backend) {
  const result = await fetchJson(backend.baseUrl, "/api/auth/ws-token", {
    method: "POST",
    token: backend.sessionToken,
  });
  if (typeof result.token !== "string") {
    throw new Error("The backend did not return a WebSocket token.");
  }
  return result.token;
}

async function assertBrowserAgentBackend(backend) {
  const descriptor = await fetchJson(backend.baseUrl, "/.well-known/t3/environment");
  if (descriptor?.capabilities?.browserAgent === false) {
    throw new Error("The paired T3 Code backend does not support the browser agent.");
  }
}

function socketStateLabel() {
  if (!socket) {
    return "missing";
  }
  switch (socket.readyState) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
      return "closing";
    case WebSocket.CLOSED:
      return "closed";
    default:
      return "unknown";
  }
}

async function runDiagnosticStep(name, action) {
  try {
    const result = await action();
    return { name, ok: true, result };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function diagnoseBackend(backend) {
  if (!backend) {
    return {
      paired: false,
      checks: [],
    };
  }

  const environment = await runDiagnosticStep("environment", async () => {
    const descriptor = await fetchJson(backend.baseUrl, "/.well-known/t3/environment");
    return {
      environmentId: descriptor?.environmentId ?? null,
      label: descriptor?.label ?? null,
      browserAgentCapability: descriptor?.capabilities?.browserAgent ?? null,
      serverVersion: descriptor?.serverVersion ?? null,
    };
  });
  const authSession = await runDiagnosticStep("auth-session", async () => {
    const session = await fetchJson(backend.baseUrl, "/api/auth/session", {
      token: backend.sessionToken,
    });
    return {
      authenticated: session?.authenticated === true,
      role: session?.role ?? null,
      sessionMethod: session?.sessionMethod ?? null,
    };
  });
  const wsToken = await runDiagnosticStep("ws-token", async () => {
    const result = await fetchJson(backend.baseUrl, "/api/auth/ws-token", {
      method: "POST",
      token: backend.sessionToken,
    });
    return {
      receivedToken: typeof result.token === "string" && result.token.length > 0,
    };
  });

  return {
    paired: true,
    baseUrl: backend.baseUrl,
    pairedAt: backend.pairedAt ?? null,
    checks: [environment, authSession, wsToken],
  };
}

function closeSocket() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socketEventController?.abort();
    socketEventController = null;
    socket.close();
    socket = null;
  }
  socketBaseUrl = null;
}

function scheduleReconnect() {
  if ((!currentBackend && !localControlBaseUrl) || reconnectTimer !== null) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const reconnect = localControlBaseUrl
      ? connectLocalControlBackend(localControlBaseUrl)
      : connectBackend();
    void reconnect.catch(() => scheduleReconnect());
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
}

function scheduleAutoConnectAlarm() {
  if (!chrome.alarms?.create) {
    return;
  }
  void chrome.alarms.create(AUTO_CONNECT_ALARM_NAME, {
    periodInMinutes: AUTO_CONNECT_INTERVAL_MINUTES,
  });
}

function waitForSocketOpen(nextSocket, eventOptions) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      nextSocket.close();
      reject(new Error("Timed out waiting for browser-agent WebSocket to open."));
    }, WEBSOCKET_OPEN_TIMEOUT_MS);
    const settle = (action, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      action(value);
    };
    nextSocket.addEventListener("open", () => settle(resolve, undefined), {
      ...eventOptions,
      once: true,
    });
    nextSocket.addEventListener(
      "error",
      () => settle(reject, new Error("Browser-agent WebSocket error.")),
      { ...eventOptions, once: true },
    );
    nextSocket.addEventListener(
      "close",
      () => settle(reject, new Error("Browser-agent WebSocket closed before opening.")),
      { ...eventOptions, once: true },
    );
  });
}

async function openBrowserAgentSocket(input) {
  closeSocket();
  socketBaseUrl = input.baseUrl;
  socket = new WebSocket(input.wsUrl);
  socketEventController = new AbortController();
  const eventOptions = { signal: socketEventController.signal };
  socket.addEventListener(
    "open",
    () => {
      lastConnectionOpenedAt = new Date().toISOString();
      reconnectDelayMs = RECONNECT_MIN_MS;
      sendHello();
      void sendTabsSnapshot();
    },
    eventOptions,
  );
  socket.addEventListener(
    "message",
    (event) => {
      void handleServerMessage(event.data).catch((error) => {
        console.warn("[T3 Code] browser-agent command failed", error);
      });
    },
    eventOptions,
  );
  socket.addEventListener(
    "close",
    () => {
      socket = null;
      socketBaseUrl = null;
      socketEventController = null;
      scheduleReconnect();
    },
    eventOptions,
  );
  socket.addEventListener(
    "error",
    () => {
      lastConnectionError = "Browser-agent WebSocket error.";
      socket?.close();
    },
    eventOptions,
  );
  await waitForSocketOpen(socket, eventOptions);
}

async function connectLocalControlBackend(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error("Invalid local browser-control backend URL.");
  }
  if (connecting) {
    return connecting;
  }
  connecting = (async () => {
    lastConnectionAttemptAt = new Date().toISOString();
    lastConnectionError = null;
    if (
      socket &&
      socket.readyState === WebSocket.OPEN &&
      socketBaseUrl === normalizedBaseUrl &&
      localControlBaseUrl === normalizedBaseUrl
    ) {
      return { connected: true, transport: "local-control" };
    }
    currentBackend = null;
    localControlBaseUrl = normalizedBaseUrl;
    try {
      await openBrowserAgentSocket({
        baseUrl: normalizedBaseUrl,
        wsUrl: localControlWsUrlFor(normalizedBaseUrl),
      });
    } catch (error) {
      discardFailedConnectionState(
        normalizedBaseUrl,
        error,
        "Local browser-control socket failed.",
      );
      throw error;
    }
    return { connected: true, transport: "local-control" };
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function connectBackend(options = {}) {
  if (connecting) {
    return connecting;
  }
  connecting = (async () => {
    lastConnectionAttemptAt = new Date().toISOString();
    lastConnectionError = null;
    localControlBaseUrl = null;
    const backend = currentBackend ?? (await readBackend());
    currentBackend = backend;
    if (!backend) {
      return { connected: false };
    }
    if (
      !options.force &&
      socket &&
      socket.readyState === WebSocket.OPEN &&
      socketBaseUrl === backend.baseUrl
    ) {
      return { connected: true };
    }

    await assertBrowserAgentBackend(backend);
    const token = await getWsToken(backend);
    await openBrowserAgentSocket({
      baseUrl: backend.baseUrl,
      wsUrl: wsUrlFor(backend.baseUrl, token),
    });
    return { connected: true, transport: "paired" };
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

function sendToServer(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("T3 Code browser-agent socket is not connected.");
  }
  socket.send(JSON.stringify(message));
}

function sendHello() {
  lastHelloSentAt = new Date().toISOString();
  const groups = capabilityGroups();
  const extensionVersion = chrome.runtime.getManifest().version;
  sendToServer({
    type: "browserAgent.hello",
    runtime: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      extensionVersion,
      browser: detectBrowser(),
      platform: navigator.platform,
    },
    device: {
      extensionVersion,
      userAgent: navigator.userAgent,
      browser: detectBrowser(),
      platform: navigator.platform,
    },
    capabilities: {
      version: 1,
      runtime: {
        version: RUNTIME_PROTOCOL_VERSION,
        primitives: RUNTIME_PRIMITIVES,
      },
      canCaptureVisibleTab: true,
      canInjectScripts: Boolean(chrome.scripting?.executeScript),
      canFocusTabs: true,
      canGroupTabs: Boolean(chrome.tabs?.group),
      canAnnotate: true,
      canRenderInlineSidebar: false,
      canAttachActiveTab: true,
      canThreadTabCommands: true,
      canCaptureThreadTab: true,
      ...groups,
    },
  });
  addDiagnosticLog("info", "Sent browser-agent hello", {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    capabilities: groups,
  });
}

async function sendTabsSnapshot() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  lastTabsSnapshotSentAt = new Date().toISOString();
  const tabs = await chrome.tabs.query({});
  const groupsById = new Map();
  const groupIds = Array.from(
    new Set(
      tabs
        .map((tab) => tab.groupId)
        .filter((groupId) => typeof groupId === "number" && groupId >= 0),
    ),
  );
  await Promise.all(
    groupIds.map(async (groupId) => {
      try {
        groupsById.set(groupId, await chrome.tabGroups.get(groupId));
      } catch {
        groupsById.delete(groupId);
      }
    }),
  );
  sendToServer({
    type: "browserAgent.tabs.snapshot",
    tabs: tabs
      .filter((tab) => tab.id !== undefined && tab.windowId !== undefined)
      .map((tab) => {
        const group = typeof tab.groupId === "number" ? groupsById.get(tab.groupId) : null;
        const snapshot = {
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url,
          title: tab.title,
          active: tab.active === true,
        };
        if (typeof tab.groupId === "number" && tab.groupId >= 0) {
          snapshot.groupId = tab.groupId;
        }
        if (group?.title) {
          snapshot.groupTitle = group.title;
        }
        return snapshot;
      }),
  });
}

function normalizeUrlForMatch(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function tabMatchesDevServer(tabUrl, devServerUrl) {
  const tab = normalizeUrlForMatch(tabUrl ?? "");
  const target = normalizeUrlForMatch(devServerUrl);
  if (!tab || !target) {
    return false;
  }
  if (tab.origin !== target.origin) {
    return false;
  }
  const targetPath = target.pathname.replace(/\/+$/, "") || "/";
  if (targetPath === "/") {
    return true;
  }
  return tab.pathname === target.pathname || tab.pathname.startsWith(`${targetPath}/`);
}

function tabMatchesWorkspaceLink(tab, link) {
  if (!tab) {
    return false;
  }
  if (linkMatchesTabIdentity(link, tab)) {
    return true;
  }
  if (!workspaceLinkAllowsUrlDiscovery(link)) {
    return false;
  }
  if (typeof tab.url === "string") {
    if (typeof link.url === "string" && tab.url === link.url) {
      return true;
    }
    if (typeof link.devServerUrl === "string" && tabMatchesDevServer(tab.url, link.devServerUrl)) {
      return true;
    }
  }
  return false;
}

function linkTimestamp(link) {
  const value = Date.parse(link.updatedAt ?? link.createdAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function newestLink(links) {
  return links.reduce((best, link) => {
    if (!best) {
      return link;
    }
    return linkTimestamp(link) >= linkTimestamp(best) ? link : best;
  }, null);
}

function linkMatchesTabIdentity(link, tab) {
  return (
    tab.id !== undefined &&
    tab.windowId !== undefined &&
    link.tabId !== undefined &&
    link.windowId !== undefined &&
    String(link.tabId) === String(tab.id) &&
    String(link.windowId) === String(tab.windowId)
  );
}

function workspaceLinkAllowsUrlDiscovery(link) {
  return link.role !== "agent" && link.lifecycle !== "ephemeral";
}

function workspaceLinkRequiresExclusiveTabIdentity(link) {
  return link.role === "agent" || link.lifecycle === "ephemeral";
}

function selectWorkspaceLinkForTab(links, tab) {
  const matchingUrlLinks = links.filter((entry) => tabMatchesWorkspaceLink(tab, entry));
  if (matchingUrlLinks.length === 0) {
    return null;
  }

  const exactTabLinks = matchingUrlLinks.filter((entry) => linkMatchesTabIdentity(entry, tab));
  if (exactTabLinks.length > 0) {
    return newestLink(exactTabLinks);
  }

  const sameWindowLinks = matchingUrlLinks.filter(
    (entry) =>
      tab.windowId !== undefined &&
      entry.windowId !== undefined &&
      String(entry.windowId) === String(tab.windowId),
  );
  return newestLink(sameWindowLinks.length > 0 ? sameWindowLinks : matchingUrlLinks);
}

async function findPreviewTab(link) {
  if (link.tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(Number(link.tabId));
      if (tabMatchesWorkspaceLink(tab, link)) {
        if (workspaceLinkRequiresExclusiveTabIdentity(link)) {
          const links = await readLinks();
          const claimedByDifferentLink = links.some(
            (entry) => entry.id !== link.id && tabsHaveSameIdentity(entry, link),
          );
          if (claimedByDifferentLink) {
            return null;
          }
        }
        return tab;
      }
    } catch {
      // Fall back to URL scan below.
    }
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tabMatchesWorkspaceLink(tab, link)) ?? null;
}

function urlsMatchForNavigation(tabUrl, expectedUrl) {
  if (tabUrl === expectedUrl) {
    return true;
  }
  const tab = normalizeUrlForMatch(tabUrl ?? "");
  const expected = normalizeUrlForMatch(expectedUrl);
  return Boolean(tab && expected && tab.href === expected.href);
}

async function waitForTabUrl(tabId, expectedUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastTab = null;
  while (Date.now() < deadline) {
    try {
      lastTab = await chrome.tabs.get(tabId);
      if (urlsMatchForNavigation(lastTab.url, expectedUrl)) {
        return lastTab;
      }
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return lastTab;
}

async function navigateTabToUrl(tab, url) {
  if (!tab?.id) {
    return tab;
  }
  if (!urlsMatchForNavigation(tab.url, url)) {
    tab = await chrome.tabs.update(tab.id, { url });
  }
  return (await waitForTabUrl(tab.id, url)) ?? tab;
}

async function ensureGrouped(tabId, repoName) {
  if (!chrome.tabs.group || !chrome.tabGroups?.update) {
    return;
  }
  try {
    const tabs = await chrome.tabs.query({});
    const groupIds = Array.from(
      new Set(
        tabs
          .map((tab) => tab.groupId)
          .filter((groupId) => typeof groupId === "number" && groupId >= 0),
      ),
    );
    let groupId = null;
    for (const candidateGroupId of groupIds) {
      try {
        const group = await chrome.tabGroups.get(candidateGroupId);
        if (group.title === repoName) {
          groupId = group.id;
          break;
        }
      } catch {
        // Ignore stale group ids from tabs that changed while we were scanning.
      }
    }
    if (groupId === null) {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
    } else {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    }
    await chrome.tabGroups.update(groupId, {
      title: repoName,
      color: "green",
      collapsed: false,
    });
  } catch (error) {
    console.warn("[T3 Code] failed to group preview tab", error);
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "t3code.browserAgent.ping" }, { frameId: 0 });
    return;
  } catch {
    // Inject below.
  }
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["transfer-content.js"],
  });
}

async function sendTabMessage(tabId, message) {
  await ensureContentScript(tabId);
  return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}

function ensureOkResponse(response) {
  if (response?.ok === false) {
    throw new Error(response.error ?? response.reason ?? "Browser tab command failed.");
  }
  return response;
}

async function sendExistingTabMessage(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // The prompt content script may not be present on every tab.
  }
}

function numericTabId(tab) {
  const tabId = Number(tab?.id);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

async function closeGlobalNativeSidePanels() {
  if (!chrome.sidePanel?.close) {
    return;
  }
  try {
    const windows = await chrome.windows.getAll();
    await Promise.all(
      windows.map(async (window) => {
        if (window.id === undefined) {
          return;
        }
        await chrome.sidePanel.close({ windowId: window.id }).catch(() => undefined);
      }),
    );
  } catch (error) {
    console.warn("[T3 Code] failed to close stale global side panels", error);
  }
}

async function setNativeSidePanelForTab(tab, enabled) {
  if (!chrome.sidePanel?.setOptions) {
    return false;
  }
  const tabId = numericTabId(tab);
  if (tabId === null) {
    return false;
  }
  await chrome.sidePanel.setOptions(
    enabled ? { tabId, path: SIDE_PANEL_PATH, enabled: true } : { tabId, enabled: false },
  );
  return true;
}

function tabHasNativeSidePanelLink(links, tab) {
  return links.some((entry) => tabMatchesWorkspaceLink(tab, entry));
}

async function syncNativeSidePanelOptionsForTabs(tabs) {
  if (!chrome.sidePanel?.setOptions || tabs.length === 0) {
    return;
  }
  try {
    const links = await readLinks();
    await Promise.all(
      tabs.map((tab) => setNativeSidePanelForTab(tab, tabHasNativeSidePanelLink(links, tab))),
    );
  } catch (error) {
    console.warn("[T3 Code] failed to sync side panel tab options", error);
  }
}

async function syncNativeSidePanelOptionsForTab(tab) {
  await syncNativeSidePanelOptionsForTabs([tab]);
}

async function syncNativeSidePanelOptionsForTabId(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncNativeSidePanelOptionsForTabs([tab]);
  } catch {
    // The tab may have closed before Chrome delivered the event.
  }
}

async function syncNativeSidePanelOptionsForAllTabs() {
  if (!chrome.sidePanel?.setOptions) {
    return;
  }
  try {
    await syncNativeSidePanelOptionsForTabs(await chrome.tabs.query({}));
  } catch (error) {
    console.warn("[T3 Code] failed to sync side panel options for open tabs", error);
  }
}

async function disableNativeSidePanelForAllTabs() {
  if (!chrome.sidePanel?.setOptions) {
    return;
  }
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => setNativeSidePanelForTab(tab, false)));
  } catch (error) {
    console.warn("[T3 Code] failed to disable side panel options for open tabs", error);
  }
}

async function syncNativeSidePanelOptionsForFocusedWindow() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab) {
      await syncNativeSidePanelOptionsForTabs([activeTab]);
    }
  } catch {
    // There may be no focused browser window.
  }
}

async function configureSidePanelBehavior() {
  if (!chrome.sidePanel) {
    return;
  }
  if (chrome.sidePanel.setOptions) {
    await chrome.sidePanel.setOptions({ enabled: false }).catch((error) => {
      console.warn("[T3 Code] failed to disable the default side panel", error);
    });
  }
  await closeGlobalNativeSidePanels();
  await syncNativeSidePanelOptionsForAllTabs();
  if (!chrome.sidePanel.setPanelBehavior) {
    return;
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("[T3 Code] failed to configure side panel action behavior", error);
  }
}

function sidePanelOpenFailure(error) {
  return {
    opened: false,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCaptureQuality(input = {}) {
  const maxWidth = Number.isFinite(input.maxWidth) && input.maxWidth > 0 ? input.maxWidth : 1920;
  const maxHeight =
    Number.isFinite(input.maxHeight) && input.maxHeight > 0 ? input.maxHeight : 1080;
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? Math.min(input.fps, 30) : 15;
  const imageQuality =
    Number.isFinite(input.imageQuality) && input.imageQuality > 0 && input.imageQuality <= 1
      ? input.imageQuality
      : 0.72;
  return {
    maxWidth,
    maxHeight,
    fps,
    imageQuality,
  };
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("Chrome offscreen documents are unavailable.");
  }
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["BLOBS"],
    justification: "Downscale and encode browser screenshots for T3 Code.",
  });
}

async function sendOffscreenMessage(message) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage(message);
  return ensureOkResponse(response).payload;
}

async function captureVisibleTabWithRetry(windowId, options = {}, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, options);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
        throw error;
      }
      await sleep(650 * (attempt + 1));
    }
  }
  throw lastError ?? new Error("Failed to capture visible tab.");
}

function openNativeSidePanel(tab) {
  if (!chrome.sidePanel?.open) {
    return Promise.resolve({ opened: false, reason: "Chrome Side Panel API is unavailable." });
  }
  if (!chrome.sidePanel.setOptions) {
    return Promise.resolve({
      opened: false,
      reason: "Chrome Side Panel tab options are unavailable.",
    });
  }

  const tabId = numericTabId(tab);
  if (tabId === null) {
    return Promise.resolve({ opened: false, reason: "No active Chrome tab." });
  }

  try {
    const optionsPromise = chrome.sidePanel.setOptions({
      tabId,
      path: SIDE_PANEL_PATH,
      enabled: true,
    });
    if (optionsPromise?.catch) {
      void optionsPromise.catch((error) => {
        console.warn("[T3 Code] failed to enable side panel before opening", error);
      });
    }
  } catch (error) {
    return Promise.resolve(sidePanelOpenFailure(error));
  }

  try {
    return Promise.resolve(chrome.sidePanel.open({ tabId }))
      .then(() => ({ opened: true }))
      .catch(sidePanelOpenFailure);
  } catch (error) {
    return Promise.resolve(sidePanelOpenFailure(error));
  }
}

async function markSidePanelNeedsUserOpen(tab, reason) {
  if (tab?.id === undefined) {
    return;
  }
  await chrome.action.setBadgeText({ tabId: tab.id, text: "OPEN" });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#2563eb" });
  await chrome.action.setTitle({
    tabId: tab.id,
    title: reason ? `Open T3 Code side panel: ${reason}` : "Open T3 Code side panel",
  });
}

async function clearSidePanelNeedsUserOpen(tab) {
  if (tab?.id === undefined) {
    return;
  }
  await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  await chrome.action.setTitle({ tabId: tab.id, title: "T3 Code Browser Agent" });
}

async function showSidePanelOpenPrompt(tab, reason) {
  await markSidePanelNeedsUserOpen(tab, reason);
  if (tab?.id === undefined) {
    return;
  }
  await sendTabMessage(tab.id, {
    type: "t3code.browserAgent.showOpenSidePanelPrompt",
    reason,
  }).catch((error) => {
    console.warn("[T3 Code] failed to show side panel open prompt", error);
  });
}

async function clearSidePanelOpenPrompt(tab) {
  await clearSidePanelNeedsUserOpen(tab);
  if (tab?.id === undefined) {
    return;
  }
  await sendExistingTabMessage(tab.id, { type: "t3code.browserAgent.hideOpenSidePanelPrompt" });
}

async function setActiveNativeSidePanelLink(tab, link, options = {}) {
  await upsertLink(linkForStorage(link));
  await writeActiveWorkspaceLink(link);
  if (options.open !== true) {
    await setNativeSidePanelForTab(tab, true).catch((error) => {
      console.warn("[T3 Code] failed to enable side panel for linked tab", error);
    });
  }
  if (options.open === true) {
    const result = await openNativeSidePanel(tab);
    if (result.opened) {
      await clearSidePanelOpenPrompt(tab);
    } else {
      await showSidePanelOpenPrompt(tab, result.reason);
    }
  }
}

function linkMatchesActiveWorkspaceRecord(link, record) {
  if (!record) {
    return false;
  }
  if (link.id === record.linkId) {
    return true;
  }
  if (record.tabId === undefined || record.windowId === undefined) {
    return false;
  }
  return (
    link.tabId !== undefined &&
    link.windowId !== undefined &&
    String(link.tabId) === String(record.tabId) &&
    String(link.windowId) === String(record.windowId)
  );
}

async function resolveSidePanelActiveTab(input) {
  if (!input?.activeTab || input.activeTab.id === undefined) {
    return null;
  }
  const tabId = Number(input.activeTab.id);
  if (!Number.isFinite(tabId)) {
    return input.activeTab;
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return input.activeTab;
  }
}

async function getSidePanelState(input = {}) {
  const backend = await readActivePairedBackend();
  const baseUrl = activeBrowserAgentBaseUrl(backend);
  const activeTab = await resolveSidePanelActiveTab(input);
  if (activeTab) {
    void clearSidePanelOpenPrompt(activeTab).catch(() => undefined);
  }
  const links = await readLinks();
  let selectedLink = activeTab ? selectWorkspaceLinkForTab(links, activeTab) : null;

  if (!selectedLink && !activeTab) {
    const activeRecord = await readActiveWorkspaceLink();
    selectedLink =
      links.find((link) => linkMatchesActiveWorkspaceRecord(link, activeRecord)) ?? null;
  }

  if (!selectedLink && !activeTab) {
    selectedLink = newestLink(links);
  }

  const previewTab =
    selectedLink && activeTab && tabMatchesWorkspaceLink(activeTab, selectedLink)
      ? activeTab
      : selectedLink
        ? await findPreviewTab(selectedLink)
        : null;
  const workspaceLink = selectedLink
    ? await workspaceLinkForContent(selectedLink, previewTab)
    : null;

  return {
    ok: true,
    paired: hasActiveBrowserAgentTransport(backend),
    baseUrl,
    connected: socket?.readyState === WebSocket.OPEN,
    workspaceLink,
    activeTab: activeTab
      ? {
          tabId: activeTab.id,
          windowId: activeTab.windowId,
          url: activeTab.url,
          title: activeTab.title,
        }
      : null,
  };
}

async function findStoredWorkspaceLink(workspaceLinkId) {
  const links = await readLinks();
  return links.find((entry) => entry.id === workspaceLinkId) ?? null;
}

function sendThreadTabUpdated(link, tab, status) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !link?.id) {
    return;
  }
  sendToServer({
    type: "browserAgent.threadTab.updated",
    workspaceLinkId: link.id,
    tabId: tab?.id ?? null,
    windowId: tab?.windowId ?? link.windowId ?? null,
    url: tab?.url ?? link.url ?? null,
    title: tab?.title ?? link.title ?? null,
    status,
  });
}

async function notifyThreadLinksForTab(tab, status) {
  if (!tab?.id) {
    return;
  }
  const links = await readLinks();
  for (const link of links) {
    if (tabMatchesWorkspaceLink(tab, link)) {
      sendThreadTabUpdated(link, tab, status);
    }
  }
}

async function notifyThreadLinksForRemovedTab(tabId, windowId) {
  const links = await readLinks();
  for (const link of links) {
    if (
      link.tabId !== undefined &&
      String(link.tabId) === String(tabId) &&
      (windowId === undefined ||
        link.windowId === undefined ||
        String(link.windowId) === String(windowId))
    ) {
      sendThreadTabUpdated(link, null, "closed");
    }
  }
}

async function openOrFocusPreview(command) {
  const link = command.workspaceLink;
  let tab = await findPreviewTab(link);
  if (!tab) {
    tab = await chrome.tabs.create({ url: link.devServerUrl, active: true });
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  await ensureGrouped(tab.id, link.repoName);
  const contentLink = await applyDefaultDeepControl(
    await workspaceLinkForContent(link, tab, {
      sidebarSessionToken: command.sidebarSessionToken,
    }),
    tab,
  );
  await setActiveNativeSidePanelLink(tab, contentLink, { open: true });
  await sendTabsSnapshot();
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: tab.id,
    windowId: tab.windowId,
  });
}

async function activateAnnotation(command) {
  const link = command.workspaceLink;
  const tab = await findPreviewTab(link);
  if (!tab?.id) {
    throw new Error("Could not find the dev-server tab for this workspace.");
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  const contentLink = await applyDefaultDeepControl(await workspaceLinkForContent(link, tab), tab);
  await setActiveNativeSidePanelLink(tab, contentLink);
  await sendTabMessage(tab.id, {
    type: "t3code.browserAgent.activateAnnotation",
    workspaceLink: contentLink,
  });
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: tab.id,
    windowId: tab.windowId,
  });
}

async function openOrFocusThreadTab(command) {
  const link = command.workspaceLink;
  let tab = await findPreviewTab(link);
  addDiagnosticLog("info", "Opening thread tab", {
    commandId: command.commandId,
    requestedUrl: command.url,
    foundTabId: tab?.id ?? null,
    foundTabUrl: tab?.url ?? null,
    workspaceLinkId: link.id,
    browserContextId: link.browserContextId ?? null,
    marker: "wait-for-tab-url-v2",
  });
  if (!tab) {
    tab = await chrome.tabs.create({ url: command.url, active: command.focus !== false });
  } else if (command.focus !== false) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  }
  if (command.url) {
    tab = await navigateTabToUrl(tab, command.url);
    addDiagnosticLog("info", "Thread tab navigation settled", {
      commandId: command.commandId,
      requestedUrl: command.url,
      tabId: tab?.id ?? null,
      tabUrl: tab?.url ?? null,
      tabStatus: tab?.status ?? null,
      matched: urlsMatchForNavigation(tab?.url, command.url),
      marker: "wait-for-tab-url-v2",
    });
    if (!urlsMatchForNavigation(tab?.url, command.url)) {
      throw new Error(`The linked browser tab did not navigate to ${command.url}.`);
    }
  }
  const contentLink = await applyDefaultDeepControl(await workspaceLinkForContent(link, tab), tab);
  await upsertLink(linkForStorage(contentLink));
  await setNativeSidePanelForTab(tab, true).catch((error) => {
    console.warn("[T3 Code] failed to enable side panel for linked tab", error);
  });
  await sendTabsSnapshot();
  sendThreadTabUpdated(contentLink, tab, "complete");
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: tab.id,
    windowId: tab.windowId,
    payload: {
      url: tab.url ?? command.url,
      title: tab.title ?? null,
    },
  });
}

async function attachActiveTab(command) {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.id || activeTab.windowId === undefined) {
    throw new Error("No active browser tab is available to attach.");
  }
  const contentLink = await applyDefaultDeepControl(
    await workspaceLinkForContent(command.workspaceLink, activeTab),
    activeTab,
  );
  await upsertLink(linkForStorage(contentLink));
  await writeActiveWorkspaceLink(contentLink);
  await setNativeSidePanelForTab(activeTab, true).catch((error) => {
    console.warn("[T3 Code] failed to enable side panel for attached tab", error);
  });
  await sendTabsSnapshot();
  sendThreadTabUpdated(
    contentLink,
    activeTab,
    activeTab.status === "loading" ? "loading" : "complete",
  );
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: activeTab.id,
    windowId: activeTab.windowId,
    payload: {
      url: activeTab.url ?? null,
      title: activeTab.title ?? null,
    },
  });
}

async function detachThreadTab(command) {
  const links = await readLinks();
  const nextLinks = links.filter((entry) => entry.id !== command.workspaceLinkId);
  workspaceLinksCache = nextLinks;
  await Promise.all([
    chrome.storage.local.set({ [LINKS_KEY]: nextLinks }),
    removeSidebarSessionToken(command.workspaceLinkId),
  ]);
  const activeRecord = await readActiveWorkspaceLink();
  if (activeRecord?.linkId === command.workspaceLinkId) {
    await chrome.storage.local.remove(ACTIVE_LINK_KEY);
  }
  await syncNativeSidePanelOptionsForAllTabs();
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
  });
}

async function tabForWorkspaceLinkId(workspaceLinkId) {
  const link = await findStoredWorkspaceLink(workspaceLinkId);
  if (!link) {
    throw new Error("The browser extension does not know this thread browser link.");
  }
  const tab = await findPreviewTab(link);
  if (!tab?.id || tab.windowId === undefined) {
    sendThreadTabUpdated(link, null, "closed");
    throw new Error("The linked browser tab is closed or unavailable.");
  }
  return { link, tab };
}

function debuggerTargetForTab(tabId) {
  return { tabId: Number(tabId) };
}

async function attachCdpToTab(tabId) {
  if (!chrome.debugger?.attach) {
    throw new Error("Chrome debugger API is unavailable in this browser.");
  }
  const numericId = Number(tabId);
  if (!Number.isInteger(numericId) || numericId < 0) {
    throw new Error("Cannot attach CDP to an invalid tab id.");
  }
  if (cdpAttachedTabIds.has(numericId)) {
    return { attached: true, alreadyAttached: true };
  }
  await chrome.debugger.attach(debuggerTargetForTab(numericId), "1.3");
  cdpAttachedTabIds.add(numericId);
  addDiagnosticLog("info", "Attached CDP debugger", { tabId: numericId });
  return { attached: true };
}

async function detachCdpFromTab(tabId) {
  if (!chrome.debugger?.detach) {
    return { detached: false, reason: "Chrome debugger API is unavailable." };
  }
  const numericId = Number(tabId);
  if (!Number.isInteger(numericId) || numericId < 0 || !cdpAttachedTabIds.has(numericId)) {
    return { detached: true, alreadyDetached: true };
  }
  await stopCdpScreencastsForTab(numericId);
  await chrome.debugger.detach(debuggerTargetForTab(numericId)).catch((error) => {
    addDiagnosticLog("warn", "Failed to detach CDP debugger", {
      tabId: numericId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  cdpAttachedTabIds.delete(numericId);
  addDiagnosticLog("info", "Detached CDP debugger", { tabId: numericId });
  return { detached: true };
}

async function detachAllCdpTargets() {
  await stopAllCdpScreencasts();
  await Promise.all(Array.from(cdpAttachedTabIds).map((tabId) => detachCdpFromTab(tabId)));
  cdpAttachedTabIds = new Set();
}

async function sendCdpCommand(tabId, method, params = {}) {
  await attachCdpToTab(tabId);
  if (!chrome.debugger?.sendCommand) {
    throw new Error("Chrome debugger command API is unavailable.");
  }
  return await chrome.debugger.sendCommand(debuggerTargetForTab(tabId), method, params);
}

async function sendRawCdpCommand(tabId, method, params = {}) {
  if (!chrome.debugger?.sendCommand) {
    throw new Error("Chrome debugger command API is unavailable.");
  }
  return await chrome.debugger.sendCommand(debuggerTargetForTab(tabId), method, params);
}

function cdpScreencastFrameDataUrl(data) {
  return `data:image/jpeg;base64,${data}`;
}

async function stopCdpScreencast(workspaceLinkId, reason = "user", emitServerEvent = false) {
  const session = cdpScreencastSessions.get(workspaceLinkId);
  if (!session) {
    return { stopped: true, alreadyStopped: true };
  }
  cdpScreencastSessions.delete(workspaceLinkId);
  liveCaptureWorkspaceLinkIds.delete(workspaceLinkId);
  await sendRawCdpCommand(session.tabId, "Page.stopScreencast").catch((error) => {
    addDiagnosticLog("warn", "Failed to stop CDP screencast", {
      tabId: session.tabId,
      workspaceLinkId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (emitServerEvent) {
    sendToServer({
      type: "browserAgent.capture.stopped",
      workspaceLinkId,
      reason,
    });
  }
  return { stopped: true };
}

async function stopCdpScreencastsForTab(tabId) {
  const numericId = Number(tabId);
  const workspaceLinkIds = Array.from(cdpScreencastSessions.values())
    .filter((session) => session.tabId === numericId)
    .map((session) => session.workspaceLinkId);
  await Promise.all(workspaceLinkIds.map((workspaceLinkId) => stopCdpScreencast(workspaceLinkId)));
}

async function stopAllCdpScreencasts() {
  await Promise.all(
    Array.from(cdpScreencastSessions.keys()).map((workspaceLinkId) =>
      stopCdpScreencast(workspaceLinkId),
    ),
  );
}

async function runtimeDiagnosticsSnapshot() {
  const backend = await readActivePairedBackend();
  const baseUrl = activeBrowserAgentBaseUrl(backend);
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const links = await readLinks().catch(() => workspaceLinksCache);
  return {
    ok: true,
    runtime: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      extensionVersion: chrome.runtime.getManifest().version,
      browser: detectBrowser(),
      platform: navigator.platform,
      primitives: RUNTIME_PRIMITIVES,
      capabilities: capabilityGroups(),
    },
    transport: {
      paired: hasActiveBrowserAgentTransport(backend),
      baseUrl,
      localControlBaseUrl,
      transportMode: localControlBaseUrl ? "local-control" : backend ? "paired" : "none",
      socketState: socketStateLabel(),
      socketBaseUrl,
      reconnectDelayMs,
      lastConnectionAttemptAt,
      lastConnectionOpenedAt,
      lastConnectionError,
      lastHelloSentAt,
      lastTabsSnapshotSentAt,
    },
    workspaces: links,
    tabs: tabs.map((tab) => ({
      tabId: tab.id ?? null,
      windowId: tab.windowId ?? null,
      url: tab.url ?? null,
      title: tab.title ?? null,
      active: tab.active === true,
      status: tab.status ?? null,
      linked: links.some((link) => tabMatchesWorkspaceLink(tab, link)),
      cdpAttached: tab.id !== undefined && cdpAttachedTabIds.has(Number(tab.id)),
    })),
    cdp: {
      attachedTabIds: Array.from(cdpAttachedTabIds),
    },
    sidePanel: {
      nativeAvailable: Boolean(chrome.sidePanel),
      tabOptionsAvailable: Boolean(chrome.sidePanel?.setOptions),
      openAvailable: Boolean(chrome.sidePanel?.open),
    },
    logs: diagnosticLogs.slice(-50),
  };
}

async function focusTabForCommand(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

async function navigateThreadTab(command) {
  const { link, tab } = await tabForWorkspaceLinkId(command.workspaceLinkId);
  const updatedTab = await navigateTabToUrl(tab, command.url);
  if (!urlsMatchForNavigation(updatedTab?.url, command.url)) {
    throw new Error(`The linked browser tab did not navigate to ${command.url}.`);
  }
  const contentLink = await workspaceLinkForContent(
    { ...link, devServerUrl: command.url, url: command.url },
    updatedTab,
  );
  await upsertLink(linkForStorage(contentLink));
  sendThreadTabUpdated(contentLink, updatedTab, "complete");
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: updatedTab.id,
    windowId: updatedTab.windowId,
    payload: {
      url: updatedTab.url ?? command.url,
      title: updatedTab.title ?? null,
    },
  });
}

async function historyThreadTab(command) {
  const { link, tab } = await tabForWorkspaceLinkId(command.workspaceLinkId);
  if (command.action === "back") {
    await chrome.tabs.goBack(tab.id);
  } else if (command.action === "forward") {
    await chrome.tabs.goForward(tab.id);
  } else {
    await chrome.tabs.reload(tab.id);
  }
  const updatedTab = await chrome.tabs.get(tab.id);
  const contentLink = await workspaceLinkForContent(link, updatedTab);
  await upsertLink(linkForStorage(contentLink));
  sendThreadTabUpdated(
    contentLink,
    updatedTab,
    command.action === "reload" ? "loading" : "complete",
  );
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: updatedTab.id,
    windowId: updatedTab.windowId,
    payload: {
      url: updatedTab.url ?? null,
      title: updatedTab.title ?? null,
    },
  });
}

async function inputThreadTab(command) {
  const { tab } = await tabForWorkspaceLinkId(command.workspaceLinkId);
  ensureOkResponse(
    await sendTabMessage(tab.id, {
      type: "t3code.browserAgent.threadTabInput",
      input: command.input,
    }),
  );
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
  });
}

async function snapshotThreadTab(command) {
  const { tab } = await tabForWorkspaceLinkId(command.workspaceLinkId);
  const payload = ensureOkResponse(
    await sendTabMessage(tab.id, {
      type: "t3code.browserAgent.threadTabSnapshot",
    }),
  );
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: tab.id,
    windowId: tab.windowId,
    payload,
  });
}

async function captureLinkedTabScreenshot(workspaceLinkId, qualityInput = {}) {
  const { link, tab } = await tabForWorkspaceLinkId(workspaceLinkId);
  const quality = normalizeCaptureQuality(qualityInput);
  const screenshot = await sendCdpCommand(tab.id, "Page.captureScreenshot", {
    format: "jpeg",
    quality: Math.round(quality.imageQuality * 100),
    captureBeyondViewport: true,
    fromSurface: true,
  });
  if (!screenshot?.data || typeof screenshot.data !== "string") {
    throw new Error("Chrome did not return screenshot data.");
  }
  const rawDataUrl = `data:image/jpeg;base64,${screenshot.data}`;
  const optimized = (await sendOffscreenMessage({
    type: "t3code.browserAgent.screenshot.optimize",
    dataUrl: rawDataUrl,
    quality,
  }).catch(() => null)) ?? { dataUrl: rawDataUrl };
  const updatedTab = await chrome.tabs.get(tab.id).catch(() => tab);
  const contentLink = await workspaceLinkForContent(link, updatedTab);
  await upsertLink(linkForStorage(contentLink));
  sendThreadTabUpdated(
    contentLink,
    updatedTab,
    updatedTab.status === "loading" ? "loading" : "complete",
  );
  return {
    dataUrl: optimized.dataUrl,
    ...(optimized.width ? { width: optimized.width } : {}),
    ...(optimized.height ? { height: optimized.height } : {}),
    url: updatedTab.url ?? link.url ?? null,
    title: updatedTab.title ?? link.title ?? null,
  };
}

async function screenshotThreadTab(command) {
  const payload = await captureLinkedTabScreenshot(command.workspaceLinkId, command.quality);
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    payload,
  });
}

async function startCdpScreencast(command, params) {
  const { link, tab } = await tabForWorkspaceLinkId(command.workspaceLinkId);
  const quality = normalizeCaptureQuality(params.quality ?? command.quality);
  const liveViewSessionId = `cdp-screencast:${command.workspaceLinkId}:${Date.now()}`;
  await stopCdpScreencast(command.workspaceLinkId);
  await attachCdpToTab(tab.id);
  await sendRawCdpCommand(tab.id, "Page.enable").catch(() => undefined);
  cdpScreencastSessions.set(command.workspaceLinkId, {
    workspaceLinkId: command.workspaceLinkId,
    tabId: Number(tab.id),
    liveViewSessionId,
    quality,
    lastFrameSentAt: 0,
  });
  const updatedTab = await chrome.tabs.get(tab.id).catch(() => tab);
  const contentLink = await workspaceLinkForContent(link, updatedTab);
  await upsertLink(
    linkForStorage({
      ...contentLink,
      captureState: "live",
      streamState: "live",
      liveViewSessionId,
      cdpAttached: true,
      deepControlEnabled: true,
      browserControlState: "deep",
    }),
  );
  liveCaptureWorkspaceLinkIds.add(command.workspaceLinkId);
  sendThreadTabUpdated(
    contentLink,
    updatedTab,
    updatedTab.status === "loading" ? "loading" : "complete",
  );
  sendToServer({
    type: "browserAgent.capture.started",
    workspaceLinkId: command.workspaceLinkId,
    liveViewSessionId,
    transport: "websocket",
  });
  try {
    await sendRawCdpCommand(tab.id, "Page.startScreencast", {
      format: "jpeg",
      quality: Math.round(quality.imageQuality * 100),
      maxWidth: quality.maxWidth,
      maxHeight: quality.maxHeight,
      everyNthFrame: Math.max(1, Math.round(60 / quality.fps)),
    });
  } catch (error) {
    await stopCdpScreencast(command.workspaceLinkId, "error", true);
    throw error;
  }
  return {
    liveViewSessionId,
    transport: "websocket",
  };
}

async function startTabCapture(command) {
  const payload = await captureLinkedTabScreenshot(command.workspaceLinkId, command.quality);
  const liveViewSessionId = `screenshot-fallback:${command.workspaceLinkId}:${Date.now()}`;
  sendToServer({
    type: "browserAgent.capture.started",
    workspaceLinkId: command.workspaceLinkId,
    liveViewSessionId,
    transport: "screenshot-fallback",
  });
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    payload: {
      ...payload,
      liveViewSessionId,
      transport: "screenshot-fallback",
    },
  });
}

async function stopTabCapture(command) {
  await stopCdpScreencast(command.workspaceLinkId);
  sendToServer({
    type: "browserAgent.capture.stopped",
    workspaceLinkId: command.workspaceLinkId,
    reason: "user",
  });
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
  });
}

async function updateStoredLinkForRuntimeCommand(workspaceLinkId, patch) {
  const links = await readLinks();
  const nextLinks = links.map((entry) =>
    entry.id === workspaceLinkId ? linkForStorage({ ...entry, ...patch }) : entry,
  );
  workspaceLinksCache = nextLinks;
  await chrome.storage.local.set({ [LINKS_KEY]: nextLinks });
  return nextLinks.find((entry) => entry.id === workspaceLinkId) ?? null;
}

async function handleRuntimeCommand(command) {
  const { link, tab } = await tabForWorkspaceLinkId(command.workspaceLinkId);
  const params = command.params && typeof command.params === "object" ? command.params : {};
  let payload = null;

  switch (command.runtimeCommand) {
    case "workspace.snapshot":
      payload = await runtimeDiagnosticsSnapshot();
      break;
    case "workspace.pauseControl":
      await updateStoredLinkForRuntimeCommand(command.workspaceLinkId, {
        controlState: "paused-by-user",
        browserControlState: "paused",
      });
      payload = { controlState: "paused" };
      break;
    case "workspace.resumeControl":
      await attachCdpToTab(tab.id);
      await updateStoredLinkForRuntimeCommand(command.workspaceLinkId, {
        controlState: "enabled",
        browserControlState: "deep",
        deepControlEnabled: true,
        cdpAttached: true,
      });
      payload = { controlState: "deep", attached: true };
      break;
    case "cdp.send": {
      const method = typeof params.method === "string" ? params.method : "";
      if (!method) {
        throw new Error("cdp.send requires params.method.");
      }
      payload = await sendCdpCommand(tab.id, method, params.params ?? {});
      break;
    }
    case "cdp.runtime.evaluate": {
      const expression = typeof params.expression === "string" ? params.expression : "";
      if (!expression) {
        throw new Error("cdp.runtime.evaluate requires params.expression.");
      }
      payload = await sendCdpCommand(tab.id, "Runtime.evaluate", {
        expression,
        awaitPromise: params.awaitPromise !== false,
        returnByValue: params.returnByValue !== false,
      });
      break;
    }
    case "cdp.input.dispatch": {
      const event = params.event && typeof params.event === "object" ? params.event : params;
      payload = await sendCdpCommand(tab.id, "Input.dispatchMouseEvent", event);
      break;
    }
    case "cdp.network.enable":
      payload = await sendCdpCommand(tab.id, "Network.enable", params);
      break;
    case "cdp.network.disable":
      payload = await sendCdpCommand(tab.id, "Network.disable", params);
      break;
    case "cdp.accessibility.snapshot":
      payload = await sendCdpCommand(tab.id, "Accessibility.getFullAXTree", params);
      break;
    case "cdp.console.read":
      payload = await sendCdpCommand(tab.id, "Runtime.evaluate", {
        expression: "({ url: location.href, title: document.title })",
        returnByValue: true,
      });
      break;
    case "tab.focus":
      await focusTabForCommand(tab);
      payload = { focused: true };
      break;
    case "tab.close":
      await detachCdpFromTab(tab.id);
      await chrome.tabs.remove(tab.id);
      sendThreadTabUpdated(link, null, "closed");
      payload = { closed: true };
      break;
    case "tab.screenshot":
    case "tab.capture.start":
      payload = await captureLinkedTabScreenshot(command.workspaceLinkId, params.quality);
      break;
    case "tab.stream.start":
      payload = await startCdpScreencast(command, params);
      break;
    case "tab.capture.stop":
    case "tab.stream.stop":
      await stopCdpScreencast(command.workspaceLinkId, "user", true);
      payload = { stopped: true };
      break;
    case "diagnostics.snapshot":
      payload = await runtimeDiagnosticsSnapshot();
      break;
    case "diagnostics.logs":
      payload = { logs: diagnosticLogs };
      break;
    case "diagnostics.pingBackend": {
      const backend = await readActivePairedBackend();
      payload = backend ? await diagnoseBackend(backend) : { paired: false };
      break;
    }
    case "diagnostics.forceReconnect":
      if (localControlBaseUrl) {
        await connectLocalControlBackend(localControlBaseUrl);
      } else {
        await connectBackend({ force: true });
      }
      payload = { socketState: socketStateLabel() };
      break;
    case "diagnostics.clear":
      diagnosticLogs = [];
      payload = { cleared: true };
      break;
    default:
      throw new Error(`Unsupported browser runtime command '${command.runtimeCommand}'.`);
  }

  const updatedTab = tab.id ? await chrome.tabs.get(tab.id).catch(() => tab) : tab;
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: updatedTab.id,
    windowId: updatedTab.windowId,
    payload,
  });
}

async function handleServerMessage(rawData) {
  const command = JSON.parse(rawData);
  try {
    switch (command.type) {
      case "browserAgent.command.openOrFocusPreview":
        await openOrFocusPreview(command);
        return;
      case "browserAgent.command.activateAnnotation":
        await activateAnnotation(command);
        return;
      case "browserAgent.command.openOrFocusThreadTab":
        await openOrFocusThreadTab(command);
        return;
      case "browserAgent.command.attachActiveTab":
        await attachActiveTab(command);
        return;
      case "browserAgent.command.detachThreadTab":
        await detachThreadTab(command);
        return;
      case "browserAgent.command.startTabCapture":
        await startTabCapture(command);
        return;
      case "browserAgent.command.stopTabCapture":
        await stopTabCapture(command);
        return;
      case "browserAgent.command.input":
        await inputThreadTab(command);
        return;
      case "browserAgent.command.history":
        await historyThreadTab(command);
        return;
      case "browserAgent.command.navigate":
        await navigateThreadTab(command);
        return;
      case "browserAgent.command.snapshot":
        await snapshotThreadTab(command);
        return;
      case "browserAgent.command.screenshot":
        await screenshotThreadTab(command);
        return;
      case "browserAgent.command.runtime":
        await handleRuntimeCommand(command);
        return;
      case "browserAgent.command.requestTabsSnapshot":
        await sendTabsSnapshot();
        sendToServer({
          type: "browserAgent.command.result",
          commandId: command.commandId,
          ok: true,
        });
        return;
      default:
        return;
    }
  } catch (error) {
    addDiagnosticLog("error", "Browser-agent command failed", {
      type: command.type,
      runtimeCommand: command.runtimeCommand ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    if (command.commandId) {
      sendToServer({
        type: "browserAgent.command.result",
        commandId: command.commandId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

async function captureVisibleTab(sender) {
  if (!sender.tab?.windowId) {
    throw new Error("Cannot capture a screenshot outside a tab.");
  }
  return await captureVisibleTabWithRetry(sender.tab.windowId, { format: "png" });
}

async function transcribeAudio(input) {
  const backend = await readActivePairedBackend();
  if (!backend) {
    throw new Error("Pair this browser with T3 Code before recording audio.");
  }
  const result = await fetchJson(backend.baseUrl, "/api/audio-transcription", {
    method: "POST",
    token: backend.sessionToken,
    body: {
      audioBase64: input.audioBase64,
      existingText: input.existingText ?? "",
      format: input.format,
      mimeType: input.mimeType ?? "",
    },
  });
  return {
    ok: true,
    text: typeof result.text === "string" ? result.text : "",
  };
}

async function activateForCurrentTab(tab) {
  if (!tab?.id || !tab.url) {
    return { ok: false, reason: "No active tab." };
  }
  const links = await readLinks();
  const link = selectWorkspaceLinkForTab(links, tab);
  if (!link) {
    return { ok: false, reason: "No T3 Code workspace link matches this tab yet." };
  }
  const contentLink = await workspaceLinkForContent(link, tab);
  await setActiveNativeSidePanelLink(tab, contentLink);
  return { ok: true };
}

function cachedWorkspaceLinkForTab(tab) {
  if (!tab?.id || !tab.url) {
    return null;
  }
  return selectWorkspaceLinkForTab(workspaceLinksCache, tab);
}

async function completeSidePanelActionClick(tab, openPromise) {
  const result = await openPromise;
  if (result.opened) {
    await clearSidePanelOpenPrompt(tab);
  } else {
    await showSidePanelOpenPrompt(tab, result.reason);
  }
  const backend = await readActivePairedBackend();
  if (backend) {
    currentBackend = backend;
    await ensureBrowserAgentTransport();
    await activateForCurrentTab(tab).catch(() => undefined);
  }
}

async function openBackendFromActionClick(tab, backend) {
  currentBackend = backend;
  void connectBackend().catch((error) => {
    console.warn("[T3 Code] failed to connect after toolbar backend open", error);
  });

  const createProperties = {
    url: backend.baseUrl,
    active: true,
  };
  if (tab?.windowId !== undefined) {
    createProperties.windowId = tab.windowId;
  }
  await chrome.tabs.create(createProperties);
}

async function handleNonPreviewActionClick(tab) {
  const links = await readLinks().catch(() => workspaceLinksCache);
  if (tab?.id && tab.url && selectWorkspaceLinkForTab(links, tab)) {
    await completeSidePanelActionClick(tab, openNativeSidePanel(tab));
    return;
  }

  const backend = await readActivePairedBackend();
  if (backend?.baseUrl) {
    await openBackendFromActionClick(tab, backend);
    return;
  }

  await completeSidePanelActionClick(tab, openNativeSidePanel(tab));
}

chrome.debugger?.onEvent.addListener((source, method, params) => {
  if (method !== "Page.screencastFrame" || source.tabId === undefined) {
    return;
  }
  const session = Array.from(cdpScreencastSessions.values()).find(
    (entry) => entry.tabId === Number(source.tabId),
  );
  if (!session || !params || typeof params !== "object") {
    return;
  }
  const screencastSessionId = params.sessionId;
  if (Number.isFinite(screencastSessionId)) {
    void sendRawCdpCommand(source.tabId, "Page.screencastFrameAck", {
      sessionId: screencastSessionId,
    }).catch((error) => {
      addDiagnosticLog("warn", "Failed to acknowledge CDP screencast frame", {
        tabId: source.tabId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  if (typeof params.data !== "string" || params.data.length === 0) {
    return;
  }
  const now = Date.now();
  const minFrameIntervalMs = Math.max(0, Math.floor(1000 / session.quality.fps));
  if (session.lastFrameSentAt > 0 && now - session.lastFrameSentAt < minFrameIntervalMs) {
    return;
  }
  session.lastFrameSentAt = now;
  nextCdpScreencastFrameSequence += 1;
  const metadata = params.metadata && typeof params.metadata === "object" ? params.metadata : {};
  const width = Number.isFinite(metadata.deviceWidth) ? Math.round(metadata.deviceWidth) : null;
  const height = Number.isFinite(metadata.deviceHeight) ? Math.round(metadata.deviceHeight) : null;
  sendToServer({
    type: "browserAgent.capture.frame",
    workspaceLinkId: session.workspaceLinkId,
    liveViewSessionId: session.liveViewSessionId,
    dataUrl: cdpScreencastFrameDataUrl(params.data),
    ...(width && width > 0 ? { width } : {}),
    ...(height && height > 0 ? { height } : {}),
    sequence: nextCdpScreencastFrameSequence,
    timestamp: new Date(now).toISOString(),
  });
});

chrome.debugger?.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) {
    return;
  }
  const workspaceLinkIds = Array.from(cdpScreencastSessions.values())
    .filter((session) => session.tabId === Number(source.tabId))
    .map((session) => session.workspaceLinkId);
  for (const workspaceLinkId of workspaceLinkIds) {
    cdpScreencastSessions.delete(workspaceLinkId);
    liveCaptureWorkspaceLinkIds.delete(workspaceLinkId);
    sendToServer({
      type: "browserAgent.capture.stopped",
      workspaceLinkId,
      reason: reason === "target_closed" ? "tab-closed" : "permission-revoked",
      message: typeof reason === "string" ? reason : undefined,
    });
  }
  cdpAttachedTabIds.delete(Number(source.tabId));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (promise) => {
    promise
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  };

  switch (message?.type) {
    case "t3code.browserAgent.getStatus":
      return respond(
        (async () => {
          const backend = await readActivePairedBackend();
          const baseUrl = activeBrowserAgentBaseUrl(backend);
          return {
            ok: true,
            paired: hasActiveBrowserAgentTransport(backend),
            baseUrl,
            localControlBaseUrl,
            transportMode: localControlBaseUrl ? "local-control" : backend ? "paired" : "none",
            connected: socket?.readyState === WebSocket.OPEN,
            socketState: socketStateLabel(),
            socketBaseUrl,
            reconnectDelayMs,
            lastConnectionAttemptAt,
            lastConnectionOpenedAt,
            lastConnectionError,
            lastHelloSentAt,
            lastTabsSnapshotSentAt,
            backendDiagnostics: await diagnoseBackend(backend),
            runtimeDiagnostics: await runtimeDiagnosticsSnapshot(),
          };
        })(),
      );
    case "t3code.browserAgent.getSidePanelState":
      return respond(getSidePanelState(message));
    case "t3code.browserAgent.autoConnectNow":
      return respond(
        (async () => {
          if (
            message.baseUrls !== undefined &&
            !isExtensionPageSender(sender) &&
            !isTrustedAutoConnectContentSender(sender, message)
          ) {
            throw new Error("Custom auto-connect URLs are only available to extension pages.");
          }
          const result = await autoConnectLocalBackend({ baseUrls: message.baseUrls });
          return { ok: true, result };
        })(),
      );
    case "t3code.browserAgent.pair":
      return respond(
        (async () => {
          const result = await pairBackend(message);
          if (message.closeTabAfterPair === true && sender.tab?.id !== undefined) {
            setTimeout(() => {
              void chrome.tabs.remove(sender.tab.id).catch(() => undefined);
            }, 750);
          }
          return result;
        })(),
      );
    case "t3code.browserAgent.forget":
      return respond(clearBackend().then(() => ({ ok: true })));
    case "t3code.browserAgent.reloadExtension":
      return respond(
        Promise.resolve().then(() => {
          setTimeout(() => chrome.runtime.reload(), 150);
          return { ok: true };
        }),
      );
    case "t3code.browserAgent.openExtensionDetails":
      return respond(
        chrome.tabs
          .create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
          .then(() => ({ ok: true })),
      );
    case "t3code.browserAgent.captureVisibleTab":
      return respond(captureVisibleTab(sender).then((dataUrl) => ({ ok: true, dataUrl })));
    case "t3code.browserAgent.transcribeAudio":
      return respond(transcribeAudio(message));
    case "t3code.browserAgent.annotationSubmitted":
      return respond(
        (async () => {
          await ensureBrowserAgentTransport();
          sendToServer({
            type: "browserAgent.annotation.submitted",
            workspaceLinkId: message.workspaceLinkId,
            annotation: message.annotation,
          });
          return { ok: true };
        })(),
      );
    case "t3code.browserAgent.cancelAnnotation":
      return respond(
        (async () => {
          const links = await readLinks();
          const link =
            typeof message.workspaceLinkId === "string"
              ? links.find((entry) => entry.id === message.workspaceLinkId)
              : null;
          const activeRecord = await readActiveWorkspaceLink();
          const selectedLink =
            link ??
            links.find((entry) => linkMatchesActiveWorkspaceRecord(entry, activeRecord)) ??
            newestLink(links);
          const tab = selectedLink ? await findPreviewTab(selectedLink) : null;
          if (tab?.id !== undefined) {
            await sendTabMessage(tab.id, { type: "t3code.browserAgent.cancelAnnotation" });
          }
          return { ok: true };
        })(),
      );
    case "t3code.browserAgent.openSidePanelFromPage": {
      const tab = sender.tab;
      const openPromise = openNativeSidePanel(tab);
      return respond(
        (async () => {
          const result = await openPromise;
          if (!result.opened) {
            throw new Error(result.reason ?? "Chrome did not open the side panel.");
          }
          await clearSidePanelOpenPrompt(tab);
          await ensureBrowserAgentTransport();
          await activateForCurrentTab(tab).catch(() => undefined);
          return { ok: true };
        })(),
      );
    }
    case "t3code.browserAgent.activateFromSidebar":
      return respond(
        (async () => {
          await ensureBrowserAgentTransport();
          const link = message.workspaceLink;
          sendToServer({
            type: "browserAgent.annotation.submitted",
            workspaceLinkId: link.id,
            annotation: message.annotation,
          });
          return { ok: true };
        })(),
      );
    default:
      return false;
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (cachedWorkspaceLinkForTab(tab)) {
    const openPromise = openNativeSidePanel(tab);
    void completeSidePanelActionClick(tab, openPromise).catch((error) => {
      console.warn("[T3 Code] failed to handle preview toolbar click", error);
    });
    return;
  }

  void handleNonPreviewActionClick(tab).catch((error) => {
    console.warn("[T3 Code] failed to handle toolbar click", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[LINKS_KEY]) {
    return;
  }
  const links = changes[LINKS_KEY].newValue;
  workspaceLinksCache = Array.isArray(links) ? links : [];
});

chrome.tabs.onCreated.addListener((tab) => {
  void syncNativeSidePanelOptionsForTab(tab);
  void sendTabsSnapshot();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void syncNativeSidePanelOptionsForTab(tab);
    void notifyThreadLinksForTab(tab, changeInfo.status === "loading" ? "loading" : "complete");
  }
  void sendTabsSnapshot();
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  cdpAttachedTabIds.delete(Number(tabId));
  void notifyThreadLinksForRemovedTab(tabId, removeInfo.windowId);
  void sendTabsSnapshot();
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncNativeSidePanelOptionsForTabId(tabId);
  void sendTabsSnapshot();
});
chrome.windows.onFocusChanged.addListener(() => {
  void syncNativeSidePanelOptionsForFocusedWindow();
  void sendTabsSnapshot();
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name !== AUTO_CONNECT_ALARM_NAME) {
    return;
  }
  autoConnectInBackground("alarm");
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanelBehavior();
  scheduleAutoConnectAlarm();
  autoConnectInBackground("startup");
});
chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanelBehavior();
  scheduleAutoConnectAlarm();
  autoConnectInBackground("install");
});

void readLinks().catch(() => undefined);
void configureSidePanelBehavior();
scheduleAutoConnectAlarm();
autoConnectInBackground("service worker activation");
