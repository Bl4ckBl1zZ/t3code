import type {
  ProjectScript,
  ResolvedKeybindingsConfig,
  T3ProjectFileScript,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectScriptRunState } from "@t3tools/client-runtime/state/terminal";
import { ChevronDownIcon, DownloadIcon, PlusIcon, SettingsIcon, SquareIcon } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";

import { commandForProjectScript, primaryProjectScript } from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./chat/threadDetailsPanelStyles";

export type { NewProjectScriptInput, ProjectScriptActionResult };

const NO_FILE_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

interface ProjectScriptsControlProps {
  displayMode?: "toolbar" | "panel";
  scripts: ReadonlyArray<ProjectScript>;
  /** Scripts declared in the project's checked-in t3.json, offered for import. */
  fileScripts?: ReadonlyArray<T3ProjectFileScript>;
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  /** Active run per single-run script id; clicking such a script stops it. */
  scriptRunStates?: ReadonlyMap<string, ProjectScriptRunState>;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export default function ProjectScriptsControl({
  displayMode = "toolbar",
  scripts,
  fileScripts = NO_FILE_SCRIPTS,
  keybindings,
  preferredScriptId = null,
  scriptRunStates,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = React.useRef<HTMLDivElement | null>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState({
    scripts: false,
    imports: false,
  });
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const importableScripts = useMemo(
    () =>
      fileScripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [fileScripts, scripts],
  );
  const primaryRunState = primaryScript ? (scriptRunStates?.get(primaryScript.id) ?? null) : null;
  const isPrimaryScriptActive = primaryRunState !== null;
  const activeRunButtonClassName =
    "border-emerald-600/50 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 hover:text-emerald-600 dark:border-emerald-300/40 dark:bg-emerald-400/10 dark:text-emerald-300/90 dark:hover:bg-emerald-400/15 dark:hover:text-emerald-300/90";
  const dropdownItemClassName =
    "data-highlighted:bg-transparent data-highlighted:text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground data-highlighted:hover:bg-accent data-highlighted:hover:text-accent-foreground data-highlighted:focus-visible:bg-accent data-highlighted:focus-visible:text-accent-foreground";

  const openAddDialog = () => {
    setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT });
  };

  const openEditDialog = (script: ProjectScript) => {
    setActionsMenuOpen({ scripts: false, imports: false });
    setEditorRequest(editorRequestForScript(script, keybindings));
  };

  const submitScript = useCallback(
    (scriptId: string | null, input: NewProjectScriptInput) =>
      scriptId === null ? onAddScript(input) : onUpdateScript(scriptId, input),
    [onAddScript, onUpdateScript],
  );

