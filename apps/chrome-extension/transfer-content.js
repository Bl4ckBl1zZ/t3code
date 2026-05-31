const ROOT_ID = "t3code-browser-agent-root";
const HIGHLIGHT_ID = "t3code-browser-agent-highlight";
const CANCEL_ANNOTATION_MESSAGE_TYPE = "t3code.browserAgent.cancelAnnotation";
const BODY_MARGIN_RIGHT_ATTR = "data-t3code-browser-agent-body-margin-right";
const BODY_TRANSITION_ATTR = "data-t3code-browser-agent-body-transition";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 300;
const MAX_WIDTH = 760;

let workspaceLink = null;
let sidebarRoot = null;
let shadowRoot = null;
let sidebarWidth = DEFAULT_WIDTH;
let annotationState = null;
let resizeState = null;

function clampSidebarWidth(width) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (response?.ok === false) {
        reject(new Error(response.error ?? response.reason ?? "Extension request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function removeExistingRoot() {
  document.getElementById(ROOT_ID)?.remove();
}

function pageBody() {
  return document.body;
}

function preserveBodyLayout() {
  const body = pageBody();
  if (!body) {
    return null;
  }
  if (!body.hasAttribute(BODY_MARGIN_RIGHT_ATTR)) {
    body.setAttribute(BODY_MARGIN_RIGHT_ATTR, body.style.marginRight);
  }
  if (!body.hasAttribute(BODY_TRANSITION_ATTR)) {
    body.setAttribute(BODY_TRANSITION_ATTR, body.style.transition);
  }
  return body;
}

function applyPageInset() {
  const body = preserveBodyLayout();
  if (!body) {
    return;
  }
  body.style.marginRight = `${sidebarWidth}px`;
}

function ensureSidebar(link) {
  workspaceLink = link;
  if (typeof link.sidebarWidthPx === "number" && Number.isFinite(link.sidebarWidthPx)) {
    sidebarWidth = clampSidebarWidth(link.sidebarWidthPx);
  }
  if (sidebarRoot?.isConnected && shadowRoot) {
    applyPageInset();
    renderSidebar();
    return;
  }

  removeExistingRoot();
  applyPageInset();
  sidebarRoot = document.createElement("div");
  sidebarRoot.id = ROOT_ID;
  sidebarRoot.style.position = "fixed";
  sidebarRoot.style.top = "0";
  sidebarRoot.style.right = "0";
  sidebarRoot.style.bottom = "0";
  sidebarRoot.style.width = `${sidebarWidth}px`;
  sidebarRoot.style.zIndex = "2147483646";
  sidebarRoot.style.pointerEvents = "auto";
  document.documentElement.appendChild(sidebarRoot);
  shadowRoot = sidebarRoot.attachShadow({ mode: "open" });
  renderSidebar();
}

function setSidebarStatus(statusText) {
  const status = shadowRoot?.querySelector(".status");
  if (status) {
    status.textContent = statusText;
  }
}

function renderSidebar(statusText = "Connected") {
  if (!shadowRoot || !workspaceLink) {
    return;
  }
  shadowRoot.innerHTML = `
    <style>
      :host {
        all: initial;
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .panel {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        background: rgba(15, 15, 16, 0.97);
        color: #f5f5f5;
        border-left: 1px solid rgba(255,255,255,0.12);
        box-shadow: -24px 0 60px rgba(0,0,0,0.24);
        display: flex;
        flex-direction: column;
      }
      .resize {
        position: absolute;
        top: 0;
        left: -4px;
        width: 8px;
        height: 100%;
        cursor: col-resize;
      }
      .body {
        position: relative;
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        flex: 1;
        border: 0;
        background: #0f0f10;
      }
      .status {
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 12px;
        box-sizing: border-box;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 8px;
        background: rgba(15, 15, 16, 0.9);
        color: #cbd5e1;
        font-size: 13px;
        line-height: 1.45;
        padding: 8px 10px;
        pointer-events: none;
      }
      .status:empty {
        display: none;
      }
      .fallback {
        display: none;
        flex: 1;
        place-items: center;
        padding: 24px;
        color: #cbd5e1;
        font-size: 13px;
        line-height: 1.45;
      }
      .fallback.visible {
        display: grid;
      }
    </style>
    <div class="panel">
      <div class="resize" title="Resize"></div>
      <div class="body">
        <iframe class="chat" title="T3 Code chat"></iframe>
        <div class="fallback"></div>
        <div class="status"></div>
      </div>
    </div>
  `;

  setSidebarStatus(statusText);
  const frame = shadowRoot.querySelector(".chat");
  const fallback = shadowRoot.querySelector(".fallback");
  if (typeof workspaceLink.t3Url === "string" && workspaceLink.t3Url.length > 0) {
    frame.src = workspaceLink.t3Url;
    frame.addEventListener("load", () => setSidebarStatus(""));
  } else {
    frame.remove();
    fallback.classList.add("visible");
    fallback.textContent =
      "This workspace link does not include a chat URL. Reopen the preview from T3 Code.";
  }
  shadowRoot.querySelector(".resize").addEventListener("pointerdown", startResize);
}

function setIframePointerEvents(value) {
  const frame = shadowRoot?.querySelector(".chat");
  if (frame) {
    frame.style.pointerEvents = value;
  }
}

function cleanupResize() {
  if (!resizeState) {
    return;
  }
  resizeState.controller.abort();
  try {
    resizeState.handle.releasePointerCapture?.(resizeState.pointerId);
  } catch {
    // The browser may have already released capture after pointerup/cancel.
  }
  resizeState = null;
  setIframePointerEvents("");
  document.documentElement.style.cursor = "";
  document.documentElement.style.userSelect = "";
}

function startResize(event) {
  event.preventDefault();
  cleanupResize();
  const startX = event.clientX;
  const startWidth = sidebarWidth;
  const handle = event.currentTarget;
  if (!handle) {
    return;
  }
  const controller = new AbortController();
  resizeState = {
    controller,
    handle,
    pointerId: event.pointerId,
  };
  handle.setPointerCapture?.(event.pointerId);
  setIframePointerEvents("none");
  document.documentElement.style.cursor = "col-resize";
  document.documentElement.style.userSelect = "none";

  const onMove = (moveEvent) => {
    const delta = startX - moveEvent.clientX;
    sidebarWidth = clampSidebarWidth(startWidth + delta);
    if (sidebarRoot) {
      sidebarRoot.style.width = `${sidebarWidth}px`;
    }
    applyPageInset();
  };
  const onDone = () => {
    cleanupResize();
  };

  const options = { signal: controller.signal, capture: true };
  handle.addEventListener("pointermove", onMove, options);
  handle.addEventListener("pointerup", onDone, options);
  handle.addEventListener("pointercancel", onDone, options);
  handle.addEventListener("lostpointercapture", onDone, options);
  window.addEventListener("pointermove", onMove, options);
  window.addEventListener("pointerup", onDone, options);
  window.addEventListener("pointercancel", onDone, options);
  window.addEventListener("mouseup", onDone, options);
  window.addEventListener("blur", onDone, options);
}

function ensureHighlight() {
  let highlight = document.getElementById(HIGHLIGHT_ID);
  if (!highlight) {
    highlight = document.createElement("div");
    highlight.id = HIGHLIGHT_ID;
    highlight.style.position = "fixed";
    highlight.style.pointerEvents = "none";
    highlight.style.zIndex = "2147483645";
    highlight.style.border = "2px solid #2563eb";
    highlight.style.background = "rgba(37, 99, 235, 0.14)";
    highlight.style.boxShadow = "0 0 0 99999px rgba(0, 0, 0, 0.18)";
    highlight.style.borderRadius = "6px";
    document.documentElement.appendChild(highlight);
  }
  return highlight;
}

function elementLabel(element) {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const className =
    typeof element.className === "string"
      ? element.className
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .map((name) => `.${name}`)
          .join("")
      : "";
  const text = element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80);
  return `${tag}${id}${className}${text ? ` "${text}"` : ""}`;
}

function updateHighlight(element) {
  const rect = element.getBoundingClientRect();
  const highlight = ensureHighlight();
  highlight.style.left = `${Math.max(0, rect.left)}px`;
  highlight.style.top = `${Math.max(0, rect.top)}px`;
  highlight.style.width = `${Math.max(1, rect.width)}px`;
  highlight.style.height = `${Math.max(1, rect.height)}px`;
}

function cropScreenshot(dataUrl, rect) {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const scaleX = image.naturalWidth / window.innerWidth;
      const scaleY = image.naturalHeight / window.innerHeight;
      const padding = 72;
      const sx = Math.max(0, Math.floor((rect.left - padding) * scaleX));
      const sy = Math.max(0, Math.floor((rect.top - padding) * scaleY));
      const sw = Math.min(image.naturalWidth - sx, Math.ceil((rect.width + padding * 2) * scaleX));
      const sh = Math.min(
        image.naturalHeight - sy,
        Math.ceil((rect.height + padding * 2) * scaleY),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, sw);
      canvas.height = Math.max(1, sh);
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(dataUrl);
        return;
      }
      context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    });
    image.addEventListener("error", () => resolve(dataUrl));
    image.src = dataUrl;
  });
}

