import type {
  EnvironmentId,
  PreviewTarget,
  ProjectId,
  TerminalDetectedWebServer,
  ThreadId,
  WorkspaceId,
} from "@t3tools/contracts";

import { normalizePreviewUrl } from "./previewUrls";

export type WorkspacePreviewSelectionKind = "hidden" | "starting" | "ready" | "ambiguous";

export interface WorkspacePreviewSelection {
  readonly kind: WorkspacePreviewSelectionKind;
  readonly selectedTarget: PreviewTarget | null;
  readonly targets: readonly PreviewTarget[];
  readonly message: string;
}

interface PreviewTargetSelectionInput {
  readonly explicitPreviewUrl?: string | null | undefined;
  readonly targets: readonly PreviewTarget[];
  readonly activeProjectId: ProjectId;
  readonly activeWorkspaceId: WorkspaceId | null;
  readonly activeProjectCwd: string;
  readonly environmentId: EnvironmentId;
  readonly preferredScriptId?: string | null | undefined;
  readonly runningScriptIds?: ReadonlySet<string> | undefined;
  readonly hasStartingCandidate?: boolean | undefined;
  readonly now?: Date | undefined;
}

interface DetectedPreviewTargetInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly cwd: string;
  readonly terminalId: string;
  readonly threadId: ThreadId;
  readonly server: TerminalDetectedWebServer;
  readonly detectedAt: number;
  readonly scriptId?: string | undefined;
  readonly command?: string | undefined;
}

const STALE_TARGET_AGE_MS = 60_000;
const SOURCE_SCORE: Record<PreviewTarget["source"], number> = {
  explicit: 10_000,
  "process-listener": 1_000,
  "terminal-output": 900,
  "script-hint": 100,
  "framework-default": 10,
};

const PREVIEW_SCRIPT_PATTERN =
  /\b(?:dev|start|serve|preview|vite|next|astro|nuxt|remix|svelte-kit|storybook|webpack-dev-server|parcel|expo)\b/iu;

export function isPotentialPreviewScript(command: string): boolean {
  return PREVIEW_SCRIPT_PATTERN.test(command);
}

function parseTargetUrl(rawUrl: string): URL | null {
  try {
    return new URL(normalizePreviewUrl(rawUrl));
  } catch {
    return null;
  }
}

function previewTargetId(parts: readonly string[]): string {
  return parts.join(":");
}

function targetFreshnessStatus(
  detectedAt: number,
  now: number,
): Extract<PreviewTarget["status"], "reachable" | "stale"> {
  return now - detectedAt > STALE_TARGET_AGE_MS ? "stale" : "reachable";
}

export function explicitPreviewTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly cwd: string;
  readonly rawUrl: string;
  readonly now?: Date | undefined;
}): PreviewTarget | null {
  const url = parseTargetUrl(input.rawUrl);
  if (!url) {
    return null;
  }

  const nowIso = (input.now ?? new Date()).toISOString();
  const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }

  return {
    id: previewTargetId(["explicit", input.environmentId, input.workspaceId]),
    environmentId: input.environmentId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    url: url.toString(),
    host: url.hostname,
    port,
    status: "reachable",
    source: "explicit",
    confidence: 100,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    lastVerifiedAt: nowIso,
  };
}

export function detectedPreviewTarget(input: DetectedPreviewTargetInput): PreviewTarget {
  const detectedAtIso = new Date(input.detectedAt).toISOString();
  const now = Date.now();
  return {
    id: previewTargetId([
      "detected",
      input.environmentId,
      input.workspaceId,
      input.threadId,
      input.terminalId,
      String(input.server.port),
    ]),
    environmentId: input.environmentId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    url: input.server.url,
    host: input.server.host,
    port: input.server.port,
    status: input.server.verified ? targetFreshnessStatus(input.detectedAt, now) : "unreachable",
    source: "process-listener",
    confidence: input.server.verified ? 90 : 40,
    terminalId: input.terminalId,
    threadId: input.threadId,
    ...(input.scriptId ? { scriptId: input.scriptId } : {}),
    pid: input.server.pid,
    ...(input.command ? { command: input.command } : {}),
    firstSeenAt: detectedAtIso,
    lastSeenAt: detectedAtIso,
    ...(input.server.verified ? { lastVerifiedAt: detectedAtIso } : {}),
  };
}