  const importFileScript = async (fileScript: T3ProjectFileScript) => {
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
    const result = await onAddScript(payload);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      // Surface the failure through the regular add dialog, prefilled so the
      // user can adjust and retry.
      const error = squashAtomCommandFailure(result);
      setEditorRequest({
        scriptId: null,
        initial: payload,
        error: error instanceof Error ? error.message : "Failed to import action.",
      });
    }
  };

  const importMenuItems = importableScripts.length > 0 && (
    <>
      {primaryScript && <MenuSeparator />}
      <MenuGroup>
        <MenuGroupLabel>From t3.json</MenuGroupLabel>
        {importableScripts.map((fileScript) => (
          <MenuItem
            key={`${fileScript.name} ${fileScript.command}`}
            className={dropdownItemClassName}
            onClick={() => void importFileScript(fileScript)}
          >
            <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4" />
            <span className="truncate">{fileScript.name}</span>
            <MenuShortcut className="ms-auto">
              <DownloadIcon className="size-3.5" aria-label="Import" />
            </MenuShortcut>
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );

  return (
    <>
      {primaryScript ? (
        <ActionGroup
          role="group"
          aria-label="Project scripts"
          {...(isPanel
            ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
            : {})}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={isPanel ? "ghost" : "outline"}
                  className={cn(
                    isPanel
                      ? THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS
                      : "w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]",
                    isPrimaryScriptActive && activeRunButtonClassName,
                  )}
                  aria-label={
                    isPrimaryScriptActive
                      ? `Stop ${primaryScript.name}`
                      : `Run ${primaryScript.name}`
                  }
                  // The tooltip wrapper replaces data-slot="button", so themed
                  // toolbar styling needs its own hook.
                  data-toolbar-control=""
                  onClick={() => onRunScript(primaryScript)}
                />
              }
            >
              {isPrimaryScriptActive ? (
                <SquareIcon
                  className={cn(
                    "fill-current",
                    isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3",
                  )}
                />
              ) : (
                <ScriptIcon
                  icon={primaryScript.icon}
                  {...(isPanel ? { className: THREAD_DETAILS_PANEL_ICON_CLASS } : {})}
                />
              )}
              <span
                className={cn(
                  "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                  isPanel && "not-sr-only ml-0.5 truncate",
                )}
              >
                {primaryScript.name}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isPrimaryScriptActive ? `Stop ${primaryScript.name}` : `Run ${primaryScript.name}`}
            </TooltipPopup>
          </Tooltip>
          {isPanel ? (
            <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          ) : (
            <GroupSeparator className="hidden @3xl/header-actions:block" />
          )}
          <Menu
            highlightItemOnHover={false}
            open={actionsMenuOpen.scripts}
            onOpenChange={(open) => setActionsMenuOpen({ scripts: open, imports: false })}
          >
            <MenuTrigger
              render={
                <Button
                  size={isPanel ? "sm" : "icon-xs"}
                  variant={isPanel ? "ghost" : "outline"}
                  className={isPanel ? THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS : undefined}
                  aria-label="Script actions"
                />
              }
            >
              <ChevronDownIcon
                className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
              />
            </MenuTrigger>
            <MenuPopup
              align="end"
              {...(isPanel ? { anchor: panelAnchorRef } : {})}
              className={isPanel ? THREAD_DETAILS_PANEL_ROW_POPUP_CLASS : undefined}
            >
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                const isScriptActive = scriptRunStates?.has(script.id) ?? false;
                return (
                  <MenuItem
                    key={script.id}
                    className={`group ${dropdownItemClassName}`}
                    aria-label={isScriptActive ? `Stop ${script.name}` : `Run ${script.name}`}
                    onClick={() => onRunScript(script)}
                  >
                    {isScriptActive ? (
                      <SquareIcon className="size-4 p-0.5 fill-current text-emerald-600 dark:text-emerald-300/90" />
                    ) : (
                      <ScriptIcon icon={script.icon} className="size-4" />
                    )}
                    <span className="truncate">
                      {script.runOnWorktreeCreate
                        ? `${script.name} (setup)`
                        : script.runOnWorktreeDelete
                          ? `${script.name} (teardown)`
                          : script.name}
                    </span>
                    <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                      {shortcutLabel && (
                        <MenuShortcut className="ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-0 top-1/2 size-6 -translate-y-1/2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
                        aria-label={`Edit ${script.name}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openEditDialog(script);
                        }}
                      >
                        <SettingsIcon className="size-3.5" />
                      </Button>
                    </span>
                  </MenuItem>
                );
              })}
              {importMenuItems}
              <MenuItem className={dropdownItemClassName} onClick={openAddDialog}>
                <PlusIcon className="size-4" />
                {isPanel ? "Add project script" : "Add action"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </ActionGroup>
      ) : importableScripts.length > 0 ? (
        <Menu
          highlightItemOnHover={false}
          open={actionsMenuOpen.imports}
          onOpenChange={(open) => setActionsMenuOpen({ scripts: false, imports: open })}
        >
          <MenuTrigger render={<Button size="xs" variant="outline" aria-label="Project actions" />}>
            <PlusIcon className="size-3.5" />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              Add action
            </span>
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {importMenuItems}
            <MenuItem className={dropdownItemClassName} onClick={openAddDialog}>
              <PlusIcon className="size-4" />
              Add action
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={isPanel ? "ghost" : "outline"}
                className={
                  isPanel
                    ? THREAD_DETAILS_PANEL_ROW_CLASS
                    : "w-7 px-0 sm:w-6 @3xl/header-actions:w-auto! @3xl/header-actions:px-[calc(--spacing(2)-1px)]"
                }
                aria-label={isPanel ? "Add project script" : "Add action"}
                // The tooltip wrapper replaces data-slot="button", so themed
                // toolbar styling needs its own hook.
                data-toolbar-control=""
                onClick={openAddDialog}
              />
            }
          >
            <PlusIcon className="size-3.5" />
            <span
              className={cn(
                "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                isPanel && "not-sr-only ml-0.5",
              )}
            >
              {isPanel ? "Add project script" : "Add action"}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">{isPanel ? "Add project script" : "Add action"}</TooltipPopup>
        </Tooltip>
      )}

      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={(scriptId) => void onDeleteScript(scriptId)}
        onClose={() => setEditorRequest(null)}
      />
    </>
  );
}
