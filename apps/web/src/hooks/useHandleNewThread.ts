import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import { DEFAULT_RUNTIME_MODE, type ScopedProjectRef } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type DraftThreadEnvMode,
  type DraftThreadWorktreeMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { readEnvironmentApi } from "../environmentApi";
import { getProjectConfigNewThreadEnvMode, readProjectConfigFile } from "../projectConfigFile";
import { useServerConfigLoaded } from "../rpc/serverState";
import { useSettings } from "./useSettings";

function useNewThreadState() {
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const defaultThreadEnvMode = useSettings((settings) => settings.defaultThreadEnvMode);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        worktreeMode?: DraftThreadWorktreeMode;
        useProjectDefault?: boolean;
      },
    ): Promise<void> => {
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;

      const resolveProjectDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
        if (!project) {
          return defaultThreadEnvMode;
        }
        const api = readEnvironmentApi(project.environmentId);
        if (!api) {
          return defaultThreadEnvMode;
        }
        try {
          const config = await readProjectConfigFile(api, project.cwd);
          return getProjectConfigNewThreadEnvMode(config) ?? defaultThreadEnvMode;
        } catch {
          return defaultThreadEnvMode;
        }
      };

      return (async () => {
        const projectDefaultEnvMode =
          options?.useProjectDefault === true ? await resolveProjectDefaultEnvMode() : null;
        const hasProjectDefault = projectDefaultEnvMode !== null;
        const hasBranchOption = hasProjectDefault || options?.branch !== undefined;
        const hasWorktreePathOption = hasProjectDefault || options?.worktreePath !== undefined;
        const hasEnvModeOption = hasProjectDefault || options?.envMode !== undefined;
        const hasWorktreeModeOption = hasProjectDefault || options?.worktreeMode !== undefined;
        const nextBranch = hasProjectDefault ? null : (options?.branch ?? null);
        const nextWorktreePath = hasProjectDefault ? null : (options?.worktreePath ?? null);
        const nextEnvMode = projectDefaultEnvMode ?? options?.envMode;
        const nextWorktreeMode = hasProjectDefault ? "newBranch" : options?.worktreeMode;
        const buildDraftContextPatch = (): Parameters<typeof setDraftThreadContext>[1] => {
          const patch: Parameters<typeof setDraftThreadContext>[1] = {};
          if (hasBranchOption) {
            patch.branch = nextBranch;
          }
          if (hasWorktreePathOption) {
            patch.worktreePath = nextWorktreePath;
          }
          if (hasEnvModeOption && nextEnvMode !== undefined) {
            patch.envMode = nextEnvMode;
          }
          if (hasWorktreeModeOption && nextWorktreeMode !== undefined) {
            patch.worktreeMode = nextWorktreeMode;
          }
          return patch;
        };

        if (storedDraftThread) {
          if (
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasWorktreeModeOption
          ) {
            setDraftThreadContext(storedDraftThread.draftId, buildDraftContextPatch());
          }
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, storedDraftThread.draftId, {
            threadId: storedDraftThread.threadId,
          });
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === storedDraftThread.draftId
          ) {
            return;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: storedDraftThread.draftId },
          });
          return;
        }

        if (
          latestActiveDraftThread &&
          currentRouteTarget?.kind === "draft" &&
          latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
          latestActiveDraftThread.promotedTo == null
        ) {
          if (
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasWorktreeModeOption
          ) {
            setDraftThreadContext(currentRouteTarget.draftId, buildDraftContextPatch());
          }
          const logicalDraftPatch: Parameters<typeof setLogicalProjectDraftThreadId>[3] = {
            threadId: latestActiveDraftThread.threadId,
            createdAt: latestActiveDraftThread.createdAt,
            runtimeMode: latestActiveDraftThread.runtimeMode,
            interactionMode: latestActiveDraftThread.interactionMode,
          };
          if (hasBranchOption) {
            logicalDraftPatch.branch = nextBranch;
          }
          if (hasWorktreePathOption) {
            logicalDraftPatch.worktreePath = nextWorktreePath;
          }
          if (hasEnvModeOption && nextEnvMode !== undefined) {
            logicalDraftPatch.envMode = nextEnvMode;
          }
          if (hasWorktreeModeOption && nextWorktreeMode !== undefined) {
            logicalDraftPatch.worktreeMode = nextWorktreeMode;
          }
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            currentRouteTarget.draftId,
            logicalDraftPatch,
          );
          return;
        }

        const draftId = newDraftId();
        const threadId = newThreadId();
        const createdAt = new Date().toISOString();
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: nextBranch,
          worktreePath: nextWorktreePath,
          envMode: nextEnvMode ?? "local",
          worktreeMode: nextWorktreeMode ?? "newBranch",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(draftId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
        });
      })();
    },
    [defaultThreadEnvMode, getCurrentRouteTarget, projectGroupingSettings, router, projects],
  );
}

export function useNewThreadHandler() {
  const handleNewThread = useNewThreadState();

  return {
    handleNewThread,
  };
}

export function useHandleNewThread() {
  const localProjectOrder = useUiStateStore((store) => store.projectOrder);
  const syncedProjectOrder = useSettings((settings) => settings.sidebarProjectOrder);
  const serverConfigLoaded = useServerConfigLoaded();
  const projectOrder =
    serverConfigLoaded || syncedProjectOrder.length > 0 ? syncedProjectOrder : localProjectOrder;
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadState();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeThreadRef,
  };
}
