import type { EnvironmentId, ProjectScript } from "@t3tools/contracts";

export const DEFAULT_BROWSER_AGENT_DEV_SERVER_URL = "http://localhost:3000/";

const PORT_PATTERNS = [
  /(?:^|\s)(?:--port|-p)\s+(\d{2,5})\b/,
  /(?:^|\s)(?:--port|-p)=(\d{2,5})\b/,
  /(?:^|\s)(?:PORT|VITE_PORT)=(\d{2,5})\b/,
] as const;

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

export function inferBrowserAgentDevServerUrl(
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
    return DEFAULT_BROWSER_AGENT_DEV_SERVER_URL;
  }

  return DEFAULT_BROWSER_AGENT_DEV_SERVER_URL;
}

export function shouldShowBrowserAgentControls(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}
