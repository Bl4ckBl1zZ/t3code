/* global chrome */

const TRANSFER_MESSAGE_TYPE = "t3code.transferToBrowser";
const ANNOTATION_STATUS_MESSAGE_TYPE = "t3code.browserAnnotation.status";
const ANNOTATION_ACTIVATE_MESSAGE_TYPE = "t3code.browserAnnotation.activate";
const DEV_ANNOTATION_ACTIVATE_MESSAGE_TYPE = "t3code.devPreview.activateAnnotationMode";
const DEV_ANNOTATION_CAPTURE_SCREENSHOT_MESSAGE_TYPE =
  "t3code.devPreview.captureAnnotationScreenshot";
const DEV_ANNOTATION_SUBMIT_MESSAGE_TYPE = "t3code.devPreview.submitAnnotation";
const DEV_ATTACH_SIDE_PANEL_MESSAGE_TYPE = "t3code.devPreview.attachSidePanel";
const ANNOTATION_CAPTURED_MESSAGE_TYPE = "t3code.browserAnnotation.capture";
const SIDE_PANEL_GET_SESSION_MESSAGE_TYPE = "t3code.sidePanel.getSession";
const SIDE_PANEL_READY_MESSAGE_TYPE = "t3code.sidePanel.ready";
const TRANSFER_FLAG_PARAM = "t3BrowserTransfer";
const TRANSFER_ID_PARAM = "t3BrowserTransferId";
const TRANSFER_DEV_SERVER_URL_PARAM = "t3DevServerUrl";
const TRANSFER_EXTENSION_PATH_PARAM = "t3ExtensionPath";
const TRANSFER_GROUP_TITLE_PARAM = "t3GroupTitle";
const DEFAULT_GROUP_TITLE = "T3 Code";
const LINK_STORAGE_KEY = "t3code.browserTransfer.links";
const NO_TAB_GROUP_ID = -1;
const sidePanelPortsBySessionId = new Map();

function isTransferMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === TRANSFER_MESSAGE_TYPE &&
    typeof message.devServerUrl === "string" &&
    message.devServerUrl.length > 0 &&
    (message.groupTitle === undefined || typeof message.groupTitle === "string")
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

function cleanT3SidePanelUrl(rawUrl) {
  const url = new URL(rawUrl);
  for (const param of [
    TRANSFER_FLAG_PARAM,
    TRANSFER_ID_PARAM,
    TRANSFER_DEV_SERVER_URL_PARAM,
    TRANSFER_EXTENSION_PATH_PARAM,
    TRANSFER_GROUP_TITLE_PARAM,
  ]) {
    url.searchParams.delete(param);
  }
  return url.toString();
}

function normalizeGroupTitle(rawTitle) {
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  return title.length > 0 ? title.slice(0, 64) : DEFAULT_GROUP_TITLE;
}

function isAnnotationStatusMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === ANNOTATION_STATUS_MESSAGE_TYPE &&
    (message.sidePanelSessionId === undefined || typeof message.sidePanelSessionId === "string")
  );
}

function isAnnotationActivateMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === ANNOTATION_ACTIVATE_MESSAGE_TYPE &&
    (message.sidePanelSessionId === undefined || typeof message.sidePanelSessionId === "string")
  );
}

function isDevAnnotationCaptureScreenshotMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === DEV_ANNOTATION_CAPTURE_SCREENSHOT_MESSAGE_TYPE &&
    (message.sourceTabId === undefined || typeof message.sourceTabId === "number") &&
    (message.sidePanelSessionId === undefined || typeof message.sidePanelSessionId === "string")
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
    typeof message.pageTitle === "string" &&
    (message.sourceTabId === undefined || typeof message.sourceTabId === "number") &&
    (message.sidePanelSessionId === undefined || typeof message.sidePanelSessionId === "string")
  );
}

