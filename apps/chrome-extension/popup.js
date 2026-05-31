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
const baseUrlEl = document.getElementById("base-url");
const credentialEl = document.getElementById("credential");
const form = document.getElementById("pair-form");
const forgetButton = document.getElementById("forget");

function setStatus(message, options = {}) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", options.error === true);
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

void refreshStatus().catch((error) => setStatus(error.message, { error: true }));