function cleanupAnnotation() {
  document.getElementById(HIGHLIGHT_ID)?.remove();
  if (!annotationState) {
    return;
  }
  window.removeEventListener("mousemove", annotationState.onMove, true);
  window.removeEventListener("click", annotationState.onClick, true);
  window.removeEventListener("keydown", annotationState.onKeyDown, true);
  window.removeEventListener("message", annotationState.onMessage, true);
  annotationState.input?.remove();
  annotationState = null;
}

function cancelAnnotation() {
  cleanupAnnotation();
  setSidebarStatus("");
}

function showAnnotationInput(capture) {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Annotation";
  input.style.position = "fixed";
  input.style.left = `${Math.min(window.innerWidth - 360, Math.max(16, capture.rect.left))}px`;
  input.style.top = `${Math.min(window.innerHeight - 56, Math.max(16, capture.rect.bottom + 12))}px`;
  input.style.zIndex = "2147483647";
  input.style.width = "340px";
  input.style.height = "40px";
  input.style.boxSizing = "border-box";
  input.style.border = "1px solid rgba(255,255,255,0.18)";
  input.style.borderRadius = "8px";
  input.style.background = "rgba(17,17,18,0.98)";
  input.style.color = "#fff";
  input.style.font = "14px system-ui, sans-serif";
  input.style.outline = "none";
  input.style.padding = "0 12px";
  document.documentElement.appendChild(input);
  input.focus();

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      cancelAnnotation();
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    void sendRuntimeMessage({
      type: "t3code.browserAgent.annotationSubmitted",
      workspaceLinkId: capture.workspaceLink.id,
      annotation: {
        text,
        screenshotDataUrl: capture.screenshotDataUrl,
        pageUrl: location.href,
        pageTitle: document.title,
        selectorLabel: capture.selectorLabel,
        rect: {
          x: Math.round(capture.rect.left),
          y: Math.round(capture.rect.top),
          width: Math.round(capture.rect.width),
          height: Math.round(capture.rect.height),
        },
      },
    })
      .then(() => {
        cleanupAnnotation();
        setSidebarStatus("Annotation sent");
      })
      .catch((error) => {
        setSidebarStatus(error.message);
      });
  });

  if (annotationState) {
    annotationState.input = input;
  }
}

