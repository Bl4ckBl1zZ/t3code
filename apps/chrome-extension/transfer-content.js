const HIGHLIGHT_ID = "t3code-browser-agent-highlight";
const ANNOTATION_STATUS_ID = "t3code-browser-agent-annotation-status";
const ANNOTATION_INPUT_CONTAINER_ID = "t3code-browser-agent-annotation-input-container";
const ANNOTATION_INPUT_ID = "t3code-browser-agent-annotation-input";
const ANNOTATION_MIC_BUTTON_ID = "t3code-browser-agent-annotation-mic";
const OPEN_SIDE_PANEL_PROMPT_ID = "t3code-browser-agent-open-side-panel-prompt";
const CANCEL_ANNOTATION_MESSAGE_TYPE = "t3code.browserAgent.cancelAnnotation";
const MAX_AUDIO_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
const MAX_AUDIO_TRANSCRIPTION_SIZE_LABEL = "24MB";
const PREFERRED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

const MIC_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><path d="M12 19v3"></path></svg>';
const STOP_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
const LOADING_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"></path></svg>';

let annotationState = null;

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

function getPreferredAudioRecordingOptions() {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  const mimeType = PREFERRED_AUDIO_MIME_TYPES.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );
  return mimeType ? { mimeType } : undefined;
}

function audioMimeTypeToTranscriptionFormat(mimeType) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("aac")) return "aac";
  if (normalized.includes("aiff")) return "aiff";
  if (normalized.includes("webm")) return "webm";
  return "webm";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const separatorIndex = result.indexOf(",");
        resolve(separatorIndex >= 0 ? result.slice(separatorIndex + 1) : result);
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Failed to read audio recording.")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}

function appendTranscriptionToAnnotation(existingText, transcription) {
  const addition = transcription.trim();
  if (!addition) {
    return existingText;
  }

  const existingWithoutHorizontalTrailingSpace = existingText.replace(/[ \t]+$/u, "");
  if (!existingWithoutHorizontalTrailingSpace.trim()) {
    return addition;
  }
  if (existingWithoutHorizontalTrailingSpace.endsWith("\n")) {
    return `${existingWithoutHorizontalTrailingSpace}${addition}`;
  }
  if (/^[,.;:!?)]/u.test(addition)) {
    return `${existingWithoutHorizontalTrailingSpace}${addition}`;
  }
  if (/[([{]$/u.test(existingWithoutHorizontalTrailingSpace)) {
    return `${existingWithoutHorizontalTrailingSpace}${addition}`;
  }
  return `${existingWithoutHorizontalTrailingSpace} ${addition}`;
}

function createAnnotationAudioRecorder(stream) {
  const recorder = new MediaRecorder(stream, getPreferredAudioRecordingOptions());
  const chunks = [];
  let stopPromise = null;

  const handleDataAvailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.addEventListener("dataavailable", handleDataAvailable);

  const cleanup = () => {
    recorder.removeEventListener("dataavailable", handleDataAvailable);
  };

  return {
    start: () => {
      recorder.start();
    },
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }

      stopPromise = new Promise((resolve, reject) => {
        const handleStop = () => {
          cleanup();
          const mimeType = recorder.mimeType || getPreferredAudioRecordingOptions()?.mimeType || "";
          resolve(new Blob(chunks, { type: mimeType }));
        };
        const handleError = () => {
          cleanup();
          reject(new Error("The browser could not continue recording from the microphone."));
        };

        recorder.addEventListener("stop", handleStop, { once: true });
        recorder.addEventListener("error", handleError, { once: true });
        recorder.stop();
      });

      return stopPromise;
    },
    cancel: () => {
      cleanup();
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    },
  };
}

function setAnnotationVoiceButtonState(button, state) {
  button.dataset.recordingState = state;
  button.disabled = state === "transcribing";
  button.title =
    state === "recording"
      ? "Stop recording"
      : state === "transcribing"
        ? "Transcribing"
        : "Record annotation";
  button.setAttribute("aria-label", button.title);
  button.style.background = state === "recording" ? "#dc2626" : "rgba(255,255,255,0.08)";
  button.style.color = state === "recording" ? "#fff" : "#d4d4d8";
  button.innerHTML =
    state === "recording" ? STOP_ICON : state === "transcribing" ? LOADING_ICON : MIC_ICON;
}

