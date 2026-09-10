import {
  resolveProjectScripts,
  projectScriptsInheritDefaults,
} from "@t3tools/shared/projectScripts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
import { ProjectAutoPullSettings, ProjectBrowserAccessSettings } from "./ProjectBooleanSettings";
import type { ProjectIconOverride } from "@t3tools/contracts";
import { environmentServerConfigsAtom } from "../../state/server";
import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import type {
  EnvironmentId,
  ContextMenuItem,
  ModelSelection,
  ProviderDriverKind,
  SidebarProjectGroupingMode,
  T3ProjectFileScript,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { createModelSelection } from "@t3tools/shared/model";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, CopyIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import {
  useClientSettings,
  useUpdateClientSettings,
  useEnvironmentSettings,
} from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { shortcutLabelForCommand } from "../../keybindings";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import { commandForProjectScript } from "../../projectScripts";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";

export const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

/** Logical project groups for the settings page, sorted by display name. */
export function useSettingsProjectGroups(): SidebarProjectSnapshot[] {
  const projects = useProjects();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  return useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [environmentLabelById, primaryEnvironmentId, projectGroupingSettings, projects],
  );
}

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

export function ProjectSettingsPage({ projectKey }: { projectKey: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      navigateBackWithinApp();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <ProjectSettingsBreadcrumb projectKey={projectKey} />
        </WorkspacePageHeader>
        <ProjectSettingsPanel projectKey={projectKey} />
      </div>
    </SidebarInset>
  );
}

function ProjectSettingsBreadcrumb({ projectKey }: { projectKey: string }) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();
  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const openProjectMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const api = readLocalApi();
    if (!api) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const items: ContextMenuItem<string>[] = groups.map((group) => ({
      id: group.projectKey,
      label: group.displayName,
    }));
    void settlePromise(() =>
      api.contextMenu.show(items, { x: rect.left, y: rect.bottom + 4 }),
    ).then((clicked) => {
      if (clicked._tag === "Failure" || clicked.value === null) return;
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey: clicked.value },
        replace: true,
        hashScrollIntoView: false,
      });
    });
  };

  return (
    <WorkspaceBreadcrumb ariaLabel="Project settings breadcrumb">
      <WorkspaceBreadcrumbItem>Projects</WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
      <WorkspaceBreadcrumbItem current>
        {selected ? (
          <button
            type="button"
            aria-haspopup="menu"
            aria-label="Switch project"
            onClick={openProjectMenu}
            className="group/project-title inline-flex min-w-0 max-w-64 cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 truncate">{selected.displayName}</span>
            <ChevronDownIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/project-title:opacity-100 group-focus-visible/project-title:opacity-100"
            />
          </button>
        ) : (
          <span className="truncate text-muted-foreground">Unavailable project</span>
        )}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
}) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members = useMemo(
    () =>
      selected?.memberProjects.filter(
        (member) => environmentId === null || member.environmentId === environmentId,
      ) ?? [],
    [selected, environmentId],
  );

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{
    key: string;
    environmentId: EnvironmentId | null;
    memberKeys: string[];
  } | null>(null);
  useEffect(() => {
    if (!selected || members.length === 0) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      environmentId,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
  }, [selected, members, environmentId]);

  // A grouping-rule change replaces the group key mid-visit; follow the
  // project to its new key instead of parking on the not-found state.
  useEffect(() => {
    if (members.length > 0) return;
    const last = lastSelectionRef.current;
    if (last?.key !== projectKey || last.environmentId !== environmentId) return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: "/settings/projects",
        search: { project: successor.projectKey, machine: environmentId ?? undefined },
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, projectKey, members.length, environmentId]);

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This project has no checkout on this machine.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail key={`${selected.projectKey}:${environmentId ?? "all"}`} group={scopedGroup} />
  );
}

