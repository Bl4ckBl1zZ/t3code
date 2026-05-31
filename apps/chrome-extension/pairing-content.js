const AUTO_PAIR_REQUEST_TYPE = "t3code.browserAgent.autoPair";
const AUTO_PAIR_RESULT_TYPE = "t3code.browserAgent.autoPair.result";
const PAIR_RUNTIME_MESSAGE_TYPE = "t3code.browserAgent.pair";
const AUTO_PAIR_PATH = "/browser-agent/auto-pair";

function parseAutoPairUrl() {
  const url = new URL(window.location.href);
  if (url.pathname !== AUTO_PAIR_PATH || url.searchParams.get("t3BrowserAgentPair") !== "1") {
    return null;
  }

  const baseUrl = url.searchParams.get("t3BrowserAgentBaseUrl") ?? "";
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const sessionToken =
    hashParams.get("t3BrowserAgentSessionToken") ??
    url.searchParams.get("t3BrowserAgentSessionToken") ??
    "";
  if (!sameOrigin(url.origin, baseUrl) || !sessionToken.trim()) {
    return null;
  }

  return {
    baseUrl,
    sessionToken,
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
  url.searchParams.delete("t3BrowserAgentSessionToken");
  url.searchParams.delete("t3BrowserAgentCredential");
  url.searchParams.delete("t3BrowserAgentClose");
  url.hash = "";
  window.history.replaceState(null, document.title, url.toString());
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
  const response = await sendRuntimeMessage({
    type: PAIR_RUNTIME_MESSAGE_TYPE,
    baseUrl: pairing.baseUrl,
    sessionToken: pairing.sessionToken,
    closeTabAfterPair: pairing.closeTabAfterPair,
  });

  if (!response?.ok) {
    renderStatus(
      "Browser pairing failed",
      response?.error ?? "The T3 Code Browser Agent extension rejected the pairing request.",
    );
    return;
  }

  renderStatus("Browser paired", "Returning to T3 Code.");
}

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (data?.type !== AUTO_PAIR_REQUEST_TYPE) {
    return;
  }

  if (!sameOrigin(window.location.origin, data.baseUrl ?? "")) {
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

  void sendRuntimeMessage({
    type: PAIR_RUNTIME_MESSAGE_TYPE,
    baseUrl: data.baseUrl,
    sessionToken: data.sessionToken,
  })
    .then((response) => {
      window.postMessage(
        {
          type: AUTO_PAIR_RESULT_TYPE,
          requestId: data.requestId,
          ok: response?.ok === true,
          ...(response?.error ? { error: response.error } : {}),
        },
        window.location.origin,
      );
    })
    .catch((error) => {
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

void pairFromUrl().catch((error) => {
  scrubPairingParams();
  renderStatus(
    "Browser pairing failed",
    error instanceof Error ? error.message : "The T3 Code Browser Agent extension could not pair.",
  );
});
