import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useCallback, useMemo } from "react";

import type { ProviderInstanceEntry } from "../providerInstances";
import { useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { primaryServerProvidersAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { T3_WORK_BACKING_PROJECT_ID, t3WorkDirectoryForEnvironment } from "../t3WorkProject";
import { createT3WorkBackingProject, resolveHermesDefaultModel } from "../t3WorkProjectCreate";
import {
  findReadyHermesEntry,
  resolveWorkEnvironmentScope,
  useWorkEnvironmentScopePreference,
} from "../workEnvironmentScope";
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

  // Work and Chat are scoped to one environment, and that scope is what the
  // sidebar menu persisted — composing from the palette or the landing has to
  // land on the same machine the sidebar is showing, not always the primary.
  const [storedWorkEnvironmentScopeId] = useWorkEnvironmentScopePreference();
  const targetEnvironmentId = useMemo(
    () =>
      resolveWorkEnvironmentScope({
        environments: [...serverConfigs.keys()].map((environmentId) => ({ environmentId })),
        serverConfigs,
        threadEnvironmentIds: new Set(),
        storedEnvironmentId: storedWorkEnvironmentScopeId,
        primaryEnvironmentId,
      }).scopeId ?? primaryEnvironmentId,
    [primaryEnvironmentId, serverConfigs, storedWorkEnvironmentScopeId],
  );

  const hermesProviderEntry = useMemo<ProviderInstanceEntry | null>(() => {
    const scopedProviders =
      targetEnvironmentId === null ? undefined : serverConfigs.get(targetEnvironmentId)?.providers;
    if (scopedProviders !== undefined) return findReadyHermesEntry(scopedProviders);
    if (targetEnvironmentId !== primaryEnvironmentId) return null;
    return findReadyHermesEntry(providers);
  }, [primaryEnvironmentId, providers, serverConfigs, targetEnvironmentId]);
  const t3WorkDirectory = t3WorkDirectoryForEnvironment(serverConfigs, targetEnvironmentId);
  const isResolved = primaryEnvironmentId === null || serverConfigs.has(primaryEnvironmentId);
  const isReady =
    targetEnvironmentId !== null && t3WorkDirectory !== null && hermesProviderEntry !== null;

  const start = useCallback(
    async (options?: { readonly replace?: boolean }): Promise<StartHermesChatOutcome> => {
      const hermesModel =
        hermesProviderEntry === null ? null : resolveHermesDefaultModel(hermesProviderEntry);
      if (
        targetEnvironmentId === null ||
        t3WorkDirectory === null ||
        !hermesProviderEntry ||
        !hermesModel
      ) {
        return "unavailable";
      }
      const existingBackingProject =
        projects.find(
          (project) =>
            project.environmentId === targetEnvironmentId &&
            project.workspaceRoot === t3WorkDirectory,
        ) ?? null;
      if (existingBackingProject === null) {
        const outcome = await createT3WorkBackingProject({
          createProject,
          environmentId: targetEnvironmentId,
          workspaceRoot: t3WorkDirectory,
          hermesProviderEntry,
        });
        // createT3WorkBackingProject already surfaced the failure toast; an
        // interrupted command is a retry the caller did not ask for.
        if (outcome !== "created") return "failed";
      }
      await handleNewThread(
        scopeProjectRef(
          targetEnvironmentId,
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
      projects,
      t3WorkDirectory,
      targetEnvironmentId,
    ],
  );

  return useMemo(() => ({ isResolved, isReady, start }), [isReady, isResolved, start]);
}
