/* global chrome */

const TRANSFER_MESSAGE_TYPE = "t3code.transferToBrowser";
const TRANSFER_START_MESSAGE_TYPE = "t3code.browserTransfer.start";
const TRANSFER_RESULT_MESSAGE_TYPE = "t3code.browserTransfer.result";
const PAGE_SOURCE = "t3code.web";
const EXTENSION_SOURCE = "t3code.chrome-extension";
const ANNOTATION_PROBE_MESSAGE_TYPE = "t3code.browserAnnotation.probe";
const ANNOTATION_READY_MESSAGE_TYPE = "t3code.browserAnnotation.ready";
const ANNOTATION_STATUS_MESSAGE_TYPE = "t3code.browserAnnotation.status";
const ANNOTATION_ACTIVATE_MESSAGE_TYPE = "t3code.browserAnnotation.activate";
const ANNOTATION_CAPTURED_MESSAGE_TYPE = "t3code.browserAnnotation.capture";
const DEV_ANNOTATION_ACTIVATE_MESSAGE_TYPE = "t3code.devPreview.activateAnnotationMode";
const DEV_ANNOTATION_CAPTURE_SCREENSHOT_MESSAGE_TYPE =
  "t3code.devPreview.captureAnnotationScreenshot";
const DEV_ANNOTATION_SUBMIT_MESSAGE_TYPE = "t3code.devPreview.submitAnnotation";
const DEV_ATTACH_SIDE_PANEL_MESSAGE_TYPE = "t3code.devPreview.attachSidePanel";
const TRANSFER_FLAG_PARAM = "t3BrowserTransfer";
const TRANSFER_ID_PARAM = "t3BrowserTransferId";
const DEV_SERVER_URL_PARAM = "t3DevServerUrl";
const GROUP_TITLE_PARAM = "t3GroupTitle";
const SIDE_PANEL_SESSION_PARAM = "t3SidePanelSessionId";
const DEFAULT_DEV_SERVER_URL = "http://localhost:3000/";
const OVERLAY_CLASS = "t3code-annotation-overlay";
const INLINE_SIDE_PANEL_HOST_ID = "t3code-inline-side-panel";
const INLINE_SIDE_PANEL_STYLE_ID = "t3code-inline-side-panel-page-crop";
const INLINE_SIDE_PANEL_ACTIVE_ATTR = "data-t3code-inline-side-panel";
const INLINE_SIDE_PANEL_WIDTH_VAR = "--t3code-inline-side-panel-width";
const INLINE_SIDE_PANEL_DEFAULT_WIDTH_PX = 440;
const INLINE_SIDE_PANEL_MIN_WIDTH_PX = 320;
const INLINE_SIDE_PANEL_VIEWPORT_MARGIN_PX = 48;
const CROP_PADDING_PX = 32;
const MAX_CROP_WIDTH_PX = 1_600;
const MAX_CROP_HEIGHT_PX = 1_100;
let inlineSidePanelWidthPx = INLINE_SIDE_PANEL_DEFAULT_WIDTH_PX;

function normalizeHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function transferStorageKey(id) {
  return `t3code:browser-transfer:${id}`;
}

function readSidePanelSessionId() {
  const value = new URL(window.location.href).searchParams.get(SIDE_PANEL_SESSION_PARAM)?.trim();
  return value && value.length > 0 ? value : null;
}

function hasHandledTransfer(id) {
  try {
    return window.sessionStorage.getItem(transferStorageKey(id)) === "1";
  } catch {
    return false;
  }
}

function markTransferHandled(id) {
  try {
    window.sessionStorage.setItem(transferStorageKey(id), "1");
  } catch {
    // Duplicate suppression is best-effort.
  }
}

function readTransferRequest() {
  const url = new URL(window.location.href);
  if (url.searchParams.get(TRANSFER_FLAG_PARAM) !== "1") {
    return null;
  }

  const id =
    url.searchParams.get(TRANSFER_ID_PARAM)?.trim() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  if (hasHandledTransfer(id)) {
    return null;
  }
  markTransferHandled(id);

  return {
    devServerUrl:
      normalizeHttpUrl(url.searchParams.get(DEV_SERVER_URL_PARAM) ?? "") ?? DEFAULT_DEV_SERVER_URL,
    groupTitle: url.searchParams.get(GROUP_TITLE_PARAM)?.trim() || undefined,
    id,
  };
}

