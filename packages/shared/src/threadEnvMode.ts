import type { ThreadEnvMode } from "@t3tools/contracts";

import { normalizeProjectPathForComparison } from "./path.ts";

/**
 * Canonical priority order for a project's default thread env mode:
 * per-project setting > checked-in t3.json > global server setting.
 *
 * An explicit composer pick outranks all of these; callers apply it before
 * consulting the defaults. Web resolves the sources imperatively at draft
 * creation, mobile reactively — both must route through this function so the
 * platforms cannot disagree on the order.
 */
export function resolveDefaultThreadEnvMode(sources: {
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly projectFile: ThreadEnvMode | null | undefined;
  readonly globalDefault: ThreadEnvMode;
}): ThreadEnvMode {
  return sources.projectSetting ?? sources.projectFile ?? sources.globalDefault;
}

/**
 * The workspace mode a new thread starts in. A project the environment made
 * from just a name (a folder directly inside `ServerConfig.newProjectsRoot`)
 * has only its first commit, so until it has a thread, a new thread works in
 * the project checkout even when the global default is a new worktree. Only
 * that global default is replaced: a project setting or a t3.json still wins
 * (the scaffold writes no t3.json).
 */
export function resolveNewThreadEnvMode(input: {
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly projectFile: ThreadEnvMode | null | undefined;
  readonly globalDefault: ThreadEnvMode;
  readonly workspaceRoot: string | null;
  readonly newProjectsRoot: string | null | undefined;
  readonly projectHasThreads: boolean;
}): ThreadEnvMode {
  const configured = resolveDefaultThreadEnvMode(input);
  if (
    configured === "local" ||
    input.projectSetting != null ||
    input.projectFile != null ||
    input.projectHasThreads ||
    input.workspaceRoot === null ||
    input.newProjectsRoot == null
  ) {
    return configured;
  }
  const root = normalizeProjectPathForComparison(input.newProjectsRoot);
  const folder = normalizeProjectPathForComparison(input.workspaceRoot);
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  const isNewProjectFolder =
    folder.startsWith(prefix) &&
    folder.length > prefix.length &&
    !folder.slice(prefix.length).includes(separator);
  return isNewProjectFolder ? "local" : configured;
}

/**
 * True once the resolved default can no longer change: an explicit pick or a
 * source that outranks t3.json decided, or the file read settled. While
 * false, nothing may persist the provisional default (for example into a
 * draft's workspace selection) — it could differ from the final value.
 */
export function isDefaultThreadEnvModeSettled(sources: {
  readonly explicitMode: ThreadEnvMode | undefined;
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly projectFilePending: boolean;
}): boolean {
  return (
    sources.explicitMode !== undefined ||
    sources.projectSetting != null ||
    !sources.projectFilePending
  );
}