function ProjectDetail({ group }: { group: SidebarProjectSnapshot }) {
  const allServerConfigs = useAtomValue(environmentServerConfigsAtom);
  const representative =
    group.memberProjects.find((member) => allServerConfigs.has(member.environmentId)) ??
    group.memberProjects[0]!;
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useEnvironmentSettings(representative.environmentId);
  const updateClientSettings = useUpdateClientSettings();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(representative.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });

  const projectNameEditedRef = useRef(false);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const supportsProjectIcons = group.memberProjects.every(
    (member) =>
      allServerConfigs.get(member.environmentId)?.environment.capabilities.projectIcons === true,
  );
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const threadCountByMember = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        defaultModelSelection: ModelSelection | null;
        defaultThreadEnvMode: ThreadEnvMode | null;
        faviconPath: string | null;
        projectIcon: ProjectIconOverride | null;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [group.memberProjects, reportFailure, updateProject],
  );

  const renameGroup = useCallback(
    async (nextTitle: string, wasEdited: boolean) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (
        !projectGroupTitleNeedsUpdate(
          group.memberProjects.map((member) => member.title),
          title,
          wasEdited,
        )
      ) {
        return;
      }
      await updateAllMembers({ title }, "Failed to rename project");
    },
    [group.memberProjects, updateAllMembers],
  );

  // ----- default model -----
  const storedSelection = representative.defaultModelSelection;
  const resolvedSelection = resolveDefaultProviderModelSelection(
    serverProviders,
    storedSelection ?? settings.defaultModelSelection,
  );
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === resolvedSelection?.instanceId,
  );
  const setDefaultModel = useCallback(
    (selection: ModelSelection | null) => {
      if (selection) {
        for (const member of group.memberProjects) {
          const config = allServerConfigs.get(member.environmentId);
          const entry =
            config &&
            applyProviderInstanceSettings(
              deriveProviderInstanceEntries(config.providers),
              config.settings,
            ).find((candidate) => candidate.instanceId === selection.instanceId);
          const options =
            config &&
            getCustomModelOptionsByInstance(
              { ...settings, ...config.settings },
              config.providers,
            ).get(selection.instanceId);
          if (
            !entry?.enabled ||
            !entry.isAvailable ||
            !options?.some((option) => option.slug === selection.model && !option.isUnavailable)
          ) {
            toastManager.add({
              type: "error",
              title: "Default model not saved",
              description: `This model is unavailable on ${member.environmentLabel ?? "one of this project's machines"}. Select that machine to configure its default separately.`,
            });
            return;
          }
        }
      }
      void updateAllMembers({ defaultModelSelection: selection }, "Failed to update default model");
    },
    [allServerConfigs, group.memberProjects, settings, updateAllMembers],
  );

  // ----- new-thread workspace mode -----
  const storedEnvMode = representative.defaultThreadEnvMode ?? null;
  const setDefaultThreadEnvMode = useCallback(
    (mode: ThreadEnvMode | null) =>
      void updateAllMembers(
        { defaultThreadEnvMode: mode },
        "Failed to update new-thread workspace",
      ),
    [updateAllMembers],
  );

  // ----- favicon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setFaviconPath = useCallback(
    async (faviconPath: string | null, projectIcon: ProjectIconOverride | null = null) => {
      if (savingFaviconRef.current) return;
      savingFaviconRef.current = true;
      setIsSavingFavicon(true);
      try {
        await updateAllMembers(
          { faviconPath, ...(supportsProjectIcons ? { projectIcon } : {}) },
          "Failed to update project icon",
        );
      } finally {
        savingFaviconRef.current = false;
        setIsSavingFavicon(false);
      }
    },
    [updateAllMembers, supportsProjectIcons],
  );

  // ----- checkout selection and scripts -----
  const [selectedCheckoutKey, setSelectedCheckoutKey] = useState(representative.physicalProjectKey);
  const selectedCheckout =
    group.memberProjects.find((member) => member.physicalProjectKey === selectedCheckoutKey) ??
    representative;
  const selectedServerConfig = useAtomValue(
    serverEnvironment.configValueAtom(selectedCheckout.environmentId),
  );
  const keybindings = selectedServerConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const scriptSettings = selectedServerConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const supportsActionDefaults =
    selectedServerConfig?.environment.capabilities.projectActionDefaults === true;
  const scripts = supportsActionDefaults
    ? resolveProjectScripts(scriptSettings, selectedCheckout)
    : selectedCheckout.scripts;
  const scriptsInherited =
    supportsActionDefaults && projectScriptsInheritDefaults(scriptSettings, selectedCheckout);
  const {
    saving: isSavingScripts,
    persist: persistScripts,
    submit: submitScript,
  } = useProjectScriptSettings(
    selectedServerConfig
      ? [
          {
            environmentId: selectedCheckout.environmentId,
            settings: scriptSettings,
            keybindings,
            project: selectedCheckout,
            supportsDefaults: supportsActionDefaults,
          },
        ]
      : [],
  );
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const t3File = useT3ProjectFileState(
    selectedCheckout.environmentId,
    selectedCheckout.workspaceRoot,
  );
  // What the "Default" option resolves to while no override is set: the
  // repo's t3.json value when present, otherwise the global setting.
  const inheritedEnvMode = t3File.file?.defaultThreadEnvMode ?? settings.defaultThreadEnvMode;
  const inheritedEnvModeSource = t3File.file?.defaultThreadEnvMode != null ? "t3.json" : "global";
  const importableScripts = useMemo(
    () =>
      t3File.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, t3File.scripts],
  );

  const deleteScript = (scriptId: string) =>
    void persistScripts(
      (current) => current.filter((script) => script.id !== scriptId),
      scriptId,
      null,
    );

  const importFileScript = useCallback(
    async (fileScript: T3ProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        runOnWorktreeDelete: fileScript.runOnWorktreeDelete ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
        singleRun: fileScript.singleRun ?? false,
      };
      const result = await submitScript(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setEditorRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : "Failed to import action.",
        });
      }
    },
    [submitScript],
  );

  // ----- checkouts -----
  const updateGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateClientSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateClientSettings],
  );

  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? group.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            projectThreads.length > 0
              ? `Remove project "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`
              : `Remove project "${targetLabel}"?`,
            ...(singleMember
              ? [
                  `Path: ${singleMember.workspaceRoot}`,
                  ...(singleMember.environmentLabel
                    ? [`Environment: ${singleMember.environmentLabel}`]
                    : []),
                ]
              : [`This removes ${members.length} grouped project entries.`]),
            ...(projectThreads.length > 0
              ? [
                  "This permanently clears conversation history for those threads and any archived threads.",
                ]
              : ["This permanently clears any archived conversation history."]),
            isWholeGroup
              ? "This removes only the project entries, not the files on disk."
              : "Other entries in this grouped project are unaffected.",
            "This action cannot be undone.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const result = mapAtomCommandResult(
          await deleteProject({
            environmentId: member.environmentId,
            input: {
              projectId: member.id,
              force: true,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          reportFailure(`Failed to remove "${member.title}"`, result);
          return;
        }
        const projectRef = scopeProjectRef(member.environmentId, member.id);
        releaseProjectDraftUploads(projectRef);
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      // The project's settings page just deleted itself; there is no projects
      // listing to fall back to, so leave settings entirely.
      if (isWholeGroup) {
        void navigate({ to: "/", replace: true });
      }
    },
    [
      deleteProject,
      group.displayName,
      group.memberProjects.length,
      navigate,
      reportFailure,
      threads,
    ],
  );

  const selectedCheckoutThreadCount = threadCountByMember.get(memberKey(selectedCheckout)) ?? 0;
  const selectedCheckoutGrouping =
    projectGroupingSettings.sidebarProjectGroupingOverrides?.[
      deriveProjectGroupingOverrideKey(selectedCheckout)
    ] ?? "inherit";
  const selectedCheckoutLabel = selectedCheckout.environmentLabel ?? "This machine";

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection title="Project">
          <SettingsRow
            title="Name"
            description="The shared name for this project group in the sidebar and thread lists."
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                className="w-full sm:w-64"
                aria-label="Project name"
                defaultValue={group.displayName}
                onChange={() => {
                  projectNameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  const wasEdited = projectNameEditedRef.current;
                  projectNameEditedRef.current = false;
                  void renameGroup(event.currentTarget.value, wasEdited);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Project icon"
            description={
              projectIcon?.kind === "emoji"
                ? projectIcon.emoji
                : projectIcon?.kind === "lucide"
                  ? `${projectIcon.name} · ${projectIcon.color}`
                  : (faviconPath ?? "Automatic")
            }
            resetAction={
              faviconPath !== null || projectIcon !== null ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon || (projectIcon !== null && !supportsProjectIcons)}
                  onClick={() => void setFaviconPath(null)}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon
                  project={representative}
                  environmentId={representative.environmentId}
                  cwd={representative.workspaceRoot}
                  faviconPath={faviconPath}
                  className="size-6"
                />
                {supportsProjectIcons && (
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    disabled={isSavingFavicon}
                    onClick={() => setIconPickerOpen(true)}
                  >
                    Choose icon
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon file"
                  disabled={isSavingFavicon}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
        </SettingsSection>

        <SettingsSection title="New threads">
          <SettingsRow
            title="Model"
            description="New threads in this project start with this model. Applies to every checkout in this group."
            resetAction={
              storedSelection !== null ? (
                <SettingResetButton
                  label="project default model"
                  onClick={() => setDefaultModel(null)}
                />
              ) : null
            }
            control={
              resolvedSelection && activeEntry ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={resolvedSelection.instanceId}
                    model={resolvedSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onInstanceModelChange={(instanceId, model) => {
                      setDefaultModel(createModelSelection(instanceId, model));
                    }}
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind as ProviderDriverKind}
                    models={activeEntry.models}
                    model={resolvedSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={resolvedSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={settings.planModeEnabled}
                    triggerVariant="outline"
                    triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                    onModelOptionsChange={(nextOptions) => {
                      setDefaultModel(
                        createModelSelection(
                          resolvedSelection.instanceId,
                          resolvedSelection.model,
                          nextOptions,
                        ),
                      );
                    }}
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
          <ProjectAutoPullSettings projects={group.memberProjects} />
          <ProjectBrowserAccessSettings projects={group.memberProjects} />
          <SettingsRow
            title="Workspace"
            description="Where new threads in this project start. Overrides t3.json and the global default; applies to every checkout in this group."
            resetAction={
              storedEnvMode !== null ? (
                <SettingResetButton
                  label="project workspace default"
                  onClick={() => setDefaultThreadEnvMode(null)}
                />
              ) : null
            }
            control={
              <Select
                value={storedEnvMode ?? "inherit"}
                onValueChange={(value) => {
                  if (value === "worktree" || value === "local") {
                    setDefaultThreadEnvMode(value);
                  } else if (value === "inherit") {
                    setDefaultThreadEnvMode(null);
                  }
                }}
              >
                <SelectTrigger aria-label="New-thread workspace">
                  <SelectValue>
                    {storedEnvMode === null
                      ? group.memberProjects.length > 1
                        ? "Default (per checkout)"
                        : `Default (${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`
                      : resolveEnvModeLabel(storedEnvMode)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">
                    {group.memberProjects.length > 1
                      ? "Default (each checkout's t3.json or global setting)"
                      : `Default (${inheritedEnvModeSource}: ${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`}
                  </SelectItem>
                  <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                  <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>

        <SettingsSection
          title="Checkout"
          headerAction={
            <Select
              value={selectedCheckout.physicalProjectKey}
              onValueChange={(value) => setSelectedCheckoutKey(String(value))}
            >
              <SelectTrigger className="max-w-64" aria-label="Selected checkout">
                <SelectValue>{selectedCheckoutLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {group.memberProjects.map((member) => (
                  <SelectItem
                    key={member.physicalProjectKey}
                    hideIndicator
                    value={member.physicalProjectKey}
                  >
                    {member.environmentLabel ?? "This machine"} · {member.workspaceRoot}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        >
          <div className="px-3 py-2 sm:px-4">
            <div className="flex min-w-0 items-center rounded-lg bg-muted/30 p-1 text-base text-muted-foreground sm:text-sm">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      aria-label="Copy checkout path"
                      className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      type="button"
                      onClick={() =>
                        copyPathToClipboard(selectedCheckout.workspaceRoot, {
                          path: selectedCheckout.workspaceRoot,
                        })
                      }
                    >
                      <code className="min-w-0 flex-1 truncate font-mono">
                        {selectedCheckout.workspaceRoot}
                      </code>
                      <CopyIcon className="size-4 shrink-0 opacity-60 group-hover:opacity-100" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Copy path</TooltipPopup>
              </Tooltip>
              <div className="shrink-0 border-l border-border/60 px-2 tabular-nums">
                {selectedCheckoutThreadCount === 1
                  ? "1 thread"
                  : `${selectedCheckoutThreadCount} threads`}
              </div>
            </div>
          </div>
          <SettingsRow
            title="Project grouping"
            description="How this checkout joins project groups in the sidebar. Changing it can move you to a different project group."
            control={
              <Select
                value={selectedCheckoutGrouping}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    updateGroupingPreference(selectedCheckout, value);
                  }
                }}
              >
                <SelectTrigger aria-label={`Grouping rule for ${selectedCheckoutLabel}`}>
                  <SelectValue>
                    {selectedCheckoutGrouping === "inherit"
                      ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[selectedCheckoutGrouping]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    Use global default
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          {group.memberProjects.length > 1 ? (
            <SettingsRow
              title="Remove checkout"
              description="Removes this checkout and its threads from the project group. Files on disk are not touched."
              control={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  onClick={() => void removeMembers([selectedCheckout])}
                >
                  <Trash2Icon className="size-3.5" />
                  Remove checkout
                </Button>
              }
            />
          ) : null}
          <div className="flex min-h-8 flex-col items-start gap-3 px-3 pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-foreground">Actions</h3>
              <p className="text-pretty text-sm text-muted-foreground">
                {scriptsInherited
                  ? "Inherits this machine’s default actions."
                  : `Saved for ${selectedCheckoutLabel}.`}{" "}
                Commands run in this checkout or its worktree.
              </p>
            </div>
            <div className="flex w-full flex-wrap gap-1.5 sm:w-auto sm:shrink-0 sm:justify-end">
              {supportsActionDefaults && !scriptsInherited ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={isSavingScripts}
                  onClick={() => void persistScripts(() => null)}
                >
                  Use machine defaults
                </Button>
              ) : null}
              {importableScripts.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="xs" variant="ghost" disabled={isSavingScripts} type="button" />
                    }
                  >
                    Import scripts
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="w-72">
                    <MenuGroup>
                      <MenuGroupLabel>Import from t3.json</MenuGroupLabel>
                      <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                        Add actions declared by this checkout without editing them first.
                      </p>
                    </MenuGroup>
                    <MenuSeparator />
                    {importableScripts.map((fileScript) => (
                      <MenuItem
                        key={`${fileScript.name} ${fileScript.command}`}
                        onClick={() => void importFileScript(fileScript)}
                      >
                        <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{fileScript.name}</div>
                          <div className="truncate font-mono text-muted-foreground">
                            {fileScript.command}
                          </div>
                        </div>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={isSavingScripts}
                onClick={() =>
                  setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })
                }
              >
                <PlusIcon className="size-3.5" />
                Add action
              </Button>
            </div>
          </div>
          {scripts.length === 0 ? (
            <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
              No actions configured for this checkout.
            </p>
          ) : (
            scripts.map((script) => {
              const shortcutLabel = shortcutLabelForCommand(
                keybindings,
                commandForProjectScript(script.id),
              );
              return (
                <SettingsRow
                  key={script.id}
                  className="group py-2"
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <ScriptIcon
                        icon={script.icon}
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="max-w-40 shrink-0 truncate">{script.name}</span>
                      <code className="min-w-0 flex-1 truncate font-mono font-normal text-muted-foreground">
                        {script.command}
                      </code>
                      {script.runOnWorktreeCreate ? (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground">
                          setup
                        </span>
                      ) : null}
                      {script.previewUrl ? (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground max-sm:hidden">
                          preview · desktop only
                        </span>
                      ) : null}
                    </span>
                  }
                  control={
                    <>
                      {shortcutLabel ? (
                        <span className="text-xs text-muted-foreground">{shortcutLabel}</span>
                      ) : null}
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                        aria-label={`Edit ${script.name}`}
                        disabled={isSavingScripts}
                        onClick={() =>
                          setEditorRequest(editorRequestForScript(script, keybindings))
                        }
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </>
                  }
                />
              );
            })
          )}
          {t3File.status === "invalid" ? (
            <SettingsRow
              title="t3.json is invalid"
              description="A t3.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values."
              className="text-warning"
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title="Danger">
          <SettingsRow
            title={
              group.memberProjects.length > 1 ? "Remove this project everywhere" : "Remove project"
            }
            description={
              group.memberProjects.length > 1
                ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
                : "Deletes the project entry and its threads. Files on disk are not touched."
            }
            control={
              <Button
                variant="destructive-outline"
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {group.memberProjects.length > 1 ? "Remove all entries" : "Remove project"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={deleteScript}
        onClose={() => setEditorRequest(null)}
      />
      {supportsProjectIcons && (
        <ProjectIconPickerDialog
          current={projectIcon}
          open={iconPickerOpen}
          onOpenChange={setIconPickerOpen}
          onSelect={(icon) => void setFaviconPath(null, icon)}
        />
      )}
      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setFaviconPath(path)}
        open={faviconPickerOpen}
        projectName={group.displayName}
      />
    </>
  );
}
