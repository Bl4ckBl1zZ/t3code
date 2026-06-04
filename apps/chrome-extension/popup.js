function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (response?.ok === false) {
        reject(new Error(response.error ?? response.reason ?? "Request failed."));
        return;
      }
      resolve(response);
    });
  });
}

const statusEl = document.getElementById("status");
const diagnosticsEl = document.getElementById("diagnostics");
const baseUrlEl = document.getElementById("base-url");
const credentialEl = document.getElementById("credential");
const form = document.getElementById("pair-form");
const forgetButton = document.getElementById("forget");

function setStatus(message, options = {}) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", options.error === true);
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "none";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatDiagnosticCheck(check) {
  const state = check.ok ? "ok" : "failed";
  const detail = check.ok ? check.result : check.error;
  return `${check.name}: ${state} ${formatValue(detail)}`;
}

function renderDiagnostics(status) {
  const backendDiagnostics = status.backendDiagnostics;
  const lines = [
    `socket: ${formatValue(status.socketState)}`,
    `socketBaseUrl: ${formatValue(status.socketBaseUrl)}`,
    `lastAttempt: ${formatValue(status.lastConnectionAttemptAt)}`,
    `lastOpened: ${formatValue(status.lastConnectionOpenedAt)}`,
    `lastHello: ${formatValue(status.lastHelloSentAt)}`,
    `lastTabsSnapshot: ${formatValue(status.lastTabsSnapshotSentAt)}`,
    `lastError: ${formatValue(status.lastConnectionError)}`,
  ];

  if (backendDiagnostics?.paired) {
    lines.push(
      `pairedAt: ${formatValue(backendDiagnostics.pairedAt)}`,
      "",
      ...backendDiagnostics.checks.map(formatDiagnosticCheck),
    );
  } else {
    lines.push("", "backend: not paired");
  }

  diagnosticsEl.textContent = lines.join("\n");
}

async function refreshStatus() {
  const status = await send({ type: "t3code.browserAgent.getStatus" });
  if (status.baseUrl) {
    baseUrlEl.value = status.baseUrl;
  }
  if (status.paired) {
    setStatus(`${status.connected ? "Connected" : "Paired"}: ${status.baseUrl}`);
  } else {
    setStatus("Not paired.");
  }
  renderDiagnostics(status);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  setStatus("Pairing...");
  void send({
    type: "t3code.browserAgent.pair",
    baseUrl: baseUrlEl.value,
    credential: credentialEl.value,
  })
    .then(() => {
      credentialEl.value = "";
      return refreshStatus();
    })
    .catch((error) => setStatus(error.message, { error: true }));
});

forgetButton.addEventListener("click", () => {
  void send({ type: "t3code.browserAgent.forget" })
    .then(refreshStatus)
    .catch((error) => setStatus(error.message, { error: true }));
});

void refreshStatus().catch((error) => {
  setStatus(error.message, { error: true });
  diagnosticsEl.textContent = `status: failed\nerror: ${error.message}`;
});