function isPageBridgeMessage(data) {
  return (
    typeof data === "object" &&
    data !== null &&
    data.source === PAGE_SOURCE &&
    (data.type === TRANSFER_START_MESSAGE_TYPE ||
      data.type === ANNOTATION_PROBE_MESSAGE_TYPE ||
      data.type === ANNOTATION_ACTIVATE_MESSAGE_TYPE)
  );
}

function isTrustedT3CodePage() {
  try {
    const url = new URL(window.location.href);
    return (
      url.searchParams.get(TRANSFER_FLAG_PARAM) === "1" ||
      url.searchParams.has(SIDE_PANEL_SESSION_PARAM) ||
      url.pathname.startsWith("/_chat") ||
      /\bT3 Code\b/i.test(document.title)
    );
  } catch {
    return /\bT3 Code\b/i.test(document.title);
  }
}

function postToPage(message) {
  window.postMessage(
    {
      source: EXTENSION_SOURCE,
      ...message,
    },
    window.location.origin,
  );
}

function inlineSidePanelHost() {
  return document.getElementById(INLINE_SIDE_PANEL_HOST_ID);
}

function setInlineSidePanelHidden(hidden) {
  const host = inlineSidePanelHost();
  if (!host) return;
  host.style.visibility = hidden ? "hidden" : "visible";
}

function inlineSidePanelPageCropStyle() {
  const existing = document.getElementById(INLINE_SIDE_PANEL_STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }

  const style = document.createElement("style");
  style.id = INLINE_SIDE_PANEL_STYLE_ID;
  style.textContent = `
    html[${INLINE_SIDE_PANEL_ACTIVE_ATTR}="true"] {
      overflow-x: hidden !important;
    }
	    html[${INLINE_SIDE_PANEL_ACTIVE_ATTR}="true"] > body {
	      box-sizing: border-box !important;
	      max-width: calc(100vw - var(${INLINE_SIDE_PANEL_WIDTH_VAR})) !important;
	      overflow-x: hidden !important;
	      width: calc(100vw - var(${INLINE_SIDE_PANEL_WIDTH_VAR})) !important;
	    }
  `;
  document.documentElement.append(style);
  return style;
}

function applyInlineSidePanelPageCrop(width) {
  inlineSidePanelPageCropStyle();
  document.documentElement.setAttribute(INLINE_SIDE_PANEL_ACTIVE_ATTR, "true");
  document.documentElement.style.setProperty(INLINE_SIDE_PANEL_WIDTH_VAR, `${width}px`);
}

function clearInlineSidePanelPageCrop() {
  document.documentElement.removeAttribute(INLINE_SIDE_PANEL_ACTIVE_ATTR);
  document.documentElement.style.removeProperty(INLINE_SIDE_PANEL_WIDTH_VAR);
  document.getElementById(INLINE_SIDE_PANEL_STYLE_ID)?.remove();
}

function inlineSidePanelReservedWidth() {
  return inlineSidePanelHost() ? inlineSidePanelWidthPx : 0;
}

function effectiveViewportRight() {
  return Math.max(1, window.innerWidth - inlineSidePanelReservedWidth());
}

function maxInlineSidePanelWidthPx() {
  return Math.max(220, window.innerWidth - INLINE_SIDE_PANEL_VIEWPORT_MARGIN_PX);
}

function normalizedInlineSidePanelWidth(value) {
  const maxWidth = maxInlineSidePanelWidthPx();
  const minWidth = Math.min(INLINE_SIDE_PANEL_MIN_WIDTH_PX, maxWidth);
  return clamp(Math.round(value), minWidth, maxWidth);
}

function setInlineSidePanelWidth(host, width) {
  inlineSidePanelWidthPx = normalizedInlineSidePanelWidth(width);
  host.style.width = `${inlineSidePanelWidthPx}px`;
  applyInlineSidePanelPageCrop(inlineSidePanelWidthPx);
}

