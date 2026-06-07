const AUTO_PAIR_REQUEST_TYPE = "t3code.browserAgent.autoPair";
const AUTO_PAIR_RESULT_TYPE = "t3code.browserAgent.autoPair.result";
const AUTO_CONNECT_REQUEST_TYPE = "t3code.browserAgent.autoConnect";
const AUTO_CONNECT_RESULT_TYPE = "t3code.browserAgent.autoConnect.result";
const PAIR_RUNTIME_MESSAGE_TYPE = "t3code.browserAgent.pair";
const AUTO_CONNECT_RUNTIME_MESSAGE_TYPE = "t3code.browserAgent.autoConnectNow";
const AUTO_PAIR_PATH = "/browser-agent/auto-pair";
const BROWSER_AGENT_SESSION_PATH = "/browser-agent/session";
const PAIRING_CONTENT_RUNTIME_KEY = "__t3codeBrowserAgentPairingContent";
const PAIRING_CONTENT_DEBUG_PREFIX = "[t3 browser-agent pairing-content]";

globalThis[PAIRING_CONTENT_RUNTIME_KEY]?.dispose?.();
const listenerDisposers = [];
globalThis[PAIRING_CONTENT_RUNTIME_KEY] = {
  dispose() {
    while (listenerDisposers.length > 0) {
      listenerDisposers.pop()?.();
    }
  },
};

function addWindowMessageListener(listener) {
  window.addEventListener("message", listener);
  listenerDisposers.push(() => window.removeEventListener("message", listener));
}

function logPairingContentDebug(event, details = {}) {
  console.info(`${PAIRING_CONTENT_DEBUG_PREFIX} ${event}`, details);
}

function parseAutoPairUrl() {
  const url = new URL(window.location.href);
  if (url.pathname !== AUTO_PAIR_PATH || url.searchParams.get("t3BrowserAgentPair") !== "1") {
    return null;
  }

  const baseUrl = url.searchParams.get("t3BrowserAgentBaseUrl") ?? "";
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const credential =
    hashParams.get("t3BrowserAgentCredential") ??
    url.searchParams.get("t3BrowserAgentCredential") ??
    "";
  const sessionToken =
    hashParams.get("t3BrowserAgentSessionToken") ??
    url.searchParams.get("t3BrowserAgentSessionToken") ??
    "";
  const useBrowserSession = url.searchParams.get("t3BrowserAgentUseBrowserSession") === "1";
  if (!sameOrigin(url.origin, baseUrl)) {
    return null;
  }
  if (!credential.trim() && !sessionToken.trim() && !useBrowserSession) {
    return null;
  }

  return {
    baseUrl,
    credential: credential.trim() || null,
    sessionToken: sessionToken.trim() || null,
    useBrowserSession,
    closeTabAfterPair: url.searchParams.get("t3BrowserAgentClose") === "1",
  };
}

function sameOrigin(origin, rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === origin && isTrustedPairingHostname(url.hostname);
  } catch {
    return false;
  }
}

function isTrustedPairingHostname(hostname) {
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

function trustedAutoConnectBaseUrls(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => {
    try {
      const url = new URL(entry);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        isTrustedPairingHostname(url.hostname)
      );
    } catch {
      return false;
    }
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function scrubPairingParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("t3BrowserAgentPair");
  url.searchParams.delete("t3BrowserAgentBaseUrl");
  url.searchParams.delete("t3BrowserAgentUseBrowserSession");
  url.searchParams.delete("t3BrowserAgentSessionToken");
  url.searchParams.delete("t3BrowserAgentCredential");
  url.searchParams.delete("t3BrowserAgentClose");
  url.hash = "";
  window.history.replaceState(null, document.title, url.toString());
}

async function fetchBrowserAgentSession(baseUrl) {
  logPairingContentDebug("browser-session-fetch-start", { baseUrl });
  const response = await fetch(new URL(BROWSER_AGENT_SESSION_PATH, baseUrl), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  });
  const body = await response.json().catch(() => null);
  logPairingContentDebug("browser-session-fetch-response", {
    baseUrl,
    status: response.status,
    ok: response.ok,
    hasSessionId: typeof body?.sessionId === "string" && body.sessionId.length > 0,
    hasSessionToken: typeof body?.sessionToken === "string" && body.sessionToken.length > 0,
    error: body?.message ?? body?.error ?? null,
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "This browser is not authenticated to this T3 Code host. Open the T3 Code host in this browser, pair or sign in there, then retry Preview.",
      );
    }
    throw new Error(
      body?.message ??
        body?.error ??
        `Could not prepare a browser-agent session (${response.status}).`,
    );
  }
  if (typeof body?.sessionToken !== "string" || body.sessionToken.length === 0) {
    throw new Error("The backend did not return a browser-agent session token.");
  }
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
    throw new Error("The backend did not return a browser-agent session id.");
  }
  return {
    sessionId: body.sessionId,
    sessionToken: body.sessionToken,
  };
}

