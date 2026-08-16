import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

export type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

export function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.projects.length === 1 ? (onlyScope.projects[0] ?? null) : null;
}

export function findProjectByScopedKey(
  projectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
): EnvironmentProject | null {
  if (projectKey === null) {
    return null;
  }
  return (
    projects.find(
      (project) => scopedProjectKey(project.environmentId, project.id) === projectKey,
    ) ?? null
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
  rememberedProjectKey: string | null = null,
): DraftProjectSelectionResolution {
  if (findProjectByScopedKey(selectedProjectKey, projects) !== null) {
    return { kind: "preserve" };
  }

  // Entering the composer without a named project resumes the project the last
  // task was started in, so a new task does not ask the same question again.
  // A project that has since been removed falls through to the picker.
  const rememberedProject = findProjectByScopedKey(rememberedProjectKey, projects);
  if (rememberedProject !== null) {
    return { kind: "select", project: rememberedProject };
  }

  const onlyProject = getOnlySelectableProject(projectScopes);
  return onlyProject ? { kind: "select", project: onlyProject } : { kind: "pick" };
}