function isSidePanelGetSessionMessage(message) {
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === SIDE_PANEL_GET_SESSION_MESSAGE_TYPE &&
    typeof message.sessionId === "string" &&
    message.sessionId.trim().length > 0
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
    (entry) =>
      entry.devTabId !== link.devTabId &&
      (link.t3TabId === undefined || entry.t3TabId !== link.t3TabId) &&
      (link.sidePanelSessionId === undefined ||
        entry.sidePanelSessionId !== link.sidePanelSessionId),
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

async function findLinkBySidePanelSessionId(sessionId) {
  const links = await readLinks();
  return links.find((entry) => entry.sidePanelSessionId === sessionId) ?? null;
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

function sidePanelPath(sessionId) {
  return `sidepanel.html?sessionId=${encodeURIComponent(sessionId)}`;
}

function createSidePanelSessionId(id) {
  const suffix = Math.random().toString(36).slice(2);
  return `${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}-${Date.now().toString(36)}-${suffix}`;
}

async function openSidePanelForLink(link) {
  if (typeof link.devTabId !== "number" || typeof link.windowId !== "number") {
    throw new Error("Side panel link is missing tab metadata.");
  }
  if (!chrome.sidePanel?.setOptions || !chrome.sidePanel?.open) {
    throw new Error("Chrome Side Panel API is unavailable.");
  }
  await chrome.sidePanel.setOptions({
    tabId: link.devTabId,
    path: sidePanelPath(link.sidePanelSessionId),
    enabled: true,
  });
  await chrome.sidePanel.open({
    tabId: link.devTabId,
    windowId: link.windowId,
  });
}

function isMissingContentScriptError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection")
  );
}

async function ensureDevTabContentScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    throw new Error("Chrome scripting API is unavailable.");
  }
  await chrome.scripting.executeScript({
    target: {
      tabId,
      frameIds: [0],
    },
    files: ["transfer-content.js"],
  });
}

async function sendMessageToDevTab(tabId, message) {
  let lastError = null;
  let injected = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (error) {
      lastError = error;
      if (!isMissingContentScriptError(error)) {
        throw error;
      }
      if (!injected) {
        injected = true;
        await ensureDevTabContentScript(tabId);
      }
      await wait(100);
    }
  }
  throw lastError ?? new Error("Preview tab content script did not respond.");
}

async function attachInlineSidePanelForLink(link) {
  if (typeof link.devTabId !== "number") {
    throw new Error("Side panel link is missing preview tab metadata.");
  }
  const response = await sendMessageToDevTab(link.devTabId, {
    type: DEV_ATTACH_SIDE_PANEL_MESSAGE_TYPE,
    sidePanelSessionId: link.sidePanelSessionId,
  });
  if (response && response.ok === false) {
    throw new Error(response.error || "Could not attach the T3 Code side panel.");
  }
}

function withCurrentDevTabMetadata(link, devTab) {
  const devServerUrl = normalizeHttpUrl(devTab.url ?? "") ?? link.devServerUrl ?? devTab.url ?? "";
  return {
    ...link,
    devTabId: devTab.id,
    windowId: devTab.windowId,
    groupId: tabGroupId(devTab),
    devServerUrl,
  };
}

async function openChatPanelForLink(link) {
  try {
    await openSidePanelForLink(link);
    if (await waitForSidePanelConnection(link.sidePanelSessionId, 1_200)) {
      return "native";
    }
  } catch {
    // Chrome only allows programmatic side panel opens from some extension
    // user gestures. Desktop transfer arrives through an auto-opened tab, so
    // the native API can reject here even though the desktop button was clicked.
  }
  await attachInlineSidePanelForLink(link);
  return "inline";
}

async function openInlineChatPanelForLink(link) {
  await attachInlineSidePanelForLink(link);
  return "inline";
}

function sendSidePanelMessage(sessionId, message) {
  const port = sidePanelPortsBySessionId.get(sessionId);
  if (!port) {
    return false;
  }
  try {
    port.postMessage(message);
    return true;
  } catch {
    sidePanelPortsBySessionId.delete(sessionId);
    return false;
  }
}

async function waitForSidePanelConnection(sessionId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (sidePanelPortsBySessionId.has(sessionId)) {
      return true;
    }
    await wait(50);
  }
  return sidePanelPortsBySessionId.has(sessionId);
}

function tabGroupId(tab) {
  return typeof tab.groupId === "number" && tab.groupId !== NO_TAB_GROUP_ID ? tab.groupId : null;
}

function localHttpUrl(rawUrl) {
  const url = normalizeHttpUrl(rawUrl ?? "");
  if (!url) {
    return null;
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.")
  ) {
    return url;
  }

  return null;
}

function isLikelyDevServerTab(tab, sourceTabId) {
  if (tab.id === undefined || tab.id === sourceTabId) {
    return false;
  }
  if (isLikelyT3CodeTab(tab)) {
    return false;
  }
  return localHttpUrl(tab.url) !== null;
}