function isRejectedBrowserAgentSessionTokenError(error) {
  return (
    typeof error === "string" &&
    error.toLowerCase().includes("rejected the browser agent session token")
  );
}

async function pairWithFreshSessionOnRejectedToken(input) {
  logPairingContentDebug("runtime-pair-send", {
    baseUrl: input.baseUrl,
    hasCredential: Boolean(input.credential),
    hasSessionToken: Boolean(input.sessionToken),
    sessionId: input.sessionId ?? null,
    closeTabAfterPair: input.closeTabAfterPair === true,
  });
  const firstResponse = await sendRuntimeMessage({
    type: PAIR_RUNTIME_MESSAGE_TYPE,
    baseUrl: input.baseUrl,
    ...(input.credential ? { credential: input.credential } : {}),
    ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
    ...(input.closeTabAfterPair ? { closeTabAfterPair: true } : {}),
  });
  logPairingContentDebug("runtime-pair-response", {
    baseUrl: input.baseUrl,
    ok: firstResponse?.ok === true,
    error: firstResponse?.error ?? null,
    sessionId: input.sessionId ?? null,
  });
  if (firstResponse?.ok || !isRejectedBrowserAgentSessionTokenError(firstResponse?.error)) {
    return {
      response: firstResponse,
      sessionId: input.sessionId,
    };
  }

  logPairingContentDebug("runtime-pair-token-rejected-retry", {
    baseUrl: input.baseUrl,
    sessionId: input.sessionId ?? null,
  });
  const freshSession = await fetchBrowserAgentSession(input.baseUrl);
  logPairingContentDebug("runtime-pair-retry-send", {
    baseUrl: input.baseUrl,
    sessionId: freshSession.sessionId,
    hasSessionToken: freshSession.sessionToken.length > 0,
  });
  const retryResponse = await sendRuntimeMessage({
    type: PAIR_RUNTIME_MESSAGE_TYPE,
    baseUrl: input.baseUrl,
    ...(input.credential ? { credential: input.credential } : {}),
    sessionToken: freshSession.sessionToken,
    ...(input.closeTabAfterPair ? { closeTabAfterPair: true } : {}),
  });
  logPairingContentDebug("runtime-pair-retry-response", {
    baseUrl: input.baseUrl,
    ok: retryResponse?.ok === true,
    error: retryResponse?.error ?? null,
    sessionId: freshSession.sessionId,
  });
  return {
    response: retryResponse,
    sessionId: freshSession.sessionId,
  };
}

function renderStatus(title, body) {
  const render = () => {
    document.documentElement.style.colorScheme = "dark";
    document.body.innerHTML = "";
    document.body.style.margin = "0";
    document.body.style.minHeight = "100vh";
    document.body.style.display = "grid";
    document.body.style.placeItems = "center";
    document.body.style.background = "#111";
    document.body.style.color = "#f7f7f7";
    document.body.style.font = "14px -apple-system, BlinkMacSystemFont, sans-serif";

    const panel = document.createElement("main");
    panel.style.maxWidth = "420px";
    panel.style.padding = "24px";
    panel.style.border = "1px solid rgba(255,255,255,0.12)";
    panel.style.borderRadius = "12px";
    panel.style.background = "rgba(255,255,255,0.04)";

    const heading = document.createElement("h1");
    heading.textContent = title;
    heading.style.margin = "0 0 8px";
    heading.style.fontSize = "18px";

    const message = document.createElement("p");
    message.textContent = body;
    message.style.margin = "0";
    message.style.color = "rgba(255,255,255,0.7)";
    message.style.lineHeight = "1.5";

    panel.append(heading, message);
    document.body.append(panel);
  };

  if (document.body) {
    render();
  } else {
    window.addEventListener("DOMContentLoaded", render, { once: true });
  }
}

async function pairFromUrl() {
  const pairing = parseAutoPairUrl();
  if (!pairing) {
    return;
  }

  scrubPairingParams();
  renderStatus("Pairing T3 Code Browser Agent", "Keep this tab open for a moment.");
  logPairingContentDebug("setup-url-pair-start", {
    baseUrl: pairing.baseUrl,
    hasCredential: Boolean(pairing.credential),
    hasSessionToken: Boolean(pairing.sessionToken),
    useBrowserSession: pairing.useBrowserSession,
    closeTabAfterPair: pairing.closeTabAfterPair,
  });
  const browserAgentSession = pairing.useBrowserSession
    ? await fetchBrowserAgentSession(pairing.baseUrl)
    : pairing.sessionToken
      ? { sessionToken: pairing.sessionToken, sessionId: null }
      : null;
  const { response } = await pairWithFreshSessionOnRejectedToken({
    baseUrl: pairing.baseUrl,
    ...(pairing.credential ? { credential: pairing.credential } : {}),
    ...(browserAgentSession?.sessionToken
      ? { sessionToken: browserAgentSession.sessionToken }
      : {}),
    ...(browserAgentSession?.sessionId ? { sessionId: browserAgentSession.sessionId } : {}),
    closeTabAfterPair: pairing.closeTabAfterPair,
  });

  if (!response?.ok) {
    logPairingContentDebug("setup-url-pair-failed", {
      baseUrl: pairing.baseUrl,
      error: response?.error ?? null,
    });
    renderStatus(
      "Browser pairing failed",
      response?.error ?? "The T3 Code Browser Agent extension rejected the pairing request.",
    );
    return;
  }

  logPairingContentDebug("setup-url-pair-complete", {
    baseUrl: pairing.baseUrl,
  });
  renderStatus("Browser paired", "Returning to T3 Code.");
}

