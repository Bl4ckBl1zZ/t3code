import type { ProjectScript } from "@t3tools/contracts";

import {
  BROWSER_ANNOTATION_EXTENSION_SOURCE,
  BROWSER_ANNOTATION_PAGE_SOURCE,
} from "./browserAnnotation";
import { randomUUID } from "./lib/utils";
import { setPairingTokenOnUrl } from "./pairingUrl";

export const BROWSER_TRANSFER_FLAG_PARAM = "t3BrowserTransfer";
export const BROWSER_TRANSFER_ID_PARAM = "t3BrowserTransferId";
export const BROWSER_TRANSFER_DEV_SERVER_URL_PARAM = "t3DevServerUrl";
export const BROWSER_TRANSFER_EXTENSION_PATH_PARAM = "t3ExtensionPath";
export const BROWSER_TRANSFER_GROUP_TITLE_PARAM = "t3GroupTitle";
export const BROWSER_TRANSFER_START_MESSAGE = "t3code.browserTransfer.start";
export const BROWSER_TRANSFER_RESULT_MESSAGE = "t3code.browserTransfer.result";
export const BROWSER_TRANSFER_PAGE_SOURCE = BROWSER_ANNOTATION_PAGE_SOURCE;
export const BROWSER_TRANSFER_EXTENSION_SOURCE = BROWSER_ANNOTATION_EXTENSION_SOURCE;
export const BROWSER_TRANSFER_SETUP_REQUEST_EVENT = "t3code:browser-transfer:setup-request";
export const BROWSER_TRANSFER_EXTENSION_RESPONSE_TIMEOUT_MS = 1_800;
export const DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL = "http://localhost:3000/";
export const DEFAULT_BROWSER_TRANSFER_EXTENSION_PATH =
  "/Applications/T3 Code (Alpha).app/Contents/Resources/chrome-extension";
export const SOURCE_BROWSER_TRANSFER_EXTENSION_PATH = "apps/chrome-extension";
export const BROWSER_TRANSFER_SETUP_STORAGE_KEY = "t3code:browser-transfer:setup";

const PORT_PATTERNS = [
  /(?:^|\s)(?:--port|-p)\s+(\d{2,5})\b/,
  /(?:^|\s)(?:--port|-p)=(\d{2,5})\b/,
  /(?:^|\s)(?:PORT|VITE_PORT)=(\d{2,5})\b/,
] as const;

function normalizeHttpUrl(rawUrl: string): string | null {
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

function parsePort(command: string): number | null {
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(command);
    const rawPort = match?.[1];
    if (!rawPort) continue;
    const port = Number.parseInt(rawPort, 10);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      return port;
    }
  }
  return null;
}

function primaryRunnableScript(
  scripts: readonly ProjectScript[] | undefined,
): ProjectScript | null {
  if (!scripts || scripts.length === 0) {
    return null;
  }
  return scripts.find((script) => !script.runOnWorktreeCreate) ?? scripts[0] ?? null;
}

export function inferBrowserTransferDevServerUrl(
  scripts: readonly ProjectScript[] | undefined,
): string {
  const script = primaryRunnableScript(scripts);
  const command = script?.command ?? "";
  const port = parsePort(command);
  if (port !== null) {
    return `http://localhost:${port}/`;
  }

  if (/\b(?:vite|vitest\s+--ui)\b/i.test(command)) {
    return "http://localhost:5173/";
  }
  if (/\bastro\b/i.test(command)) {
    return "http://localhost:4321/";
  }
  if (/\bnext\b/i.test(command)) {
    return DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL;
  }

  return DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL;
}

export function resolveBrowserRoutePath(location: Location): string {
  const hashRoute = location.hash.startsWith("#/") ? location.hash.slice(1) : "";
  if (hashRoute) {
    return hashRoute;
  }

  return `${location.pathname}${location.search}`;
}

export function buildBrowserTransferUrl(input: {
  readonly t3CodeBaseUrl: string;
  readonly routePath: string;
  readonly pairingCredential: string;
  readonly devServerUrl: string;
  readonly groupTitle?: string | null;
  readonly extensionInstallPath?: string | null;
  readonly transferId?: string;
}): string {
  const baseUrl = new URL(input.t3CodeBaseUrl);
  const url = new URL(input.routePath || "/", baseUrl);
  const normalizedDevServerUrl =
    normalizeHttpUrl(input.devServerUrl) ?? DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL;

  url.searchParams.set(BROWSER_TRANSFER_FLAG_PARAM, "1");
  url.searchParams.set(BROWSER_TRANSFER_DEV_SERVER_URL_PARAM, normalizedDevServerUrl);
  url.searchParams.set(BROWSER_TRANSFER_ID_PARAM, input.transferId ?? randomUUID());
  const groupTitle = input.groupTitle?.trim();
  if (groupTitle) {
    url.searchParams.set(BROWSER_TRANSFER_GROUP_TITLE_PARAM, groupTitle);
  }
  if (input.extensionInstallPath) {
    url.searchParams.set(BROWSER_TRANSFER_EXTENSION_PATH_PARAM, input.extensionInstallPath);
  }

  return setPairingTokenOnUrl(url, input.pairingCredential).toString();
}

export interface BrowserTransferSetupRequest {
  readonly id: string;
  readonly devServerUrl: string;
  readonly groupTitle?: string;
  readonly extensionInstallPath: string;
}

export interface BrowserTransferResultMessage {
  readonly source: typeof BROWSER_TRANSFER_EXTENSION_SOURCE;
  readonly type: typeof BROWSER_TRANSFER_RESULT_MESSAGE;
  readonly id: string;
  readonly ok: boolean;
  readonly devTabId?: number;
  readonly groupId?: number;
  readonly error?: string;
}