function isLikelyT3CodeTab(tab) {
  if (!tab.url) {
    return false;
  }

  try {
    const url = new URL(tab.url);
    return (
      url.searchParams.get("t3BrowserTransfer") === "1" ||
      url.pathname.startsWith("/_chat") ||
      /\bT3 Code\b/i.test(tab.title ?? "")
    );
  } catch {
    return /\bT3 Code\b/i.test(tab.title ?? "");
  }
}

function summarizeTab(tab, sourceTabId, annotationTargetId = null) {
  if (tab.id === undefined) {
    return null;
  }

  const groupId = tabGroupId(tab);
  const isSource = tab.id === sourceTabId;
  const isTarget = annotationTargetId !== null && tab.id === annotationTargetId;
  return {
    id: tab.id,
    ...(typeof tab.url === "string" && tab.url.length > 0 ? { url: tab.url } : {}),
    ...(typeof tab.title === "string" && tab.title.length > 0 ? { title: tab.title } : {}),
    active: Boolean(tab.active),
    groupId,
    windowId: typeof tab.windowId === "number" ? tab.windowId : null,
    index: typeof tab.index === "number" ? tab.index : null,
    kind: isSource
      ? "t3code"
      : isTarget || isLikelyDevServerTab(tab, sourceTabId)
        ? "dev-server"
        : "other",
  };
}

async function groupedTabsForTab(tab) {
  const groupId = tabGroupId(tab);
  if (groupId === null || typeof tab.windowId !== "number") {
    return [tab];
  }

  try {
    return await chrome.tabs.query({
      groupId,
      windowId: tab.windowId,
    });
  } catch {
    return [tab];
  }
}

function chooseAnnotationTarget(candidates, explicitLink) {
  const explicitTab =
    explicitLink?.devTabId !== undefined
      ? candidates.find((tab) => tab.id === explicitLink.devTabId)
      : null;
  if (explicitTab) {
    return { target: explicitTab, ambiguous: false };
  }

  const explicitDevServerUrl = normalizeHttpUrl(explicitLink?.devServerUrl ?? "");
  if (explicitDevServerUrl) {
    const matchingTabs = candidates.filter(
      (tab) => normalizeHttpUrl(tab.url ?? "") === explicitDevServerUrl,
    );
    if (matchingTabs.length === 1) {
      return { target: matchingTabs[0], ambiguous: false };
    }
  }

  if (candidates.length === 1) {
    return { target: candidates[0], ambiguous: false };
  }

  if (candidates.length > 1) {
    return { target: null, ambiguous: true };
  }

  return { target: null, ambiguous: false };
}

function emptyBrowserContext(currentTabId = null) {
  return {
    currentTabId,
    currentGroupId: null,
    groupedTabs: [],
    ambiguous: false,
  };
}

async function buildBrowserContextForT3Tab(sourceTabId) {
  const sourceTab = await getExistingTab(sourceTabId);
  if (!sourceTab) {
    return emptyBrowserContext(sourceTabId);
  }

  const explicitLink = await findLinkByT3TabId(sourceTabId);
  const groupedTabs = await groupedTabsForTab(sourceTab);
  const candidateTabs = groupedTabs.filter((tab) => isLikelyDevServerTab(tab, sourceTabId));
  const { target, ambiguous } = chooseAnnotationTarget(candidateTabs, explicitLink);
  const targetId = target?.id ?? null;
  const summarizedTabs = groupedTabs
    .map((tab) => summarizeTab(tab, sourceTabId, targetId))
    .filter(Boolean);
  const annotationTarget = target ? summarizeTab(target, sourceTabId, targetId) : null;

  return {
    currentTabId: sourceTabId,
    currentGroupId: tabGroupId(sourceTab),
    groupedTabs: summarizedTabs,
    ...(annotationTarget ? { annotationTarget } : {}),
    ambiguous,
  };
}

async function buildBrowserContextForSidePanelSession(sessionId) {
  const link = await findLinkBySidePanelSessionId(sessionId);
  if (!link || typeof link.devTabId !== "number") {
    return emptyBrowserContext();
  }

  const devTab = await getExistingTab(link.devTabId);
  if (!devTab || devTab.id === undefined) {
    return emptyBrowserContext();
  }

  const annotationTarget = summarizeTab(devTab, null, devTab.id);
  return {
    currentTabId: null,
    currentGroupId: null,
    groupedTabs: annotationTarget ? [annotationTarget] : [],
    ...(annotationTarget ? { annotationTarget } : {}),
    ambiguous: false,
  };
}

