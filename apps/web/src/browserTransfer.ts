import type { ProjectScript } from "@t3tools/contracts";

import { randomUUID } from "./lib/utils";
import { setPairingTokenOnUrl } from "./pairingUrl";

export const BROWSER_TRANSFER_FLAG_PARAM = "t3BrowserTransfer";
export const BROWSER_TRANSFER_ID_PARAM = "t3BrowserTransferId";
export const BROWSER_TRANSFER_DEV_SERVER_URL_PARAM = "t3DevServerUrl";
export const DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL = "http://localhost:3000/";

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
  readonly transferId?: string;
}): string {
  const baseUrl = new URL(input.t3CodeBaseUrl);
  const url = new URL(input.routePath || "/", baseUrl);
  const normalizedDevServerUrl =
    normalizeHttpUrl(input.devServerUrl) ?? DEFAULT_BROWSER_TRANSFER_DEV_SERVER_URL;

  url.searchParams.set(BROWSER_TRANSFER_FLAG_PARAM, "1");
  url.searchParams.set(BROWSER_TRANSFER_DEV_SERVER_URL_PARAM, normalizedDevServerUrl);
  url.searchParams.set(BROWSER_TRANSFER_ID_PARAM, input.transferId ?? randomUUID());

  return setPairingTokenOnUrl(url, input.pairingCredential).toString();
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