function attachInlineSidePanel(message) {
  if (window.top !== window) {
    return;
  }

  const sidePanelSessionId =
    typeof message.sidePanelSessionId === "string" && message.sidePanelSessionId.trim()
      ? message.sidePanelSessionId.trim()
      : null;
  if (!sidePanelSessionId) {
    throw new Error("Missing T3 Code side panel session.");
  }

  const panelUrl = chrome.runtime.getURL(
    `sidepanel.html?sessionId=${encodeURIComponent(sidePanelSessionId)}&mode=inline`,
  );
  const existingHost = inlineSidePanelHost();
  if (existingHost?.shadowRoot) {
    const existingFrame = existingHost.shadowRoot.querySelector("iframe");
    if (existingFrame instanceof HTMLIFrameElement && existingFrame.src !== panelUrl) {
      existingFrame.src = panelUrl;
    }
    existingHost.style.visibility = "visible";
    setInlineSidePanelWidth(existingHost, inlineSidePanelWidthPx);
    return;
  }
  existingHost?.remove();

  const host = document.createElement("div");
  host.id = INLINE_SIDE_PANEL_HOST_ID;
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.right = "0";
  host.style.bottom = "0";
  host.style.zIndex = "2147483000";
  host.style.pointerEvents = "auto";
  setInlineSidePanelWidth(host, inlineSidePanelWidthPx);

  const shadowRoot = host.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        background: #0a0a0a;
        border-left: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: -18px 0 48px rgba(0, 0, 0, 0.34);
        display: grid;
        grid-template-rows: 30px minmax(0, 1fr);
        position: relative;
        color: #f4f4f5;
        font: 12px/1 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .resize-handle {
        bottom: 0;
        cursor: ew-resize;
        left: -5px;
        position: absolute;
        top: 0;
        touch-action: none;
        width: 10px;
        z-index: 2;
      }
      .resize-handle::after {
        background: rgba(255, 255, 255, 0.16);
        bottom: 0;
        content: "";
        left: 4px;
        opacity: 0;
        position: absolute;
        top: 0;
        transition: opacity 120ms ease;
        width: 2px;
      }
      .resize-handle:hover::after,
      .resize-handle[data-active="true"]::after {
        opacity: 1;
      }
      .bar {
        align-items: center;
        background: #111113;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        box-sizing: border-box;
        display: flex;
        justify-content: flex-end;
        min-width: 0;
        padding: 0 6px;
      }
      button {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 6px;
        color: #a1a1aa;
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        height: 22px;
        justify-content: center;
        padding: 0;
        width: 22px;
      }
      button:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #f4f4f5;
      }
      iframe {
        border: 0;
        display: block;
        height: 100%;
        min-width: 0;
        width: 100%;
      }
    </style>
    <div class="panel">
      <div class="resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize T3 Code side panel"></div>
      <div class="bar"><button type="button" aria-label="Close T3 Code side panel">x</button></div>
      <iframe title="T3 Code"></iframe>
    </div>
  `;
  const frame = shadowRoot.querySelector("iframe");
  const closeButton = shadowRoot.querySelector("button");
  const resizeHandle = shadowRoot.querySelector(".resize-handle");
  if (frame instanceof HTMLIFrameElement) {
    frame.src = panelUrl;
  }
  closeButton?.addEventListener("click", () => {
    host.remove();
    clearInlineSidePanelPageCrop();
  });
  if (resizeHandle instanceof HTMLElement) {
    let resizeState = null;
    const stopResize = () => {
      if (!resizeState) return;
      resizeHandle.dataset.active = "false";
      document.removeEventListener("pointermove", onResizeMove, true);
      document.removeEventListener("pointerup", stopResize, true);
      document.removeEventListener("pointercancel", stopResize, true);
      document.body.style.cursor = resizeState.bodyCursor;
      document.body.style.userSelect = resizeState.bodyUserSelect;
      if (frame instanceof HTMLIFrameElement) {
        frame.style.pointerEvents = resizeState.framePointerEvents;
      }
      resizeState = null;
    };
    const onResizeMove = (event) => {
      if (!resizeState) return;
      event.preventDefault();
      const deltaX = resizeState.startClientX - event.clientX;
      setInlineSidePanelWidth(host, resizeState.startWidth + deltaX);
    };
    resizeHandle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      resizeState = {
        startClientX: event.clientX,
        startWidth: host.getBoundingClientRect().width,
        bodyCursor: document.body.style.cursor,
        bodyUserSelect: document.body.style.userSelect,
        framePointerEvents: frame instanceof HTMLIFrameElement ? frame.style.pointerEvents : "",
      };
      resizeHandle.dataset.active = "true";
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      if (frame instanceof HTMLIFrameElement) {
        frame.style.pointerEvents = "none";
      }
      document.addEventListener("pointermove", onResizeMove, true);
      document.addEventListener("pointerup", stopResize, true);
      document.addEventListener("pointercancel", stopResize, true);
    });
    window.addEventListener("resize", () => setInlineSidePanelWidth(host, inlineSidePanelWidthPx));
  }
  document.documentElement.append(host);
}

async function sendRuntimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Extension request failed.");
  }
  return response.result;
}

async function postAnnotationStatus(type) {
  try {
    const sidePanelSessionId = readSidePanelSessionId();
    const status = await sendRuntimeMessage({
      type: ANNOTATION_STATUS_MESSAGE_TYPE,
      ...(sidePanelSessionId ? { sidePanelSessionId } : {}),
    });
    postToPage({
      type,
      linked: Boolean(status?.linked),
      active: Boolean(status?.active),
      ...(status?.browserContext ? { browserContext: status.browserContext } : {}),
    });
  } catch {
    postToPage({ type, linked: false, active: false });
  }
}

async function activateAnnotationModeFromPage() {
  try {
    const sidePanelSessionId = readSidePanelSessionId();
    const status = await sendRuntimeMessage({
      type: ANNOTATION_ACTIVATE_MESSAGE_TYPE,
      ...(sidePanelSessionId ? { sidePanelSessionId } : {}),
    });
    postToPage({
      type: ANNOTATION_STATUS_MESSAGE_TYPE,
      linked: Boolean(status?.linked),
      active: Boolean(status?.active),
      ...(status?.browserContext ? { browserContext: status.browserContext } : {}),
    });
  } catch (error) {
    postToPage({
      type: ANNOTATION_STATUS_MESSAGE_TYPE,
      linked: false,
      active: false,
      error: error instanceof Error ? error.message : "Annotation mode failed.",
    });
  }
}

async function startTransferFromPage(message) {
  const id =
    typeof message.id === "string" && message.id.trim()
      ? message.id.trim()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const devServerUrl = normalizeHttpUrl(message.devServerUrl ?? "") ?? DEFAULT_DEV_SERVER_URL;
  const groupTitle =
    typeof message.groupTitle === "string" && message.groupTitle.trim()
      ? message.groupTitle.trim()
      : undefined;
  if (hasHandledTransfer(id)) {
    postToPage({
      type: TRANSFER_RESULT_MESSAGE_TYPE,
      id,
      ok: true,
      duplicate: true,
    });
    return;
  }

  try {
    const result = await sendRuntimeMessage({
      type: TRANSFER_MESSAGE_TYPE,
      devServerUrl,
      groupTitle,
      id,
    });
    markTransferHandled(id);
    postToPage({
      type: TRANSFER_RESULT_MESSAGE_TYPE,
      id,
      ok: true,
      devTabId: result?.devTabId,
      groupId: result?.groupId,
    });
  } catch (error) {
    postToPage({
      type: TRANSFER_RESULT_MESSAGE_TYPE,
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Transfer failed.",
    });
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) {
    return;
  }
  if (!isPageBridgeMessage(event.data)) {
    return;
  }
  if (!isTrustedT3CodePage()) {
    return;
  }

  if (event.data.type === ANNOTATION_PROBE_MESSAGE_TYPE) {
    void postAnnotationStatus(ANNOTATION_READY_MESSAGE_TYPE);
    return;
  }

  if (event.data.type === TRANSFER_START_MESSAGE_TYPE) {
    void startTransferFromPage(event.data);
    return;
  }

  void activateAnnotationModeFromPage();
});

const transferRequest = readTransferRequest();
if (transferRequest) {
  void chrome.runtime
    .sendMessage({
      type: TRANSFER_MESSAGE_TYPE,
      ...transferRequest,
    })
    .catch(() => {});
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function waitForImageLoad(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Screenshot image could not be decoded.")),
      { once: true },
    );
    image.src = dataUrl;
  });
}

function elementText(element) {
  const label =
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("alt") ||
    ("innerText" in element ? element.innerText : element.textContent) ||
    "";
  return label.replace(/\s+/g, " ").trim();
}

function describeElement(element) {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const text = elementText(element);
  if (text) {
    return `${tag}${id} ${text.slice(0, 96)}`;
  }
  return `${tag}${id}`;
}

function isOverlayElement(target, state) {
  return target instanceof Node && state.host !== null && state.host.contains(target);
}

function resolveElementAtPoint(x, y, state) {
  const element = document.elementFromPoint(x, y);
  if (!element || isOverlayElement(element, state)) {
    return null;
  }
  if (element === document.documentElement || element === document.body) {
    return document.body;
  }
  return element.closest("button, a, input, textarea, select, [role], [data-testid]") || element;
}

function visibleRectForElement(element) {
  const rect = element.getBoundingClientRect();
  const viewportRight = effectiveViewportRight();
  const left = clamp(rect.left, 0, viewportRight);
  const top = clamp(rect.top, 0, window.innerHeight);
  const right = clamp(rect.right, 0, viewportRight);
  const bottom = clamp(rect.bottom, 0, window.innerHeight);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function cropRectForElement(element, pointerX, pointerY) {
  const rect = visibleRectForElement(element);
  const viewportRight = effectiveViewportRight();
  let left = clamp(rect.x - CROP_PADDING_PX, 0, viewportRight);
  let top = clamp(rect.y - CROP_PADDING_PX, 0, window.innerHeight);
  let right = clamp(rect.x + rect.width + CROP_PADDING_PX, 0, viewportRight);
  let bottom = clamp(rect.y + rect.height + CROP_PADDING_PX, 0, window.innerHeight);

  if (right - left > MAX_CROP_WIDTH_PX) {
    const center = clamp(pointerX, left + MAX_CROP_WIDTH_PX / 2, right - MAX_CROP_WIDTH_PX / 2);
    left = clamp(center - MAX_CROP_WIDTH_PX / 2, 0, viewportRight - MAX_CROP_WIDTH_PX);
    right = left + MAX_CROP_WIDTH_PX;
  }
  if (bottom - top > MAX_CROP_HEIGHT_PX) {
    const center = clamp(pointerY, top + MAX_CROP_HEIGHT_PX / 2, bottom - MAX_CROP_HEIGHT_PX / 2);
    top = clamp(center - MAX_CROP_HEIGHT_PX / 2, 0, window.innerHeight - MAX_CROP_HEIGHT_PX);
    bottom = top + MAX_CROP_HEIGHT_PX;
  }

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function updateHighlight(state, element) {
  if (!state.highlight || !element) {
    return;
  }
  const rect = visibleRectForElement(element);
  state.highlight.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  state.highlight.style.width = `${rect.width}px`;
  state.highlight.style.height = `${rect.height}px`;
  state.highlight.style.opacity = "1";
}

async function cropScreenshot(dataUrl, cropRect) {
  const image = await waitForImageLoad(dataUrl);
  const scaleX = image.naturalWidth / window.innerWidth;
  const scaleY = image.naturalHeight / window.innerHeight;
  const sourceX = Math.round(cropRect.x * scaleX);
  const sourceY = Math.round(cropRect.y * scaleY);
  const sourceWidth = Math.max(1, Math.round(cropRect.width * scaleX));
  const sourceHeight = Math.max(1, Math.round(cropRect.height * scaleY));

  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Screenshot crop canvas could not be created.");
  }
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  return canvas.toDataURL("image/png");
}

function showNotice(state, text) {
  if (!state.notice) {
    return;
  }
  state.notice.textContent = text;
  state.notice.style.opacity = "1";
  window.setTimeout(() => {
    if (state.notice) {
      state.notice.style.opacity = "0";
    }
  }, 2_400);
}

function removeAnnotationMode(state) {
  window.removeEventListener("pointermove", state.onPointerMove, true);
  window.removeEventListener("click", state.onClick, true);
  window.removeEventListener("keydown", state.onKeyDown, true);
  state.highlight?.remove();
  state.notice?.remove();
  state.host?.remove();
  activeAnnotationState = null;
}

function placeAnnotationForm(host, cropRect) {
  const width = 320;
  const viewportRight = effectiveViewportRight();
  const left = clamp(cropRect.x, 12, Math.max(12, viewportRight - width - 12));
  const below = cropRect.y + cropRect.height + 10;
  const top =
    below + 118 <= window.innerHeight
      ? below
      : clamp(cropRect.y - 128, 12, Math.max(12, window.innerHeight - 128));
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
  host.style.width = `${width}px`;
}

function showAnnotationForm(state, element, cropRect, screenshotDataUrl) {
  if (!state.host || !state.shadowRoot) {
    return;
  }
  state.inputOpen = true;
  placeAnnotationForm(state.host, cropRect);
  const selectorLabel = describeElement(element);
  state.shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .box {
        box-sizing: border-box;
        width: 320px;
        border: 1px solid rgba(15, 23, 42, 0.16);
        border-radius: 8px;
        background: white;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.22);
        color: #0f172a;
        font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 8px;
      }
      textarea {
        box-sizing: border-box;
        display: block;
        width: 100%;
        min-height: 72px;
        resize: vertical;
        border: 1px solid rgba(15, 23, 42, 0.16);
        border-radius: 6px;
        padding: 8px;
        color: #0f172a;
        background: white;
        outline: none;
        font: inherit;
      }
      textarea:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.16); }
      .hint {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-top: 6px;
        color: #64748b;
        font-size: 11px;
      }
      .target {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    </style>
    <div class="box">
      <textarea aria-label="Annotation" placeholder="Add annotation..."></textarea>
      <div class="hint">
        <span class="target"></span>
        <span>Enter to send</span>
      </div>
    </div>
  `;
  const textarea = state.shadowRoot.querySelector("textarea");
  const target = state.shadowRoot.querySelector(".target");
  if (target) {
    target.textContent = selectorLabel;
  }
  if (!textarea) {
    return;
  }
  textarea.focus();
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      removeAnnotationMode(state);
      void chrome.runtime
        .sendMessage({
          type: ANNOTATION_STATUS_MESSAGE_TYPE,
          ...(typeof state.sidePanelSessionId === "string"
            ? { sidePanelSessionId: state.sidePanelSessionId }
            : {}),
        })
        .catch(() => {});
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    const text = textarea.value.trim();
    if (!text) {
      return;
    }

    textarea.disabled = true;
    void sendRuntimeMessage({
      type: DEV_ANNOTATION_SUBMIT_MESSAGE_TYPE,
      ...(typeof state.sourceTabId === "number" ? { sourceTabId: state.sourceTabId } : {}),
      ...(typeof state.sidePanelSessionId === "string"
        ? { sidePanelSessionId: state.sidePanelSessionId }
        : {}),
      text,
      screenshotDataUrl,
      pageUrl: window.location.href,
      pageTitle: document.title,
      selectorLabel,
    })
      .then(() => {
        removeAnnotationMode(state);
      })
      .catch((error) => {
        textarea.disabled = false;
        showNotice(
          state,
          error instanceof Error ? error.message : "Could not send browser annotation.",
        );
      });
  });
}