function stopAnnotationVoiceCapture(state) {
  state.voiceRecorder?.cancel();
  state.voiceRecorder = null;
  state.voiceStream?.getTracks().forEach((track) => track.stop());
  state.voiceStream = null;
  state.voiceRecordingState = "idle";
}

async function finishAnnotationVoiceRecording(state, input, button, blob) {
  state.voiceRecorder = null;
  state.voiceStream?.getTracks().forEach((track) => track.stop());
  state.voiceStream = null;

  if (blob.size === 0) {
    setAnnotationStatus("No audio captured. Try recording again.");
    setAnnotationVoiceButtonState(button, "idle");
    return;
  }
  if (blob.size > MAX_AUDIO_TRANSCRIPTION_BYTES) {
    setAnnotationStatus(`Recordings must be ${MAX_AUDIO_TRANSCRIPTION_SIZE_LABEL} or smaller.`);
    setAnnotationVoiceButtonState(button, "idle");
    return;
  }

  const response = await sendRuntimeMessage({
    type: "t3code.browserAgent.transcribeAudio",
    audioBase64: await blobToBase64(blob),
    existingText: input.value,
    format: audioMimeTypeToTranscriptionFormat(blob.type),
    mimeType: blob.type,
  });
  if (annotationState !== state) {
    return;
  }

  const text = typeof response.text === "string" ? response.text : "";
  input.value = appendTranscriptionToAnnotation(input.value, text);
  input.focus();
  setAnnotationStatus(
    text.trim() ? "Transcription added. Press Enter to send." : "No speech detected.",
  );
  setAnnotationVoiceButtonState(button, "idle");
}

async function stopAnnotationVoiceRecording(state, input, button) {
  const recorder = state.voiceRecorder;
  if (!recorder || state.voiceRecordingState !== "recording") {
    return;
  }

  state.voiceRecordingState = "transcribing";
  setAnnotationVoiceButtonState(button, "transcribing");
  setAnnotationStatus("Transcribing annotation audio...");
  try {
    const blob = await recorder.stop();
    await finishAnnotationVoiceRecording(state, input, button, blob);
  } catch (error) {
    if (annotationState === state) {
      state.voiceRecorder = null;
      state.voiceStream?.getTracks().forEach((track) => track.stop());
      state.voiceStream = null;
      setAnnotationStatus(error instanceof Error ? error.message : "Audio transcription failed.");
      setAnnotationVoiceButtonState(button, "idle");
    }
  } finally {
    if (annotationState === state) {
      state.voiceRecordingState = "idle";
    }
  }
}

