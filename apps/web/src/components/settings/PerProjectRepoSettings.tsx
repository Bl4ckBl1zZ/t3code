import { scopeProjectRef } from "@t3tools/client-runtime";
import type { ProjectId, ThreadEnvMode } from "@t3tools/contracts";
import { FolderGit2Icon, LoaderIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { normalizeBrowserAgentPreviewUrl } from "../../browserAgents";
import { readEnvironmentApi } from "../../environmentApi";
import { newCommandId } from "../../lib/utils";
import {
  buildScriptsWithWorktreeSetupCommand,
  getProjectConfigBrowserPreviewUrl,
  getProjectConfigNewThreadEnvMode,
  getWorktreeSetupCommand,
  readProjectConfigFile,
  setProjectConfigBrowserPreviewUrl,
  setProjectConfigNewThreadEnvMode,
  updateProjectConfigFile,
  writeProjectConfigScripts,
} from "../../projectConfigFile";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ProjectFavicon } from "../ProjectFavicon";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type NewThreadModeSelection = "global" | ThreadEnvMode;

const NEW_THREAD_MODE_LABELS = {
  global: "Use global default",
  local: "Checkout",
  worktree: "New workspace",
} satisfies Record<NewThreadModeSelection, string>;

function projectSelectValue(project: Project): string {
  return `${project.environmentId}\u0000${project.id}`;
}

function sortProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort((left, right) => {
    const leftName = left.name.toLocaleLowerCase();
    const rightName = right.name.toLocaleLowerCase();
    if (leftName !== rightName) return leftName.localeCompare(rightName);
    return left.cwd.localeCompare(right.cwd);
  });
}

function projectDisplayName(project: Project): string {
  return project.repositoryIdentity?.displayName ?? project.name;
}

function readEnvironmentApiOrThrow(project: Project) {
  const api = readEnvironmentApi(project.environmentId);
  if (!api) {
    throw new Error("Project environment is not connected.");
  }
  return api;
}

function notifySaveError(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Could not save project settings",
      description: error instanceof Error ? error.message : "Project settings update failed.",
    }),
  );
}