function startAnnotationMode(link) {
  cleanupAnnotation();
  setSidebarStatus("Select an element on the page.");

  const state = {
    input: null,
    onMove: (event) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || target === sidebarRoot || sidebarRoot?.contains(target)) {
        return;
      }
      updateHighlight(target);
      state.target = target;
    },
    onClick: (event) => {
      if (!state.target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = state.target;
      const rect = target.getBoundingClientRect();
      updateHighlight(target);
      setSidebarStatus("Screenshot captured. Add a note and press Enter.");
      void sendRuntimeMessage({ type: "t3code.browserAgent.captureVisibleTab" })
        .then(async (response) => {
          if (annotationState !== state) {
            return;
          }
          const screenshotDataUrl = await cropScreenshot(response.dataUrl, rect);
          if (annotationState !== state) {
            return;
          }
          showAnnotationInput({
            workspaceLink: link,
            rect,
            selectorLabel: elementLabel(target),
            screenshotDataUrl,
          });
        })
        .catch((error) => {
          if (annotationState !== state) {
            return;
          }
          cleanupAnnotation();
          setSidebarStatus(error.message);
        });
      window.removeEventListener("mousemove", state.onMove, true);
      window.removeEventListener("click", state.onClick, true);
    },
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        cancelAnnotation();
      }
    },
    onMessage: (event) => {
      if (event.data?.type === CANCEL_ANNOTATION_MESSAGE_TYPE) {
        cancelAnnotation();
      }
    },
    target: null,
  };
  annotationState = state;
  window.focus();
  window.addEventListener("mousemove", state.onMove, true);
  window.addEventListener("click", state.onClick, true);
  window.addEventListener("keydown", state.onKeyDown, true);
  window.addEventListener("message", state.onMessage, true);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case "t3code.browserAgent.ping":
      sendResponse({ ok: true });
      return true;
    case "t3code.browserAgent.attachSidebar":
      ensureSidebar(message.workspaceLink);
      sendResponse({ ok: true });
      return true;
    case "t3code.browserAgent.activateAnnotation":
      ensureSidebar(message.workspaceLink);
      startAnnotationMode(message.workspaceLink);
      sendResponse({ ok: true });
      return true;
    default:
      return false;
  }
});