function targetScore(
  target: PreviewTarget,
  input: Pick<PreviewTargetSelectionInput, "preferredScriptId" | "runningScriptIds">,
): number {
  let score = SOURCE_SCORE[target.source] + target.confidence;
  if (target.status === "reachable") {
    score += 500;
  } else if (target.status === "stale") {
    score -= 250;
  } else {
    score -= 1_000;
  }

  if (target.scriptId && input.preferredScriptId && target.scriptId === input.preferredScriptId) {
    score += 300;
  }
  if (target.scriptId && input.runningScriptIds?.has(target.scriptId)) {
    score += 150;
  }

  return score;
}

function sortPreviewTargets(
  targets: readonly PreviewTarget[],
  input: Pick<PreviewTargetSelectionInput, "preferredScriptId" | "runningScriptIds">,
): PreviewTarget[] {
  return targets.toSorted((left, right) => {
    const scoreDelta = targetScore(right, input) - targetScore(left, input);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const seenDelta = Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
    if (seenDelta !== 0) {
      return seenDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

export function selectWorkspacePreviewTarget(
  input: PreviewTargetSelectionInput,
): WorkspacePreviewSelection {
  const explicit =
    input.explicitPreviewUrl && input.activeWorkspaceId
      ? explicitPreviewTarget({
          environmentId: input.environmentId,
          projectId: input.activeProjectId,
          workspaceId: input.activeWorkspaceId,
          cwd: input.activeProjectCwd,
          rawUrl: input.explicitPreviewUrl,
          now: input.now,
        })
      : null;

  if (explicit) {
    return {
      kind: "ready",
      selectedTarget: explicit,
      targets: [explicit],
      message: `Open ${formatPreviewTargetUrl(explicit)}.`,
    };
  }

  const openableTargets = input.targets.filter(
    (target) =>
      target.projectId === input.activeProjectId &&
      target.status === "reachable" &&
      (input.activeWorkspaceId === null || target.workspaceId === input.activeWorkspaceId),
  );
  const sortedTargets = sortPreviewTargets(openableTargets, input);

  if (sortedTargets.length === 0) {
    if (input.hasStartingCandidate) {
      return {
        kind: "starting",
        selectedTarget: null,
        targets: [],
        message: "Waiting for a verified dev-server port.",
      };
    }
    return {
      kind: "hidden",
      selectedTarget: null,
      targets: [],
      message: "No preview target detected.",
    };
  }

  const selectedTarget = sortedTargets[0] ?? null;
  const nextTarget = sortedTargets[1] ?? null;
  if (
    selectedTarget &&
    nextTarget &&
    targetScore(selectedTarget, input) === targetScore(nextTarget, input)
  ) {
    return {
      kind: "ambiguous",
      selectedTarget: null,
      targets: sortedTargets,
      message: "Choose which detected dev server to preview.",
    };
  }

  return {
    kind: "ready",
    selectedTarget,
    targets: sortedTargets,
    message: selectedTarget
      ? `Open ${formatPreviewTargetUrl(selectedTarget)}.`
      : "No preview target detected.",
  };
}

export function formatPreviewTargetUrl(target: PreviewTarget): string {
  try {
    const url = new URL(target.url);
    const pathname = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${url.port ? `:${url.port}` : ""}${pathname}`;
  } catch {
    return target.url;
  }
}

export function previewTargetSourceLabel(source: PreviewTarget["source"]): string {
  if (source === "explicit") return "Configured";
  if (source === "process-listener") return "Detected process";
  if (source === "terminal-output") return "Terminal output";
  if (source === "script-hint") return "Script hint";
  return "Framework default";
}
