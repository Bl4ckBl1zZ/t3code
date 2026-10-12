/**
 * Removes `projectProviderInstanceOverrides` entries whose project no longer
 * exists.
 *
 * `ProjectService.delete` clears a project's entry as part of deleting it, but
 * a project deleted by an older server, or one whose cleanup write failed,
 * leaves its override behind. `ProviderInstanceRegistryHydration` folds every
 * project's override in, so a machine-disabled instance the override turned on
 * would stay probed and alive forever, with no UI left to turn it off.
 *
 * Runs once at boot; the settings watcher's normal reconcile picks up whatever
 * it clears.
 *
 * @module provider/ProjectProviderOverrideSweep
 */
import type { ProjectId, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Pure so the orphan rule can be tested without layers. */
export const findOrphanedProjectIds = (
  settings: Pick<ServerSettings, "projectProviderInstanceOverrides">,
  liveProjectIds: ReadonlySet<ProjectId>,
): ReadonlyArray<ProjectId> =>
  Object.keys(settings.projectProviderInstanceOverrides)
    .map((projectId) => projectId as ProjectId)
    .filter((projectId) => !liveProjectIds.has(projectId));

/** Best effort: a failed read or write must not block startup; the next boot retries. */
export const sweep = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const projects = yield* ProjectionProjects.ProjectionProjectRepository;

  const settings = yield* serverSettings.getSettings;
  if (Object.keys(settings.projectProviderInstanceOverrides).length === 0) return;
  const rows = yield* projects.listAll();
  const liveProjectIds = new Set(
    rows.filter((row) => row.deletedAt === null).map((row) => row.projectId),
  );

  const orphanedProjectIds = findOrphanedProjectIds(settings, liveProjectIds);
  if (orphanedProjectIds.length === 0) return;

  yield* serverSettings.updateSettings({
    projectProviderInstanceOverrides: Object.fromEntries(
      orphanedProjectIds.map((projectId) => [projectId, null]),
    ),
  });
}).pipe(
  Effect.asVoid,
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to sweep orphaned project provider overrides.", cause),
  ),
);