export function createBrowserTransferSetupRequest(input: {
  readonly devServerUrl: string;
  readonly groupTitle?: string | null;
  readonly extensionInstallPath?: string | null;
  readonly id?: string;
}): BrowserTransferSetupRequest {
  const groupTitle = input.groupTitle?.trim();
  return {
    id: input.id ?? randomUUID(),
    devServerUrl: normalizeHttpUrl(input.devServerUrl) ?? DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL,
    ...(groupTitle ? { groupTitle } : {}),
    extensionInstallPath:
      input.extensionInstallPath?.trim() || DEFAULT_BROWSER_TRANSFER_EXTENSION_PATH,
  };
}

export function readBrowserTransferSetupRequestFromUrl(
  url: URL,
): BrowserTransferSetupRequest | null {
  if (url.searchParams.get(BROWSER_TRANSFER_FLAG_PARAM) !== "1") {
    return null;
  }

  return createBrowserTransferSetupRequest({
    id: url.searchParams.get(BROWSER_TRANSFER_ID_PARAM) || randomUUID(),
    devServerUrl:
      normalizeHttpUrl(url.searchParams.get(BROWSER_TRANSFER_DEV_SERVER_URL_PARAM) ?? "") ??
      DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL,
    groupTitle: url.searchParams.get(BROWSER_TRANSFER_GROUP_TITLE_PARAM)?.trim() || null,
    extensionInstallPath:
      url.searchParams.get(BROWSER_TRANSFER_EXTENSION_PATH_PARAM)?.trim() ||
      DEFAULT_BROWSER_TRANSFER_EXTENSION_PATH,
  });
}

export function rememberBrowserTransferSetupRequest(
  request: BrowserTransferSetupRequest,
): BrowserTransferSetupRequest {
  if (typeof window === "undefined") {
    return request;
  }

  try {
    window.sessionStorage.setItem(BROWSER_TRANSFER_SETUP_STORAGE_KEY, JSON.stringify(request));
  } catch {
    // Non-critical: the current UI can still show the request while this page stays loaded.
  }
  return request;
}

export function rememberBrowserTransferSetupRequestFromUrl(
  url: URL,
): BrowserTransferSetupRequest | null {
  const request = readBrowserTransferSetupRequestFromUrl(url);
  if (!request || typeof window === "undefined") {
    return request;
  }

  return rememberBrowserTransferSetupRequest(request);
}

export function readRememberedBrowserTransferSetupRequest(): BrowserTransferSetupRequest | null {
  if (typeof window === "undefined") {
    return null;
  }

  const fromUrl = readBrowserTransferSetupRequestFromUrl(new URL(window.location.href));
  if (fromUrl) {
    return fromUrl;
  }

  try {
    const raw = window.sessionStorage.getItem(BROWSER_TRANSFER_SETUP_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<BrowserTransferSetupRequest>;
    if (typeof parsed.id !== "string" || typeof parsed.devServerUrl !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      devServerUrl:
        normalizeHttpUrl(parsed.devServerUrl) ?? DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL,
      ...(typeof parsed.groupTitle === "string" && parsed.groupTitle.trim()
        ? { groupTitle: parsed.groupTitle.trim() }
        : {}),
      extensionInstallPath:
        typeof parsed.extensionInstallPath === "string" && parsed.extensionInstallPath.trim()
          ? parsed.extensionInstallPath
          : DEFAULT_BROWSER_TRANSFER_EXTENSION_PATH,
    };
  } catch {
    return null;
  }
}

export function clearRememberedBrowserTransferSetupRequest(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(BROWSER_TRANSFER_SETUP_STORAGE_KEY);
  } catch {
    // Nothing to clean up.
  }
}

export function isBrowserTransferSetupRequest(
  value: unknown,
): value is BrowserTransferSetupRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const request = value as Record<string, unknown>;
  return (
    typeof request.id === "string" &&
    request.id.trim().length > 0 &&
    typeof request.devServerUrl === "string" &&
    normalizeHttpUrl(request.devServerUrl) !== null &&
    (request.groupTitle === undefined || typeof request.groupTitle === "string") &&
    typeof request.extensionInstallPath === "string" &&
    request.extensionInstallPath.trim().length > 0
  );
}

export function showBrowserTransferSetupPrompt(request: BrowserTransferSetupRequest): void {
  if (typeof window === "undefined") {
    return;
  }

  rememberBrowserTransferSetupRequest(request);
  window.dispatchEvent(
    new CustomEvent<BrowserTransferSetupRequest>(BROWSER_TRANSFER_SETUP_REQUEST_EVENT, {
      detail: request,
    }),
  );
}

export function isBrowserTransferResultMessage(
  value: unknown,
): value is BrowserTransferResultMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;
  return (
    message.source === BROWSER_TRANSFER_EXTENSION_SOURCE &&
    message.type === BROWSER_TRANSFER_RESULT_MESSAGE &&
    typeof message.id === "string" &&
    message.id.trim().length > 0 &&
    typeof message.ok === "boolean" &&
    (message.devTabId === undefined || typeof message.devTabId === "number") &&
    (message.groupId === undefined || typeof message.groupId === "number") &&
    (message.error === undefined || typeof message.error === "string")
  );
}

export function shouldShowTransferToBrowser(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: string;
  readonly primaryEnvironmentId: string | null;
  readonly hasDesktopBridge: boolean;
}): boolean {
  return (
    input.hasDesktopBridge &&
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}
