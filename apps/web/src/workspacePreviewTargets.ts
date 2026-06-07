import {
  PreviewTarget as PreviewTargetSchema,
  type EnvironmentId,
  type PreviewTarget,
  type ProjectId,
  type ThreadId,
  type WorkspaceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const WORKSPACE_PREVIEW_TARGETS_STORAGE_KEY = "t3code.workspacePreviewTargets.v1";
export const WorkspacePreviewTargetsByIdSchema = Schema.Record(Schema.String, PreviewTargetSchema);
export type WorkspacePreviewTargetsById = typeof WorkspacePreviewTargetsByIdSchema.Type;

const MAX_STORED_PREVIEW_TARGET_AGE_MS = 24 * 60 * 60 * 1_000;

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestIso(left: string, right: string): string {
  return timestamp(left) >= timestamp(right) ? left : right;
}

export function upsertWorkspacePreviewTarget(
  targetsById: WorkspacePreviewTargetsById,
  target: PreviewTarget,
): WorkspacePreviewTargetsById {
  const existing = targetsById[target.id];
  return {
    ...targetsById,
    [target.id]: {
      ...target,
      firstSeenAt: existing?.firstSeenAt ?? target.firstSeenAt,
      lastSeenAt: existing ? newestIso(existing.lastSeenAt, target.lastSeenAt) : target.lastSeenAt,
      lastVerifiedAt:
        target.lastVerifiedAt ??
        (existing?.status === "reachable" ? existing.lastVerifiedAt : undefined),
    },
  };
}

export function markWorkspacePreviewTargetsStaleForTerminal(
  targetsById: WorkspacePreviewTargetsById,
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly terminalId: string;
    readonly now?: Date | undefined;
  },
): WorkspacePreviewTargetsById {
  let changed = false;
  const nowIso = (input.now ?? new Date()).toISOString();
  const nextEntries = Object.entries(targetsById).map(([targetId, target]) => {
    if (
      target.environmentId !== input.environmentId ||
      target.threadId !== input.threadId ||
      target.terminalId !== input.terminalId ||
      target.status === "stale"
    ) {
      return [targetId, target] as const;
    }
    changed = true;
    return [
      targetId,
      {
        ...target,
        status: "stale" as const,
        lastSeenAt: nowIso,
      },
    ] as const;
  });

  return changed ? Object.fromEntries(nextEntries) : targetsById;
}

export function pruneWorkspacePreviewTargets(
  targetsById: WorkspacePreviewTargetsById,
  input: {
    readonly now?: Date | undefined;
    readonly maxAgeMs?: number | undefined;
  } = {},
): WorkspacePreviewTargetsById {
  const now = (input.now ?? new Date()).getTime();
  const maxAgeMs = input.maxAgeMs ?? MAX_STORED_PREVIEW_TARGET_AGE_MS;
  const nextEntries = Object.entries(targetsById).filter(([, target]) => {
    if (target.status === "reachable" || target.status === "starting") {
      return true;
    }
    return now - timestamp(target.lastSeenAt) <= maxAgeMs;
  });

  return nextEntries.length === Object.keys(targetsById).length
    ? targetsById
    : Object.fromEntries(nextEntries);
}

export function workspacePreviewTargetsForScope(
  targetsById: WorkspacePreviewTargetsById,
  input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
  },
): PreviewTarget[] {
  return Object.values(targetsById).filter(
    (target) =>
      target.environmentId === input.environmentId &&
      target.projectId === input.projectId &&
      target.workspaceId === input.workspaceId,
  );
}

export function findWorkspacePreviewTargetForTerminal(
  targetsById: WorkspacePreviewTargetsById,
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly terminalId: string;
  },
): PreviewTarget | null {
  return (
    Object.values(targetsById).find(
      (target) =>
        target.environmentId === input.environmentId &&
        target.threadId === input.threadId &&
        target.terminalId === input.terminalId,
    ) ?? null
  );
}