let activeAnnotationState = null;

function startAnnotationMode(message) {
  if (activeAnnotationState) {
    removeAnnotationMode(activeAnnotationState);
  }

  const host = document.createElement("div");
  host.className = OVERLAY_CLASS;
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  host.style.left = "12px";
  host.style.top = "12px";
  host.style.width = "320px";
  host.style.pointerEvents = "auto";
  const shadowRoot = host.attachShadow({ mode: "closed" });

  const highlight = document.createElement("div");
  highlight.className = OVERLAY_CLASS;
  highlight.style.position = "fixed";
  highlight.style.zIndex = "2147483646";
  highlight.style.left = "0";
  highlight.style.top = "0";
  highlight.style.pointerEvents = "none";
  highlight.style.border = "2px solid #2563eb";
  highlight.style.borderRadius = "6px";
  highlight.style.boxShadow =
    "0 0 0 9999px rgba(37, 99, 235, 0.08), 0 0 0 4px rgba(37, 99, 235, 0.18)";
  highlight.style.opacity = "0";
  highlight.style.transition = "transform 80ms ease, width 80ms ease, height 80ms ease";

  const notice = document.createElement("div");
  notice.className = OVERLAY_CLASS;
  notice.textContent = "Click an element to annotate";
  notice.style.position = "fixed";
  notice.style.right = "16px";
  notice.style.bottom = "16px";
  notice.style.zIndex = "2147483647";
  notice.style.pointerEvents = "none";
  notice.style.borderRadius = "999px";
  notice.style.background = "#16a34a";
  notice.style.color = "white";
  notice.style.padding = "8px 12px";
  notice.style.font =
    "600 13px/1 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  notice.style.boxShadow = "0 10px 30px rgba(15, 23, 42, 0.24)";
  notice.style.transition = "opacity 150ms ease";

  const state = {
    host,
    shadowRoot,
    highlight,
    notice,
    sourceTabId: typeof message.sourceTabId === "number" ? message.sourceTabId : null,
    sidePanelSessionId:
      typeof message.sidePanelSessionId === "string" && message.sidePanelSessionId.trim()
        ? message.sidePanelSessionId.trim()
        : null,
    currentElement: null,
    inputOpen: false,
    capturing: false,
    onPointerMove: null,
    onClick: null,
    onKeyDown: null,
  };

  state.onPointerMove = (event) => {
    if (state.inputOpen || state.capturing) {
      return;
    }
    const element = resolveElementAtPoint(event.clientX, event.clientY, state);
    if (!element) {
      return;
    }
    state.currentElement = element;
    updateHighlight(state, element);
  };

  state.onClick = (event) => {
    if (state.inputOpen || state.capturing || isOverlayElement(event.target, state)) {
      return;
    }
    const element =
      state.currentElement || resolveElementAtPoint(event.clientX, event.clientY, state);
    if (!element) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    state.capturing = true;
    state.currentElement = element;
    updateHighlight(state, element);
    showNotice(state, "Capturing screenshot...");
    const cropRect = cropRectForElement(element, event.clientX, event.clientY);

    setInlineSidePanelHidden(true);
    void sendRuntimeMessage({
      type: DEV_ANNOTATION_CAPTURE_SCREENSHOT_MESSAGE_TYPE,
      ...(typeof state.sourceTabId === "number" ? { sourceTabId: state.sourceTabId } : {}),
      ...(typeof state.sidePanelSessionId === "string"
        ? { sidePanelSessionId: state.sidePanelSessionId }
        : {}),
    })
      .then((result) => cropScreenshot(result.screenshotDataUrl, cropRect))
      .then((croppedDataUrl) => {
        setInlineSidePanelHidden(false);
        state.capturing = false;
        showAnnotationForm(state, element, cropRect, croppedDataUrl);
      })
      .catch((error) => {
        setInlineSidePanelHidden(false);
        state.capturing = false;
        showNotice(state, error instanceof Error ? error.message : "Could not capture screenshot.");
      });
  };

  state.onKeyDown = (event) => {
    if (event.key !== "Escape" || state.inputOpen) {
      return;
    }
    event.preventDefault();
    removeAnnotationMode(state);
  };

  document.documentElement.append(highlight, notice, host);
  window.addEventListener("pointermove", state.onPointerMove, true);
  window.addEventListener("click", state.onClick, true);
  window.addEventListener("keydown", state.onKeyDown, true);
  activeAnnotationState = state;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    typeof message !== "object" ||
    message === null ||
    (message.type !== DEV_ANNOTATION_ACTIVATE_MESSAGE_TYPE &&
      message.type !== DEV_ATTACH_SIDE_PANEL_MESSAGE_TYPE &&
      message.type !== ANNOTATION_CAPTURED_MESSAGE_TYPE)
  ) {
    return false;
  }

  if (message.type === DEV_ATTACH_SIDE_PANEL_MESSAGE_TYPE) {
    try {
      attachInlineSidePanel(message);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Could not attach T3 Code side panel.",
      });
    }
    return false;
  }

  if (message.type === DEV_ANNOTATION_ACTIVATE_MESSAGE_TYPE) {
    startAnnotationMode(message);
    sendResponse({ ok: true });
    return false;
  }

  postToPage({
    type: ANNOTATION_CAPTURED_MESSAGE_TYPE,
    text: message.text,
    screenshotDataUrl: message.screenshotDataUrl,
    pageUrl: message.pageUrl,
    pageTitle: message.pageTitle,
    ...(typeof message.selectorLabel === "string" ? { selectorLabel: message.selectorLabel } : {}),
  });
  postToPage({
    type: ANNOTATION_STATUS_MESSAGE_TYPE,
    linked: true,
    active: false,
  });
  sendResponse({ ok: true });
  return false;
});