addWindowMessageListener((event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (data?.type !== AUTO_PAIR_REQUEST_TYPE) {
    return;
  }

  logPairingContentDebug("window-auto-pair-request", {
    baseUrl: data.baseUrl ?? null,
    hasCredential: typeof data.credential === "string" && data.credential.length > 0,
    hasSessionToken: typeof data.sessionToken === "string" && data.sessionToken.length > 0,
    useBrowserSession: data.useBrowserSession === true,
  });
  if (!sameOrigin(window.location.origin, data.baseUrl ?? "")) {
    logPairingContentDebug("window-auto-pair-rejected-cross-origin", {
      pageOrigin: window.location.origin,
      baseUrl: data.baseUrl ?? null,
    });
    window.postMessage(
      {
        type: AUTO_PAIR_RESULT_TYPE,
        requestId: data.requestId,
        ok: false,
        error: "Pairing requests must target the current T3 Code origin.",
      },
      window.location.origin,
    );
    return;
  }

  void Promise.resolve()
    .then(async () => {
      const browserAgentSession =
        data.useBrowserSession === true
          ? await fetchBrowserAgentSession(data.baseUrl)
          : typeof data.sessionToken === "string"
            ? { sessionToken: data.sessionToken, sessionId: null }
            : null;
      return await pairWithFreshSessionOnRejectedToken({
        baseUrl: data.baseUrl,
        ...(typeof data.credential === "string" ? { credential: data.credential } : {}),
        ...(browserAgentSession?.sessionToken
          ? { sessionToken: browserAgentSession.sessionToken }
          : {}),
        ...(browserAgentSession?.sessionId ? { sessionId: browserAgentSession.sessionId } : {}),
      });
    })
    .then((response) => {
      logPairingContentDebug("window-auto-pair-result", {
        baseUrl: data.baseUrl ?? null,
        ok: response.response?.ok === true,
        sessionId: response.sessionId ?? null,
        error: response.response?.error ?? null,
      });
      window.postMessage(
        {
          type: AUTO_PAIR_RESULT_TYPE,
          requestId: data.requestId,
          ok: response.response?.ok === true,
          ...(response.sessionId ? { sessionId: response.sessionId } : {}),
          ...(response.response?.error ? { error: response.response.error } : {}),
        },
        window.location.origin,
      );
    })
    .catch((error) => {
      logPairingContentDebug("window-auto-pair-error", {
        baseUrl: data.baseUrl ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      window.postMessage(
        {
          type: AUTO_PAIR_RESULT_TYPE,
          requestId: data.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        window.location.origin,
      );
    });
});

addWindowMessageListener((event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (data?.type !== AUTO_CONNECT_REQUEST_TYPE) {
    return;
  }

  if (!sameOrigin(window.location.origin, data.pageBaseUrl ?? "")) {
    window.postMessage(
      {
        type: AUTO_CONNECT_RESULT_TYPE,
        requestId: data.requestId,
        ok: false,
        error: "Auto-connect requests must come from the current T3 Code origin.",
      },
      window.location.origin,
    );
    return;
  }

  const baseUrls = trustedAutoConnectBaseUrls(data.baseUrls);
  if (baseUrls.length === 0) {
    window.postMessage(
      {
        type: AUTO_CONNECT_RESULT_TYPE,
        requestId: data.requestId,
        ok: false,
        error: "Auto-connect did not receive a trusted T3 Code backend URL.",
      },
      window.location.origin,
    );
    return;
  }

  void sendRuntimeMessage({
    type: AUTO_CONNECT_RUNTIME_MESSAGE_TYPE,
    pageBaseUrl: data.pageBaseUrl,
    baseUrls,
  })
    .then((response) => {
      window.postMessage(
        {
          type: AUTO_CONNECT_RESULT_TYPE,
          requestId: data.requestId,
          ok: response?.ok === true && response.result?.connected === true,
          ...(response?.error ? { error: response.error } : {}),
        },
        window.location.origin,
      );
    })
    .catch((error) => {
      window.postMessage(
        {
          type: AUTO_CONNECT_RESULT_TYPE,
          requestId: data.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        window.location.origin,
      );
    });
});

void pairFromUrl().catch((error) => {
  logPairingContentDebug("setup-url-pair-error", {
    error: error instanceof Error ? error.message : String(error),
  });
  scrubPairingParams();
  renderStatus(
    "Browser pairing failed",
    error instanceof Error ? error.message : "The T3 Code Browser Agent extension could not pair.",
  );
});
