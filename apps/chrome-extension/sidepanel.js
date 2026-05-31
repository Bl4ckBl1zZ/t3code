/* global chrome */

const PAGE_SOURCE = "t3code.web";
const EXTENSION_SOURCE = "t3code.chrome-extension";
const SIDE_PANEL_GET_SESSION_MESSAGE_TYPE = "t3code.sidePanel.getSession";
const SIDE_PANEL_READY_MESSAGE_TYPE = "t3code.sidePanel.ready";
const ANNOTATION_PROBE_MESSAGE_TYPE = "t3code.browserAnnotation.probe";
const ANNOTATION_READY_MESSAGE_TYPE = "t3code.browserAnnotation.ready";
const ANNOTATION_STATUS_MESSAGE_TYPE = "t3code.browserAnnotation.status";
const ANNOTATION_ACTIVATE_MESSAGE_TYPE = "t3code.browserAnnotation.activate";
const ANNOTATION_CAPTURED_MESSAGE_TYPE = "t3code.browserAnnotation.capture";
const SIDE_PANEL_SESSION_PARAM = "t3SidePanelSessionId";

const frame = document.getElementById("frame");
const status = document.getElementById("status");
const sessionId = new URL(window.location.href).searchParams.get("sessionId")?.trim() ?? "";
let frameOrigin = null;
let port = null;

function setStatus(message) {
  if (!status) return;
  status.textContent = message;
  status.dataset.hidden = "false";
}

function showFrame() {
  if (frame) {
    frame.style.display = "block";
  }
  if (status) {
    status.dataset.hidden = "true";
  }
}

function postToFrame(message) {
  if (!frame?.contentWindow || !frameOrigin) {
    return;
  }
  frame.contentWindow.postMessage(
    {
      source: EXTENSION_SOURCE,
      ...message,
    },
    frameOrigin,
  );
}

async function sendRuntimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Extension request failed.");
  }
  return response.result;
}

function isPageBridgeMessage(data) {
  return (
    typeof data === "object" &&
    data !== null &&
    data.source === PAGE_SOURCE &&
    (data.type === ANNOTATION_PROBE_MESSAGE_TYPE || data.type === ANNOTATION_ACTIVATE_MESSAGE_TYPE)
  );
}

async function postAnnotationStatus(type) {
  try {
    const result = await sendRuntimeMessage({
      type: ANNOTATION_STATUS_MESSAGE_TYPE,
      sidePanelSessionId: sessionId,
    });
    postToFrame({
      type,
      linked: Boolean(result?.linked),
      active: Boolean(result?.active),
      ...(result?.browserContext ? { browserContext: result.browserContext } : {}),
    });
  } catch {
    postToFrame({ type, linked: false, active: false });
  }
}

async function activateAnnotationMode() {
  try {
    const result = await sendRuntimeMessage({
      type: ANNOTATION_ACTIVATE_MESSAGE_TYPE,
      sidePanelSessionId: sessionId,
    });
    postToFrame({
      type: ANNOTATION_STATUS_MESSAGE_TYPE,
      linked: Boolean(result?.linked),
      active: Boolean(result?.active),
      ...(result?.browserContext ? { browserContext: result.browserContext } : {}),
    });
  } catch (error) {
    postToFrame({
      type: ANNOTATION_STATUS_MESSAGE_TYPE,
      linked: false,
      active: false,
      error: error instanceof Error ? error.message : "Annotation mode failed.",
    });
  }
}

window.addEventListener("message", (event) => {
  if (
    !frame?.contentWindow ||
    event.source !== frame.contentWindow ||
    event.origin !== frameOrigin
  ) {
    return;
  }
  if (!isPageBridgeMessage(event.data)) {
    return;
  }

  if (event.data.type === ANNOTATION_PROBE_MESSAGE_TYPE) {
    void postAnnotationStatus(ANNOTATION_READY_MESSAGE_TYPE);
    return;
  }

  void activateAnnotationMode();
});

async function boot() {
  if (!sessionId) {
    setStatus("Missing T3 Code side panel session.");
    return;
  }

  const session = await sendRuntimeMessage({
    type: SIDE_PANEL_GET_SESSION_MESSAGE_TYPE,
    sessionId,
  });
  const t3Url = new URL(session.t3Url);
  t3Url.searchParams.set(SIDE_PANEL_SESSION_PARAM, sessionId);
  frameOrigin = t3Url.origin;

  port = chrome.runtime.connect({ name: "t3code.sidePanel" });
  port.postMessage({ type: SIDE_PANEL_READY_MESSAGE_TYPE, sessionId });
  port.onMessage.addListener((message) => {
    if (
      typeof message === "object" &&
      message !== null &&
      message.type === ANNOTATION_CAPTURED_MESSAGE_TYPE
    ) {
      postToFrame(message);
      postToFrame({
        type: ANNOTATION_STATUS_MESSAGE_TYPE,
        linked: true,
        active: false,
      });
    }
  });

  frame.addEventListener("load", showFrame, { once: true });
  frame.src = t3Url.toString();
}

boot().catch((error) => {
  setStatus(error instanceof Error ? error.message : "Could not open T3 Code.");
});