export function PerProjectRepoSettingsPanel() {
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const orderedProjects = useMemo(() => sortProjects(projects), [projects]);
  const [selectedProjectValue, setSelectedProjectValue] = useState<string | null>(null);
  const selectedProject = useMemo(
    () =>
      orderedProjects.find((project) => projectSelectValue(project) === selectedProjectValue) ??
      orderedProjects[0] ??
      null,
    [orderedProjects, selectedProjectValue],
  );
  const selectedProjectStableValue = selectedProject ? projectSelectValue(selectedProject) : null;

  const [isLoading, setIsLoading] = useState(false);
  const [savingField, setSavingField] = useState<"thread" | "setup" | "preview" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newThreadMode, setNewThreadMode] = useState<NewThreadModeSelection>("global");
  const [setupCommand, setSetupCommand] = useState("");
  const [savedSetupCommand, setSavedSetupCommand] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    if (!selectedProjectValue && orderedProjects[0]) {
      setSelectedProjectValue(projectSelectValue(orderedProjects[0]));
      return;
    }
    if (
      selectedProjectValue &&
      !orderedProjects.some((project) => projectSelectValue(project) === selectedProjectValue)
    ) {
      setSelectedProjectValue(orderedProjects[0] ? projectSelectValue(orderedProjects[0]) : null);
    }
  }, [orderedProjects, selectedProjectValue]);

  useEffect(() => {
    if (!selectedProject) {
      setLoadError(null);
      setNewThreadMode("global");
      setSetupCommand("");
      setSavedSetupCommand("");
      setPreviewUrl("");
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const api = readEnvironmentApiOrThrow(selectedProject);
        const config = await readProjectConfigFile(api, selectedProject.cwd);
        if (cancelled) return;

        setNewThreadMode(getProjectConfigNewThreadEnvMode(config) ?? "global");
        const nextSetupCommand = getWorktreeSetupCommand(selectedProject.scripts);
        setSetupCommand(nextSetupCommand);
        setSavedSetupCommand(nextSetupCommand);
        setPreviewUrl(
          getProjectConfigBrowserPreviewUrl(config) || selectedProject.browserPreviewUrl || "",
        );
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Could not load project config.");
        setNewThreadMode("global");
        const nextSetupCommand = getWorktreeSetupCommand(selectedProject.scripts);
        setSetupCommand(nextSetupCommand);
        setSavedSetupCommand(nextSetupCommand);
        setPreviewUrl(selectedProject.browserPreviewUrl || "");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  const saveNewThreadMode = useCallback(
    async (value: NewThreadModeSelection) => {
      if (!selectedProject) return;
      setNewThreadMode(value);
      setSavingField("thread");
      try {
        const api = readEnvironmentApiOrThrow(selectedProject);
        await updateProjectConfigFile({
          api,
          cwd: selectedProject.cwd,
          update: (config) => {
            setProjectConfigNewThreadEnvMode(config, value === "global" ? null : value);
          },
        });
      } catch (error) {
        notifySaveError(error);
      } finally {
        setSavingField(null);
      }
    },
    [selectedProject],
  );

  const saveSetupCommand = useCallback(async () => {
    if (!selectedProject) return;
    const nextScripts = buildScriptsWithWorktreeSetupCommand(selectedProject.scripts, setupCommand);
    setSavingField("setup");
    try {
      const api = readEnvironmentApiOrThrow(selectedProject);
      await writeProjectConfigScripts({
        api,
        projectCwd: selectedProject.cwd,
        scripts: nextScripts,
        browserPreviewUrl: selectedProject.browserPreviewUrl,
      });
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: selectedProject.id as ProjectId,
        scripts: nextScripts,
      });
      setSavedSetupCommand(setupCommand.trim());
    } catch (error) {
      notifySaveError(error);
    } finally {
      setSavingField(null);
    }
  }, [selectedProject, setupCommand]);

  const savePreviewUrl = useCallback(
    async (rawValue: string) => {
      if (!selectedProject) return;
      const nextPreviewUrl = normalizeBrowserAgentPreviewUrl(rawValue);
      setPreviewUrl(nextPreviewUrl);
      setSavingField("preview");
      try {
        const api = readEnvironmentApiOrThrow(selectedProject);
        await updateProjectConfigFile({
          api,
          cwd: selectedProject.cwd,
          update: (config) => setProjectConfigBrowserPreviewUrl(config, nextPreviewUrl),
        });
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: selectedProject.id as ProjectId,
          browserPreviewUrl: nextPreviewUrl || null,
        });
      } catch (error) {
        notifySaveError(error);
      } finally {
        setSavingField(null);
      }
    },
    [selectedProject],
  );

  const setupDirty = setupCommand.trim() !== savedSetupCommand.trim();
  const selectedProjectRef = selectedProject
    ? scopeProjectRef(selectedProject.environmentId, selectedProject.id)
    : null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Per Project Repo" icon={<FolderGit2Icon className="size-3.5" />}>
        <SettingsRow
          title="Repository"
          description="Choose which repo-local .t3code/project.json to edit."
          status={loadError}
          control={
            <Select
              value={selectedProjectStableValue ?? ""}
              onValueChange={(value) => setSelectedProjectValue(value || null)}
            >
              <SelectTrigger className="w-full sm:w-72" aria-label="Project repository">
                <SelectValue>
                  {selectedProject ? projectDisplayName(selectedProject) : "No projects"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {orderedProjects.map((project) => (
                  <SelectItem
                    hideIndicator
                    key={projectSelectValue(project)}
                    value={projectSelectValue(project)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <ProjectFavicon
                        environmentId={project.environmentId}
                        cwd={project.cwd}
                        className="size-4"
                      />
                      <span className="truncate">{projectDisplayName(project)}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="New threads"
          description="Choose the workspace mode used by the project new-thread button."
          status={
            isLoading
              ? "Loading project config."
              : selectedProjectRef
                ? selectedProject?.cwd
                : "Add a project before configuring repo settings."
          }
          control={
            <Select
              value={newThreadMode}
              onValueChange={(value) => {
                if (value === "global" || value === "local" || value === "worktree") {
                  void saveNewThreadMode(value);
                }
              }}
              disabled={!selectedProject || isLoading}
            >
              <SelectTrigger className="w-full sm:w-48" aria-label="Project new thread mode">
                <SelectValue>{NEW_THREAD_MODE_LABELS[newThreadMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="global">
                  {NEW_THREAD_MODE_LABELS.global}
                </SelectItem>
                <SelectItem hideIndicator value="local">
                  {NEW_THREAD_MODE_LABELS.local}
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  {NEW_THREAD_MODE_LABELS.worktree}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Preview URL"
          description="Set the repo-specific browser preview URL."
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={previewUrl}
              onCommit={(next) => void savePreviewUrl(next)}
              placeholder="http://localhost:3000/"
              spellCheck={false}
              inputMode="url"
              type="url"
              aria-label="Project preview URL"
              disabled={!selectedProject || isLoading}
            />
          }
        />

        <SettingsRow
          title="Worktree setup"
          description="Run this command automatically after a new workspace is created."
        >
          <div className="mt-3 flex flex-col gap-2">
            <Textarea
              value={setupCommand}
              onChange={(event) => setSetupCommand(event.target.value)}
              placeholder={`[ -f "$T3CODE_PROJECT_ROOT/.env" ] && cp "$T3CODE_PROJECT_ROOT/.env" "$T3CODE_WORKTREE_PATH/.env" || true`}
              spellCheck={false}
              disabled={!selectedProject || isLoading}
              aria-label="Worktree setup command"
            />
            <div className="flex justify-end">
              <Button
                size="xs"
                variant="outline"
                disabled={!selectedProject || isLoading || !setupDirty || savingField === "setup"}
                onClick={() => void saveSetupCommand()}
              >
                {savingField === "setup" ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <SaveIcon className="size-3.5" />
                )}
                Save setup
              </Button>
            </div>
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
