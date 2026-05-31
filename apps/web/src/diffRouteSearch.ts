import { TurnId } from "@t3tools/contracts";

export const PLAN_SIDE_PANEL_SEARCH_VALUE = "plan";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  sidePanel?: typeof PLAN_SIDE_PANEL_SEARCH_VALUE | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function isPlanSidePanelValue(value: unknown): boolean {
  return value === PLAN_SIDE_PANEL_SEARCH_VALUE;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function stripSidePanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "sidePanel"> {
  const { sidePanel: _sidePanel, ...rest } = params;
  return rest as Omit<T, "sidePanel">;
}

export function stripRightPanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "sidePanel"> {
  const {
    diff: _diff,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    sidePanel: _sidePanel,
    ...rest
  } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "sidePanel">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const sidePanel =
    !diff && isPlanSidePanelValue(search.sidePanel) ? PLAN_SIDE_PANEL_SEARCH_VALUE : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(sidePanel ? { sidePanel } : {}),
  };
}
