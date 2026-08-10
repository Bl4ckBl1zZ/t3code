import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useCallback, useMemo } from "react";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { primaryServerProvidersAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { T3_WORK_BACKING_PROJECT_ID, t3WorkDirectoryForEnvironment } from "../t3WorkProject";
import { createT3WorkBackingProject, resolveHermesDefaultModel } from "../t3WorkProjectCreate";
import { useNewThreadHandler } from "./useHandleNewThread";

export type StartHermesChatOutcome = "started" | "unavailable" | "failed";

export interface HermesChat {
  /**
   * The primary environment's server config has arrived, so `isReady` is a
   * final answer rather than "still loading". Surfaces that render a
   * not-ready state must wait for this or they flash it on every cold boot.
   */
  readonly isResolved: boolean;
  /** A ready Hermes instance and a T3 Work directory both exist. */
  readonly isReady: boolean;
  /**
   * Open a fresh Hermes composer on the T3 Work backing project, creating
   * that project first when this environment has not had one yet.
   */
  readonly start: (options?: { readonly replace?: boolean }) => Promise<StartHermesChatOutcome>;
}

/**
 * The Work and Chat workspaces both compose on Hermes against the T3 Work
 * backing project. Shared by every surface that opens that composer (command
 * palette, index landing) so they agree on readiness and on creating the
 * backing project on demand.
 */
export function useHermesChat(): HermesChat {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const projects = useProjects();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const handleNewThread = useNewThreadHandler();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  const hermesProviderEntry = useMemo<ProviderInstanceEntry | null>(
    () =>
      deriveProviderInstanceEntries(providers).find(
        (entry) =>
          entry.driverKind === "hermes" &&
          entry.enabled &&
          entry.isAvailable &&
          entry.status === "ready",
      ) ?? null,
    [providers],
  );
  const t3WorkDirectory = t3WorkDirectoryForEnvironment(serverConfigs, primaryEnvironmentId);
  const isResolved = primaryEnvironmentId === null || serverConfigs.has(primaryEnvironmentId);
  const isReady =
    primaryEnvironmentId !== null && t3WorkDirectory !== null && hermesProviderEntry !== null;

  const start = useCallback(
    async (options?: { readonly replace?: boolean }): Promise<StartHermesChatOutcome> => {
      const hermesModel =
        hermesProviderEntry === null ? null : resolveHermesDefaultModel(hermesProviderEntry);
      if (
        primaryEnvironmentId === null ||
        t3WorkDirectory === null ||
        !hermesProviderEntry ||
        !hermesModel
      ) {
        return "unavailable";
      }
      const existingBackingProject =
        projects.find(
          (project) =>
            project.environmentId === primaryEnvironmentId &&
            project.workspaceRoot === t3WorkDirectory,
        ) ?? null;
      if (existingBackingProject === null) {
        const outcome = await createT3WorkBackingProject({
          createProject,
          environmentId: primaryEnvironmentId,
          workspaceRoot: t3WorkDirectory,
          hermesProviderEntry,
        });
        // createT3WorkBackingProject already surfaced the failure toast; an
        // interrupted command is a retry the caller did not ask for.
        if (outcome !== "created") return "failed";
      }
      await handleNewThread(
        scopeProjectRef(
          primaryEnvironmentId,
          existingBackingProject?.id ?? T3_WORK_BACKING_PROJECT_ID,
        ),
        {
          fresh: true,
          ...(options?.replace === true ? { replace: true } : {}),
          modelSelection: {
            instanceId: hermesProviderEntry.instanceId,
            model: hermesModel.slug,
          },
        },
      );
      return "started";
    },
    [
      createProject,
      handleNewThread,
      hermesProviderEntry,
      primaryEnvironmentId,
      projects,
      t3WorkDirectory,
    ],
  );

  return useMemo(() => ({ isResolved, isReady, start }), [isReady, isResolved, start]);
}
