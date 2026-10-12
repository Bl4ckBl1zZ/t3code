import type {
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { projectProviderInstanceOverride } from "@t3tools/shared/serverSettings";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { HERMES_DRIVER_KIND } from "../../t3WorkProject";

export type ProjectProviderChoice = "inherit" | "on" | "off";

export interface ProjectProviderRow {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  /** The project's own switch, or "mixed" when its checkouts disagree. */
  readonly choice: ProjectProviderChoice | "mixed";
  /** What the machine says, or "mixed" when the machines disagree. */
  readonly machineEnabled: boolean | "mixed";
}

export interface ProjectProviderTarget {
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly settings: Pick<
    ServerSettings,
    "providerInstances" | "providers" | "projectProviderInstanceOverrides"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
}

const merge = <A>(current: A | "mixed" | undefined, next: A): A | "mixed" =>
  current === undefined || current === next ? next : "mixed";

/**
 * One row per provider instance across a project's checkouts. Hermes stays
 * out: its rollout gate is machine-wide, so a project cannot turn it on.
 */
export function deriveProjectProviderRows(
  targets: ReadonlyArray<ProjectProviderTarget>,
): ReadonlyArray<ProjectProviderRow> {
  const rows = new Map<ProviderInstanceId, ProjectProviderRow>();
  for (const target of targets) {
    const entries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(
        deriveProviderInstanceEntries(target.providers),
        target.settings,
        null,
      ),
    );
    for (const entry of entries) {
      if (entry.driverKind === HERMES_DRIVER_KIND) continue;
      let row = rows.get(entry.instanceId);
      for (const projectId of target.projectIds) {
        const override = projectProviderInstanceOverride(
          target.settings,
          projectId,
          entry.instanceId,
        );
        const choice: ProjectProviderChoice =
          override === undefined ? "inherit" : override ? "on" : "off";
        row = {
          instanceId: entry.instanceId,
          displayName: row?.displayName ?? entry.displayName,
          choice: merge(row?.choice, choice),
          machineEnabled: merge(row?.machineEnabled, entry.enabled),
        };
      }
      if (row !== undefined) rows.set(entry.instanceId, row);
    }
  }
  return [...rows.values()];
}

/** Sparse per project and per instance, so other switches and checkouts stay as they are. */
export function projectProviderOverridePatch(
  projectIds: ReadonlyArray<ProjectId>,
  instanceId: ProviderInstanceId,
  choice: ProjectProviderChoice,
): ServerSettingsPatch {
  return {
    projectProviderInstanceOverrides: Object.fromEntries(
      projectIds.map((projectId) => [
        projectId,
        { [instanceId]: choice === "inherit" ? null : { enabled: choice === "on" } },
      ]),
    ),
  };
}