async function resolveT3TabForDevAnnotation(message, devTabId) {
  if (typeof message.sourceTabId === "number") {
    const sourceTab = await getExistingTab(message.sourceTabId);
    if (sourceTab) {
      return sourceTab;
    }
  }

  const explicitLink = await findLinkByDevTabId(devTabId);
  if (explicitLink) {
    const sourceTab = await getExistingTab(explicitLink.t3TabId);
    if (sourceTab) {
      return sourceTab;
    }
  }

  const devTab = await getExistingTab(devTabId);
  if (!devTab) {
    return null;
  }
  const groupedTabs = await groupedTabsForTab(devTab);
  const candidateTabs = groupedTabs.filter(
    (tab) => tab.id !== devTabId && tab.id !== undefined && isLikelyT3CodeTab(tab),
  );
  return candidateTabs.length === 1 ? candidateTabs[0] : null;
}

async function resolveSidePanelLinkForDevAnnotation(message, devTabId) {
  const sidePanelSessionId =
    typeof message.sidePanelSessionId === "string" && message.sidePanelSessionId.trim()
      ? message.sidePanelSessionId.trim()
      : null;
  if (sidePanelSessionId) {
    const link = await findLinkBySidePanelSessionId(sidePanelSessionId);
    return link && link.devTabId === devTabId ? link : null;
  }

  const link = await findLinkByDevTabId(devTabId);
  return link?.sidePanelSessionId ? link : null;
}

function matchingTransferCandidate(candidates, groupTitle) {
  if (candidates.length === 0) {
    return null;
  }

  return candidates.find((candidate) => candidate.groupTitle === groupTitle) ?? candidates[0];
}

async function findExistingTransferFromLinks(devServerUrl, groupTitle) {
  const links = await readLinks();
  const candidates = [];

  for (const link of links) {
    if (normalizeHttpUrl(link.devServerUrl ?? "") !== devServerUrl) {
      continue;
    }

    const devTab = await getExistingTab(link.devTabId);
    if (!devTab || devTab.id === undefined || devTab.windowId === undefined) {
      continue;
    }

    candidates.push({
      devTab,
      sidePanelSessionId:
        typeof link.sidePanelSessionId === "string" ? link.sidePanelSessionId : null,
      groupTitle: typeof link.groupTitle === "string" ? link.groupTitle : null,
    });
  }

  return matchingTransferCandidate(candidates, groupTitle);
}

async function findExistingTransfer(_sourceTabId, devServerUrl, groupTitle) {
  return await findExistingTransferFromLinks(devServerUrl, groupTitle);
}