async function startAnnotationVoiceRecording(state, input, button) {
  if (state.voiceRecordingState !== "idle") {
    return;
  }
  if (
    typeof navigator.mediaDevices?.getUserMedia !== "function" ||
    typeof MediaRecorder === "undefined"
  ) {
    setAnnotationStatus("This browser does not expose a compatible microphone recorder.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    if (annotationState !== state) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const recorder = createAnnotationAudioRecorder(stream);
    state.voiceStream = stream;
    state.voiceRecorder = recorder;
    state.voiceRecordingState = "recording";
    recorder.start();
    setAnnotationVoiceButtonState(button, "recording");
    setAnnotationStatus("Recording annotation audio. Click the microphone to stop.");
    input.focus();
  } catch (error) {
    if (annotationState === state) {
      setAnnotationStatus(error instanceof Error ? error.message : "Microphone access was denied.");
      setAnnotationVoiceButtonState(button, "idle");
    }
  }
}

function removeOpenSidePanelPrompt() {
  document.getElementById(OPEN_SIDE_PANEL_PROMPT_ID)?.remove();
}

function showOpenSidePanelPrompt(reason) {
  removeOpenSidePanelPrompt();

  const prompt = document.createElement("aside");
  prompt.id = OPEN_SIDE_PANEL_PROMPT_ID;
  prompt.style.position = "fixed";
  prompt.style.right = "16px";
  prompt.style.top = "16px";
  prompt.style.zIndex = "2147483647";
  prompt.style.boxSizing = "border-box";
  prompt.style.width = "min(360px, calc(100vw - 32px))";
  prompt.style.border = "1px solid rgba(255,255,255,0.14)";
  prompt.style.borderRadius = "8px";
  prompt.style.background = "rgba(17,17,18,0.97)";
  prompt.style.boxShadow = "0 18px 44px rgba(0,0,0,0.32)";
  prompt.style.color = "#f5f5f5";
  prompt.style.font = "13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  prompt.style.padding = "12px";
  prompt.style.pointerEvents = "auto";

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "8px";

  const text = document.createElement("div");
  text.textContent = reason
    ? "Chrome needs one click to open the T3 Code side panel."
    : "Open the T3 Code side panel.";
  text.style.flex = "1";
  text.style.color = "#d4d4d8";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "Open";
  openButton.style.border = "0";
  openButton.style.borderRadius = "7px";
  openButton.style.background = "#2563eb";
  openButton.style.color = "#fff";
  openButton.style.cursor = "pointer";
  openButton.style.font = "700 13px system-ui, sans-serif";
  openButton.style.minHeight = "32px";
  openButton.style.padding = "0 12px";

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.textContent = "x";
  dismissButton.title = "Dismiss";
  dismissButton.style.border = "0";
  dismissButton.style.borderRadius = "7px";
  dismissButton.style.background = "rgba(255,255,255,0.08)";
  dismissButton.style.color = "#d4d4d8";
  dismissButton.style.cursor = "pointer";
  dismissButton.style.font = "700 13px system-ui, sans-serif";
  dismissButton.style.width = "32px";
  dismissButton.style.height = "32px";

  let openRequested = false;
  const requestOpenSidePanel = () => {
    if (openRequested) {
      return;
    }
    openRequested = true;
    openButton.disabled = true;
    openButton.textContent = "Opening";
    text.textContent = "Opening T3 Code side panel...";
    void sendRuntimeMessage({ type: "t3code.browserAgent.openSidePanelFromPage" })
      .then(removeOpenSidePanelPrompt)
      .catch((error) => {
        openRequested = false;
        openButton.disabled = false;
        openButton.textContent = "Open";
        text.textContent = error instanceof Error ? error.message : "Could not open side panel.";
      });
  };

  openButton.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    requestOpenSidePanel();
  });
  openButton.addEventListener("click", (event) => {
    event.preventDefault();
    requestOpenSidePanel();
  });
  dismissButton.addEventListener("click", removeOpenSidePanelPrompt);

  row.append(text, openButton, dismissButton);
  prompt.append(row);
  document.documentElement.appendChild(prompt);
}

function clearAnnotationStatus() {
  document.getElementById(ANNOTATION_STATUS_ID)?.remove();
}

function setAnnotationStatus(statusText) {
  if (!statusText) {
    clearAnnotationStatus();
    return;
  }
  let status = document.getElementById(ANNOTATION_STATUS_ID);
  if (!status) {
    status = document.createElement("div");
    status.id = ANNOTATION_STATUS_ID;
    status.style.position = "fixed";
    status.style.right = "16px";
    status.style.bottom = "16px";
    status.style.zIndex = "2147483647";
    status.style.maxWidth = "360px";
    status.style.boxSizing = "border-box";
    status.style.border = "1px solid rgba(255,255,255,0.14)";
    status.style.borderRadius = "8px";
    status.style.background = "rgba(17,17,18,0.96)";
    status.style.boxShadow = "0 18px 44px rgba(0,0,0,0.32)";
    status.style.color = "#f5f5f5";
    status.style.font = "13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    status.style.padding = "10px 12px";
    status.style.pointerEvents = "none";
    document.documentElement.appendChild(status);
  }
  status.textContent = statusText;
}

