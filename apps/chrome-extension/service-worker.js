/* global chrome */

const TRANSFER_MESSAGE_TYPE = "t3code.transferToBrowser";
const ANNOTATION_STATUS_MESSAGE_TYPE = "t3code.browserAnnotation.status";
const ANNOTATION_ACTIVATE_MESSAGE_TYPE = "t3code.browserAnnotation.activate";
const DEV_ANNOTATION_ACTIVATE_MESSAGE_TYPE = "t3code.devPreview.activateAnnotationMode";
const DEV_ANNOTATION_CAPTURE_SCREENSHOT_MESSAGE_TYPE =
  "t3code.devPreview.captureAnnotationScreenshot";
const DEV_ANNOTATION_SUBMIT_MESSAGE_TYPE = "t3code.devPreview.submitAnnotation";
const ANNOTATION_CAPTURED_MESSAGE_TYPE = "t3code.browserAnnotation.capture";
const DEFAULT_GROUP_TITLE = "T3 Code";
const DEFAULT_GROUP_COLOR = "blue";
const LINK_STORAGE_KEY = "t3code.browserTransfer.links";

function isTransferMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === TRANSFER_MESSAGE_TYPE &&
    typeof message.devServerUrl === "string" &&
    message.devServerUrl.length > 0
  );
}

function normalizeHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isAnnotationStatusMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === ANNOTATION_STATUS_MESSAGE_TYPE
  );
}

function isAnnotationActivateMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === ANNOTATION_ACTIVATE_MESSAGE_TYPE
  );
}

function isDevAnnotationCaptureScreenshotMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === DEV_ANNOTATION_CAPTURE_SCREENSHOT_MESSAGE_TYPE
  );
}

function isDevAnnotationSubmitMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === DEV_ANNOTATION_SUBMIT_MESSAGE_TYPE &&
    typeof message.text === "string" &&
    message.text.trim().length > 0 &&
    typeof message.screenshotDataUrl === "string" &&
    message.screenshotDataUrl.startsWith("data:image/") &&
    typeof message.pageUrl === "string" &&
    typeof message.pageTitle === "string"
  );
}

function senderTabId(sender) {
  return sender.tab?.id;
}

async function readLinks() {
  try {
    const result = await chrome.storage.session.get(LINK_STORAGE_KEY);
    const links = result[LINK_STORAGE_KEY];
    return Array.isArray(links) ? links : [];
  } catch {
    return [];
  }
}

async function writeLinks(links) {
  try {
    await chrome.storage.session.set({ [LINK_STORAGE_KEY]: links });
  } catch {
    // Session storage is best-effort. The current service worker invocation
    // still completes the requested operation even if persistence fails.
  }
}

async function storeLink(link) {
  const links = await readLinks();
  const nextLinks = links.filter(
    (entry) => entry.t3TabId !== link.t3TabId && entry.devTabId !== link.devTabId,
  );
  nextLinks.push(link);
  await writeLinks(nextLinks);
}

async function removeLinksForTab(tabId) {
  const links = await readLinks();
  const nextLinks = links.filter((entry) => entry.t3TabId !== tabId && entry.devTabId !== tabId);
  if (nextLinks.length !== links.length) {
    await writeLinks(nextLinks);
  }
}

async function findLinkByT3TabId(tabId) {
  const links = await readLinks();
  return links.find((entry) => entry.t3TabId === tabId) ?? null;
}

async function findLinkByDevTabId(tabId) {
  const links = await readLinks();
  return links.find((entry) => entry.devTabId === tabId) ?? null;
}

async function getExistingTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    await removeLinksForTab(tabId);
    return null;
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function handleTransferToBrowser(message, sender) {
  const sourceTabId = sender.tab?.id;
  if (sourceTabId === undefined) {
    throw new Error("Transfer request did not include a source tab.");
  }

  const sourceTab = await chrome.tabs.get(sourceTabId);
  if (sourceTab.windowId === undefined || sourceTab.index === undefined) {
    throw new Error("Source tab is missing window metadata.");
  }

  const devServerUrl = normalizeHttpUrl(message.devServerUrl);
  if (!devServerUrl) {
    throw new Error("Transfer request included an invalid dev server URL.");
  }

  const devTab = await chrome.tabs.create({
    windowId: sourceTab.windowId,
    index: sourceTab.index + 1,
    url: devServerUrl,
    active: false,
  });
  if (devTab.id === undefined) {
    throw new Error("Chrome did not return a dev server tab id.");
  }

  const groupId = await chrome.tabs.group({
    createProperties: { windowId: sourceTab.windowId },
    tabIds: [sourceTabId, devTab.id],
  });

  await chrome.tabGroups.update(groupId, {
    collapsed: false,
    color: DEFAULT_GROUP_COLOR,
    title: DEFAULT_GROUP_TITLE,
  });
  await chrome.tabs.update(sourceTabId, { active: true });
  await chrome.windows.update(sourceTab.windowId, { focused: true });

  await storeLink({
    id: typeof message.id === "string" ? message.id : `${Date.now()}`,
    t3TabId: sourceTabId,
    devTabId: devTab.id,
    windowId: sourceTab.windowId,
    groupId,
    devServerUrl,
    createdAt: new Date().toISOString(),
  });

  return {
    devTabId: devTab.id,
    groupId,
  };
}