async function findReusableLinkByDevServerUrl(devServerUrl) {
  const links = await readLinks();
  const candidates = links.filter(
    (link) =>
      typeof link.t3Url === "string" &&
      link.t3Url.length > 0 &&
      normalizeHttpUrl(link.devServerUrl ?? "") === devServerUrl,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

async function resolveActionLinkFromT3Tab(tab) {
  if (tab.id === undefined || !tab.url) {
    return null;
  }

  const explicitLink = await findLinkByT3TabId(tab.id);
  if (explicitLink?.sidePanelSessionId && typeof explicitLink.devTabId === "number") {
    const devTab = await getExistingTab(explicitLink.devTabId);
    return devTab && devTab.id !== undefined && devTab.windowId !== undefined
      ? withCurrentDevTabMetadata(explicitLink, devTab)
      : null;
  }

  const browserContext = await buildBrowserContextForT3Tab(tab.id);
  const devTabId = browserContext.annotationTarget?.id;
  if (typeof devTabId !== "number") {
    return null;
  }

  const devTab = await getExistingTab(devTabId);
  if (!devTab || devTab.id === undefined || devTab.windowId === undefined) {
    return null;
  }

  const link = {
    id: `action-${tab.id}-${devTab.id}-${Date.now()}`,
    sidePanelSessionId: createSidePanelSessionId(`action-${tab.id}-${devTab.id}`),
    t3TabId: tab.id,
    t3Url: cleanT3SidePanelUrl(tab.url),
    devTabId: devTab.id,
    windowId: devTab.windowId,
    groupId: browserContext.currentGroupId,
    groupTitle: DEFAULT_GROUP_TITLE,
    devServerUrl: normalizeHttpUrl(devTab.url ?? "") ?? devTab.url ?? "",
    createdAt: new Date().toISOString(),
  };
  await storeLink(link);
  return link;
}

async function resolveActionLinkFromDevTab(tab) {
  if (tab.id === undefined || tab.windowId === undefined) {
    return null;
  }

  const explicitLink = await findLinkByDevTabId(tab.id);
  if (explicitLink?.t3Url) {
    const link = {
      ...withCurrentDevTabMetadata(explicitLink, tab),
      sidePanelSessionId:
        typeof explicitLink.sidePanelSessionId === "string" &&
        explicitLink.sidePanelSessionId.length > 0
          ? explicitLink.sidePanelSessionId
          : createSidePanelSessionId(`action-${tab.id}`),
    };
    await storeLink(link);
    return link;
  }

  const devServerUrl = normalizeHttpUrl(tab.url ?? "");
  if (!devServerUrl) {
    return null;
  }

  const reusableLink = await findReusableLinkByDevServerUrl(devServerUrl);
  if (!reusableLink) {
    return null;
  }

  const link = {
    ...withCurrentDevTabMetadata(reusableLink, tab),
    id: `action-${tab.id}-${Date.now()}`,
    sidePanelSessionId: createSidePanelSessionId(`action-${tab.id}`),
    createdAt: new Date().toISOString(),
  };
  await storeLink(link);
  return link;
}

async function resolveActionLinkForTab(tab) {
  if (tab.id === undefined) {
    return null;
  }
  if (isLikelyT3CodeTab(tab)) {
    return await resolveActionLinkFromT3Tab(tab);
  }
  return await resolveActionLinkFromDevTab(tab);
}

async function focusExistingTransfer(existingTransfer, sourceTab, groupTitle, devServerUrl, id) {
  const sourceTabId = sourceTab.id;
  const sidePanelSessionId = createSidePanelSessionId(id);
  const link = {
    id,
    sidePanelSessionId,
    t3Url: cleanT3SidePanelUrl(sourceTab.url),
    devTabId: existingTransfer.devTab.id,
    windowId: existingTransfer.devTab.windowId,
    groupId: null,
    groupTitle,
    devServerUrl,
    createdAt: new Date().toISOString(),
  };
  await storeLink(link);

  await chrome.tabs.update(existingTransfer.devTab.id, { active: true });
  await chrome.windows.update(existingTransfer.devTab.windowId, { focused: true });
  let panelMode = "native";
  try {
    panelMode = await openChatPanelForLink(link);
  } finally {
    if (sourceTabId !== existingTransfer.devTab.id) {
      await chrome.tabs.remove(sourceTabId).catch(() => {});
    }
  }

  return {
    devTabId: existingTransfer.devTab.id,
    sidePanelSessionId,
    panelMode,
    reused: true,
  };
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
  if (!sourceTab.url) {
    throw new Error("Source tab is missing the T3 Code URL.");
  }

  const devServerUrl = normalizeHttpUrl(message.devServerUrl);
  if (!devServerUrl) {
    throw new Error("Transfer request included an invalid dev server URL.");
  }

  const groupTitle = normalizeGroupTitle(message.groupTitle);
  const id = typeof message.id === "string" ? message.id : `${Date.now()}`;
  const existingTransfer = await findExistingTransfer(sourceTabId, devServerUrl, groupTitle);
  if (existingTransfer) {
    return await focusExistingTransfer(existingTransfer, sourceTab, groupTitle, devServerUrl, id);
  }

  const devTab = await chrome.tabs.create({
    windowId: sourceTab.windowId,
    index: sourceTab.index + 1,
    url: devServerUrl,
    active: true,
  });
  if (devTab.id === undefined) {
    throw new Error("Chrome did not return a dev server tab id.");
  }

  const sidePanelSessionId = createSidePanelSessionId(id);
  const link = {
    id,
    sidePanelSessionId,
    t3Url: cleanT3SidePanelUrl(sourceTab.url),
    devTabId: devTab.id,
    windowId: sourceTab.windowId,
    groupId: null,
    groupTitle,
    devServerUrl,
    createdAt: new Date().toISOString(),
  };
  await storeLink(link);
  await chrome.windows.update(sourceTab.windowId, { focused: true });
  let panelMode = "native";
  try {
    panelMode = await openChatPanelForLink(link);
  } finally {
    await chrome.tabs.remove(sourceTabId).catch(() => {});
  }

  return {
    devTabId: devTab.id,
    sidePanelSessionId,
    panelMode,
  };
}

async function handleSidePanelGetSession(message) {
  const link = await findLinkBySidePanelSessionId(message.sessionId.trim());
  if (!link || typeof link.t3Url !== "string" || link.t3Url.length === 0) {
    throw new Error("T3 Code side panel session was not found.");
  }
  return {
    sessionId: link.sidePanelSessionId,
    t3Url: link.t3Url,
    devServerUrl: link.devServerUrl,
    groupTitle: link.groupTitle,
  };
}

async function handleAnnotationStatus(message, sender) {
  if (typeof message.sidePanelSessionId === "string" && message.sidePanelSessionId.trim()) {
    const browserContext = await buildBrowserContextForSidePanelSession(
      message.sidePanelSessionId.trim(),
    );
    return {
      linked: Boolean(browserContext.annotationTarget),
      active: false,
      browserContext,
    };
  }

  const sourceTabId = senderTabId(sender);
  if (sourceTabId === undefined) {
    return {
      linked: false,
      active: false,
      browserContext: emptyBrowserContext(),
    };
  }

  const browserContext = await buildBrowserContextForT3Tab(sourceTabId);
  return {
    linked: Boolean(browserContext.annotationTarget),
    active: false,
    browserContext,
  };
}

async function handleAnnotationActivate(message, sender) {
  if (typeof message.sidePanelSessionId === "string" && message.sidePanelSessionId.trim()) {
    const sidePanelSessionId = message.sidePanelSessionId.trim();
    const browserContext = await buildBrowserContextForSidePanelSession(sidePanelSessionId);
    if (!browserContext.annotationTarget) {
      throw new Error("No linked preview tab found. Use Transfer to Browser again.");
    }

    const devTab = await getExistingTab(browserContext.annotationTarget.id);
    if (!devTab || devTab.id === undefined || devTab.windowId === undefined) {
      throw new Error("The linked preview tab is no longer available.");
    }

    await chrome.windows.update(devTab.windowId, { focused: true });
    await chrome.tabs.update(devTab.id, { active: true });
    await chrome.tabs.sendMessage(devTab.id, {
      type: DEV_ANNOTATION_ACTIVATE_MESSAGE_TYPE,
      sidePanelSessionId,
    });

    return {
      linked: true,
      active: true,
      browserContext: {
        ...browserContext,
        annotationTarget: summarizeTab(devTab, null, devTab.id),
      },
    };
  }

  const sourceTabId = senderTabId(sender);
  if (sourceTabId === undefined) {
    throw new Error("Annotation request did not include a source tab.");
  }

  const browserContext = await buildBrowserContextForT3Tab(sourceTabId);
  if (browserContext.ambiguous && !browserContext.annotationTarget) {
    throw new Error("Multiple grouped preview tabs found. Keep one dev server tab in this group.");
  }

  if (!browserContext.annotationTarget) {
    throw new Error("No grouped preview tab found. Keep T3 Code and the dev server in one group.");
  }

  const devTab = await getExistingTab(browserContext.annotationTarget.id);
  if (!devTab || devTab.id === undefined || devTab.windowId === undefined) {
    throw new Error("The linked preview tab is no longer available.");
  }

  await chrome.windows.update(devTab.windowId, { focused: true });
  await chrome.tabs.update(devTab.id, { active: true });
  await chrome.tabs.sendMessage(devTab.id, {
    type: DEV_ANNOTATION_ACTIVATE_MESSAGE_TYPE,
    sourceTabId,
  });

  await storeLink({
    id: `group-${sourceTabId}-${devTab.id}`,
    t3TabId: sourceTabId,
    devTabId: devTab.id,
    windowId: devTab.windowId,
    groupId: browserContext.currentGroupId,
    groupTitle: DEFAULT_GROUP_TITLE,
    devServerUrl: normalizeHttpUrl(devTab.url ?? "") ?? devTab.url ?? "",
    createdAt: new Date().toISOString(),
  });

  return {
    linked: true,
    active: true,
    browserContext: {
      ...browserContext,
      annotationTarget: summarizeTab(devTab, sourceTabId, devTab.id),
    },
  };
}

async function handleDevAnnotationCaptureScreenshot(message, sender) {
  const devTabId = senderTabId(sender);
  const windowId = sender.tab?.windowId;
  if (devTabId === undefined || windowId === undefined) {
    throw new Error("Screenshot request did not include a preview tab.");
  }

  if (
    !(await resolveSidePanelLinkForDevAnnotation(message, devTabId)) &&
    !(await resolveT3TabForDevAnnotation(message, devTabId))
  ) {
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

  const sidePanelLink = await resolveSidePanelLinkForDevAnnotation(message, devTabId);
  if (sidePanelLink?.sidePanelSessionId) {
    const delivered = sendSidePanelMessage(sidePanelLink.sidePanelSessionId, {
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
    if (!delivered) {
      throw new Error("The T3 Code side panel is not connected.");
    }
    return { linked: true, active: false };
  }

  const t3Tab = await resolveT3TabForDevAnnotation(message, devTabId);
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

  if (isSidePanelGetSessionMessage(message)) {
    return sendAsyncResponse(sendResponse, handleSidePanelGetSession(message));
  }

  if (isAnnotationStatusMessage(message)) {
    return sendAsyncResponse(sendResponse, handleAnnotationStatus(message, sender));
  }

  if (isAnnotationActivateMessage(message)) {
    return sendAsyncResponse(sendResponse, handleAnnotationActivate(message, sender));
  }

  if (isDevAnnotationCaptureScreenshotMessage(message)) {
    return sendAsyncResponse(sendResponse, handleDevAnnotationCaptureScreenshot(message, sender));
  }

  if (isDevAnnotationSubmitMessage(message)) {
    return sendAsyncResponse(sendResponse, handleDevAnnotationSubmit(message, sender));
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "t3code.sidePanel") {
    return;
  }

  let sessionId = null;
  port.onMessage.addListener((message) => {
    if (
      typeof message === "object" &&
      message !== null &&
      message.type === SIDE_PANEL_READY_MESSAGE_TYPE &&
      typeof message.sessionId === "string" &&
      message.sessionId.trim().length > 0
    ) {
      sessionId = message.sessionId.trim();
      sidePanelPortsBySessionId.set(sessionId, port);
    }
  });
  port.onDisconnect.addListener(() => {
    if (sessionId && sidePanelPortsBySessionId.get(sessionId) === port) {
      sidePanelPortsBySessionId.delete(sessionId);
    }
  });
});

async function restoreInlineSidePanelForDevTab(tabId, tab) {
  const link = await findLinkByDevTabId(tabId);
  if (
    !link?.sidePanelSessionId ||
    typeof link.t3Url !== "string" ||
    link.t3Url.length === 0 ||
    sidePanelPortsBySessionId.has(link.sidePanelSessionId)
  ) {
    return;
  }

  const devTab =
    tab && tab.id === tabId && tab.windowId !== undefined ? tab : await getExistingTab(tabId);
  if (!devTab || devTab.id === undefined || devTab.windowId === undefined) {
    return;
  }

  const nextLink = withCurrentDevTabMetadata(link, devTab);
  await storeLink(nextLink);
  await attachInlineSidePanelForLink(nextLink);
}

async function showActionError(tabId, error) {
  if (tabId === undefined) {
    return;
  }
  const message = error instanceof Error ? error.message : "Could not open T3 Code sidebar.";
  await chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: message }).catch(() => {});
  await wait(2_500);
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: "T3 Code Browser Transfer" }).catch(() => {});
}

async function handleActionClick(tab) {
  const link = await resolveActionLinkForTab(tab);
  if (!link || typeof link.devTabId !== "number" || typeof link.windowId !== "number") {
    throw new Error("No linked T3 Code chat found for this tab. Use Transfer to Browser first.");
  }

  await chrome.tabs.update(link.devTabId, { active: true });
  await chrome.windows.update(link.windowId, { focused: true });
  await openInlineChatPanelForLink(link);
}

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab).catch((error) => {
    void showActionError(tab.id, error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  void wait(250)
    .then(() => restoreInlineSidePanelForDevTab(tabId, tab))
    .catch(() => {
      // A restored page can still be mid-navigation or blocked by the target
      // page; the toolbar action can reattach the panel on demand.
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeLinksForTab(tabId);
});