function showTransientAnnotationStatus(statusText) {
  setAnnotationStatus(statusText);
  setTimeout(() => {
    if (document.getElementById(ANNOTATION_STATUS_ID)?.textContent === statusText) {
      clearAnnotationStatus();
    }
  }, 2_000);
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

function cleanupAnnotation(options = {}) {
  document.getElementById(HIGHLIGHT_ID)?.remove();
  if (!options.preserveStatus) {
    clearAnnotationStatus();
  }
  if (!annotationState) {
    return;
  }
  stopAnnotationVoiceCapture(annotationState);
  window.removeEventListener("mousemove", annotationState.onMove, true);
  window.removeEventListener("click", annotationState.onClick, true);
  window.removeEventListener("keydown", annotationState.onKeyDown, true);
  window.removeEventListener("message", annotationState.onMessage, true);
  annotationState.input?.remove();
  annotationState = null;
}

function cancelAnnotation() {
  cleanupAnnotation();
}

function showAnnotationInput(capture) {
  const container = document.createElement("div");
  container.id = ANNOTATION_INPUT_CONTAINER_ID;
  container.style.position = "fixed";
  container.style.left = `${Math.min(window.innerWidth - 360, Math.max(16, capture.rect.left))}px`;
  container.style.top = `${Math.min(window.innerHeight - 56, Math.max(16, capture.rect.bottom + 12))}px`;
  container.style.zIndex = "2147483647";
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.width = "340px";
  container.style.height = "40px";
  container.style.boxSizing = "border-box";
  container.style.border = "1px solid rgba(255,255,255,0.18)";
  container.style.borderRadius = "8px";
  container.style.background = "rgba(17,17,18,0.98)";
  container.style.boxShadow = "0 18px 44px rgba(0,0,0,0.32)";
  container.style.overflow = "hidden";

  const input = document.createElement("input");
  input.id = ANNOTATION_INPUT_ID;
  input.type = "text";
  input.placeholder = "Annotation";
  input.style.flex = "1";
  input.style.minWidth = "0";
  input.style.height = "100%";
  input.style.boxSizing = "border-box";
  input.style.border = "0";
  input.style.background = "transparent";
  input.style.color = "#fff";
  input.style.font = "14px system-ui, sans-serif";
  input.style.outline = "none";
  input.style.padding = "0 10px 0 12px";

  const micButton = document.createElement("button");
  micButton.id = ANNOTATION_MIC_BUTTON_ID;
  micButton.type = "button";
  micButton.style.width = "40px";
  micButton.style.height = "100%";
  micButton.style.border = "0";
  micButton.style.borderLeft = "1px solid rgba(255,255,255,0.12)";
  micButton.style.borderRadius = "0";
  micButton.style.cursor = "pointer";
  micButton.style.display = "inline-flex";
  micButton.style.alignItems = "center";
  micButton.style.justifyContent = "center";
  micButton.style.padding = "0";
  micButton.style.font = "700 13px system-ui, sans-serif";
  setAnnotationVoiceButtonState(micButton, "idle");

  micButton.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
  });
  micButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = annotationState;
    if (!state) {
      return;
    }
    if (state.voiceRecordingState === "recording") {
      void stopAnnotationVoiceRecording(state, input, micButton);
      return;
    }
    void startAnnotationVoiceRecording(state, input, micButton);
  });

  container.append(input, micButton);
  document.documentElement.appendChild(container);
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
    if (annotationState?.voiceRecordingState !== "idle") {
      return;
    }
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
        cleanupAnnotation({ preserveStatus: true });
        showTransientAnnotationStatus("Annotation sent");
      })
      .catch((error) => {
        cleanupAnnotation({ preserveStatus: true });
        setAnnotationStatus(error.message);
      });
  });

  if (annotationState) {
    annotationState.input = container;
  }
}

function isBrowserAgentElement(element) {
  return (
    element.id === HIGHLIGHT_ID ||
    element.id === ANNOTATION_STATUS_ID ||
    element.id === ANNOTATION_INPUT_CONTAINER_ID ||
    element.id === ANNOTATION_INPUT_ID ||
    element.id === ANNOTATION_MIC_BUTTON_ID ||
    element.id === OPEN_SIDE_PANEL_PROMPT_ID ||
    Boolean(element.closest?.(`#${ANNOTATION_INPUT_CONTAINER_ID}`)) ||
    Boolean(element.closest?.(`#${OPEN_SIDE_PANEL_PROMPT_ID}`))
  );
}

function startAnnotationMode(link) {
  cleanupAnnotation();
  setAnnotationStatus("Select an element on the page.");

  const state = {
    input: null,
    voiceRecorder: null,
    voiceRecordingState: "idle",
    voiceStream: null,
    onMove: (event) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || isBrowserAgentElement(target)) {
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
      setAnnotationStatus("Screenshot captured. Add a note and press Enter.");
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
          cleanupAnnotation({ preserveStatus: true });
          setAnnotationStatus(error.message);
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
      sendResponse({ ok: true });
      return true;
    case "t3code.browserAgent.showOpenSidePanelPrompt":
      showOpenSidePanelPrompt(message.reason);
      sendResponse({ ok: true });
      return true;
    case "t3code.browserAgent.hideOpenSidePanelPrompt":
      removeOpenSidePanelPrompt();
      sendResponse({ ok: true });
      return true;
    case "t3code.browserAgent.activateAnnotation":
      startAnnotationMode(message.workspaceLink);
      sendResponse({ ok: true });
      return true;
    case "t3code.browserAgent.cancelAnnotation":
      cancelAnnotation();
      sendResponse({ ok: true });
      return true;
    default:
      return false;
  }
});