async function handleAnnotationStatus(sender) {
  const sourceTabId = senderTabId(sender);
  if (sourceTabId === undefined) {
    return { linked: false, active: false };
  }

  const link = await findLinkByT3TabId(sourceTabId);
  if (!link) {
    return { linked: false, active: false };
  }

  const devTab = await getExistingTab(link.devTabId);
  return { linked: devTab !== null, active: false };
}

async function handleAnnotationActivate(sender) {
  const sourceTabId = senderTabId(sender);
  if (sourceTabId === undefined) {
    throw new Error("Annotation request did not include a source tab.");
  }

  const link = await findLinkByT3TabId(sourceTabId);
  if (!link) {
    throw new Error("No linked preview tab found. Use Transfer to Browser again.");
  }

  const devTab = await getExistingTab(link.devTabId);
  if (!devTab || devTab.id === undefined || devTab.windowId === undefined) {
    throw new Error("The linked preview tab is no longer available.");
  }

  await chrome.windows.update(devTab.windowId, { focused: true });
  await chrome.tabs.update(devTab.id, { active: true });
  await chrome.tabs.sendMessage(devTab.id, {
    type: DEV_ANNOTATION_ACTIVATE_MESSAGE_TYPE,
    sourceTabId,
  });

  return { linked: true, active: true };
}

async function handleDevAnnotationCaptureScreenshot(sender) {
  const devTabId = senderTabId(sender);
  const windowId = sender.tab?.windowId;
  if (devTabId === undefined || windowId === undefined) {
    throw new Error("Screenshot request did not include a preview tab.");
  }

  const link = await findLinkByDevTabId(devTabId);
  if (!link) {
    throw new Error("This preview tab is not linked to a T3 Code chat.");
  }

  await chrome.tabs.update(devTabId, { active: true });
  await chrome.windows.update(windowId, { focused: true });
  await wait(80);

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "png",
  });
  return { screenshotDataUrl };
}

async function handleDevAnnotationSubmit(message, sender) {
  const devTabId = senderTabId(sender);
  if (devTabId === undefined) {
    throw new Error("Annotation submission did not include a preview tab.");
  }

  const link = await findLinkByDevTabId(devTabId);
  if (!link) {
    throw new Error("This preview tab is not linked to a T3 Code chat.");
  }

  const t3Tab = await getExistingTab(link.t3TabId);
  if (!t3Tab || t3Tab.id === undefined || t3Tab.windowId === undefined) {
    throw new Error("The linked T3 Code tab is no longer available.");
  }

  await chrome.tabs.sendMessage(t3Tab.id, {
    type: ANNOTATION_CAPTURED_MESSAGE_TYPE,
    text: message.text,
    screenshotDataUrl: message.screenshotDataUrl,
    pageUrl: message.pageUrl,
    pageTitle: message.pageTitle,
    selectorLabel:
      typeof message.selectorLabel === "string" && message.selectorLabel.trim().length > 0
        ? message.selectorLabel
        : undefined,
  });
  await chrome.tabs.update(t3Tab.id, { active: true });
  await chrome.windows.update(t3Tab.windowId, { focused: true });

  return { linked: true, active: false };
}

function sendAsyncResponse(sendResponse, promise) {
  void promise.then(
    (result) => {
      sendResponse({ ok: true, result });
    },
    (error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Request failed.",
      });
    },
  );
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isTransferMessage(message)) {
    return sendAsyncResponse(sendResponse, handleTransferToBrowser(message, sender));
  }

  if (isAnnotationStatusMessage(message)) {
    return sendAsyncResponse(sendResponse, handleAnnotationStatus(sender));
  }

  if (isAnnotationActivateMessage(message)) {
    return sendAsyncResponse(sendResponse, handleAnnotationActivate(sender));
  }

  if (isDevAnnotationCaptureScreenshotMessage(message)) {
    return sendAsyncResponse(sendResponse, handleDevAnnotationCaptureScreenshot(sender));
  }

  if (isDevAnnotationSubmitMessage(message)) {
    return sendAsyncResponse(sendResponse, handleDevAnnotationSubmit(message, sender));
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeLinksForTab(tabId);
});
