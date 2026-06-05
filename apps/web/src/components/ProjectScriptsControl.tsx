import type {
  ProjectScript,
  ProjectScriptIcon,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  BugIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  GlobeIcon,
  HammerIcon,
  ListChecksIcon,
  MonitorUpIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  SquareIcon,
  TerminalSquareIcon,
  WrenchIcon,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useCallback, useMemo, useState } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import { cn } from "~/lib/utils";
import { keybindingFromKeyboardEvent } from "~/components/settings/KeybindingsSettings.logic";
import {
  commandForProjectScript,
  nextProjectScriptId,
  pinnedTopBarProjectScripts,
  topBarMainProjectScript,
} from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { DraftInput } from "./ui/draft-input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Group, GroupSeparator } from "./ui/group";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];
const EMPTY_RUNNING_SCRIPT_IDS = new Set<string>() as ReadonlySet<string>;
const EMPTY_DETECTED_SCRIPT_URLS = Object.freeze({}) as Readonly<Record<string, string>>;
const RUNNING_SCRIPT_BUTTON_CLASS_NAME =
  "border-emerald-500/45 bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/18 dark:text-emerald-300";
const LOCAL_PREVIEW_URL_PATTERN =
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}(?:[/?#][^\s"'`)]*)?/iu;
const SCRIPT_SERVER_ICON_CLASS_NAMES = [
  "text-emerald-500",
  "text-rose-500",
  "text-sky-500",
  "text-amber-500",
] as const;

function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

function scriptServerIconClassName(scriptId: string): string {
  let hash = 0;
  for (let index = 0; index < scriptId.length; index += 1) {
    hash = (hash * 31 + scriptId.charCodeAt(index)) % SCRIPT_SERVER_ICON_CLASS_NAMES.length;
  }
  return SCRIPT_SERVER_ICON_CLASS_NAMES[hash] ?? SCRIPT_SERVER_ICON_CLASS_NAMES[0];
}

function formatPreviewUrlDetail(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.startsWith("http") ? rawUrl : `http://${rawUrl}`);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${pathname}`;
  } catch {
    return rawUrl;
  }
}

function extractPreviewUrlFromCommand(command: string): string | null {
  return LOCAL_PREVIEW_URL_PATTERN.exec(command)?.[0] ?? null;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  pinnedToTopBar: boolean;
  keybinding: string | null;
}

export interface RunProjectScriptOptions {
  rememberAsLastInvoked?: boolean;
}

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  previewUrl: string | null | undefined;
  detectedDevServerUrlsByScriptId?: Readonly<Record<string, string>>;
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  runningScriptIds?: ReadonlySet<string>;
  onRunScript: (script: ProjectScript, options?: RunProjectScriptOptions) => void;
  onViewRunningScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
  onUpdatePreviewUrl: (previewUrl: string) => Promise<void> | void;
}

export default function ProjectScriptsControl({
  scripts,
  previewUrl,
  detectedDevServerUrlsByScriptId = EMPTY_DETECTED_SCRIPT_URLS,
  keybindings,
  preferredScriptId = null,
  runningScriptIds = EMPTY_RUNNING_SCRIPT_IDS,
  onRunScript,
  onViewRunningScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
  onUpdatePreviewUrl,
}: ProjectScriptsControlProps) {
  const addScriptFormId = React.useId();
  const projectSettingsFormId = React.useId();
  const previewUrlInputId = React.useId();
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [pinnedToTopBar, setPinnedToTopBar] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [projectSettingsError, setProjectSettingsError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const primaryScript = useMemo(() => {
    return topBarMainProjectScript(scripts, preferredScriptId);
  }, [preferredScriptId, scripts]);
  const pinnedScripts = useMemo(
    () => pinnedTopBarProjectScripts(scripts, primaryScript?.id ?? null),
    [primaryScript?.id, scripts],
  );
  const primaryScriptRunning = primaryScript ? runningScriptIds.has(primaryScript.id) : false;
  const hasTopBarRunningScript =
    primaryScriptRunning || pinnedScripts.some((script) => runningScriptIds.has(script.id));
  const isEditing = editingScriptId !== null;
  const dropdownItemClassName =
    "data-highlighted:bg-accent/60 data-highlighted:text-foreground hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:text-foreground data-highlighted:hover:bg-accent/70 data-highlighted:hover:text-foreground data-highlighted:focus-visible:bg-accent/70 data-highlighted:focus-visible:text-foreground";

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!next) return;
    setKeybinding(next);
  };

  const submitAddScript = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
      return;
    }

    setValidationError(null);
    try {
      const scriptIdForValidation =
        editingScriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        pinnedToTopBar,
        keybinding: keybindingRule?.key ?? null,
      } satisfies NewProjectScriptInput;
      if (editingScriptId) {
        await onUpdateScript(editingScriptId, payload);
      } else {
        await onAddScript(payload);
      }
      setDialogOpen(false);
      setIconPickerOpen(false);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
    }
  };

  const openAddDialog = () => {
    setEditingScriptId(null);
    setName("");
    setCommand("");
    setIcon("play");
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(false);
    setPinnedToTopBar(false);
    setKeybinding("");
    setValidationError(null);
    setDialogOpen(true);
  };

  const openProjectSettings = () => {
    setProjectSettingsError(null);
    setProjectSettingsOpen(true);
  };

  const openEditDialog = (script: ProjectScript) => {
    setEditingScriptId(script.id);
    setName(script.name);
    setCommand(script.command);
    setIcon(script.icon);
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(script.runOnWorktreeCreate);
    setPinnedToTopBar(script.pinnedToTopBar === true);
    setKeybinding(keybindingValueForCommand(keybindings, commandForProjectScript(script.id)) ?? "");
    setValidationError(null);
    setDialogOpen(true);
  };

  const confirmDeleteScript = useCallback(() => {
    if (!editingScriptId) return;
    setDeleteConfirmOpen(false);
    setDialogOpen(false);
    void onDeleteScript(editingScriptId);
  }, [editingScriptId, onDeleteScript]);

  const commitPreviewUrl = useCallback(
    (nextPreviewUrl: string) => {
      setProjectSettingsError(null);
      void Promise.resolve(onUpdatePreviewUrl(nextPreviewUrl)).catch((error) => {
        setProjectSettingsError(
          error instanceof Error ? error.message : "Failed to save preview URL.",
        );
      });
    },
    [onUpdatePreviewUrl],
  );

  return (
    <>
      {primaryScript ? (
        <Group aria-label="Project scripts">
          <Button
            size="xs"
            variant="outline"
            className={cn(
              "min-w-0 max-w-44",
              primaryScriptRunning && RUNNING_SCRIPT_BUTTON_CLASS_NAME,
            )}
            onClick={() => onRunScript(primaryScript)}
            aria-label={
              primaryScriptRunning ? `Stop ${primaryScript.name}` : `Run ${primaryScript.name}`
            }
            title={
              primaryScriptRunning ? `Stop ${primaryScript.name}` : `Run ${primaryScript.name}`
            }
          >
            {primaryScriptRunning ? (
              <SquareIcon className="size-3.5 fill-current" />
            ) : (
              <ScriptIcon icon={primaryScript.icon} />
            )}
            <span className="ml-0.5 min-w-0 truncate">{primaryScript.name}</span>
          </Button>
          {pinnedScripts.length > 0 && (
            <>
              <GroupSeparator className="hidden @3xl/header-actions:block" />
              {pinnedScripts.map((script) => {
                const scriptRunning = runningScriptIds.has(script.id);
                const label = scriptRunning ? `Stop ${script.name}` : `Run ${script.name}`;
                return (
                  <Tooltip key={script.id}>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="outline"
                          className={cn(scriptRunning && RUNNING_SCRIPT_BUTTON_CLASS_NAME)}
                          onClick={() => onRunScript(script, { rememberAsLastInvoked: false })}
                          aria-label={label}
                          title={label}
                        />
                      }
                    >
                      {scriptRunning ? (
                        <SquareIcon className="size-3.5 fill-current" />
                      ) : (
                        <ScriptIcon icon={script.icon} />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">{label}</TooltipPopup>
                  </Tooltip>
                );
              })}
            </>
          )}
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Menu highlightItemOnHover={false}>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  className={cn(hasTopBarRunningScript && RUNNING_SCRIPT_BUTTON_CLASS_NAME)}
                  aria-label="Script actions"
                />
              }
            >
              <PlayIcon className="size-3.5 text-primary" />
              <span className="ml-0.5">Scripts</span>
              <ChevronDownIcon className="size-3.5 opacity-70" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-[min(86vw,28rem)]">
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                const scriptRunning = runningScriptIds.has(script.id);
                const detectedDevServerUrl =
                  detectedDevServerUrlsByScriptId[script.id] ??
                  (script.id === primaryScript.id ? previewUrl : undefined) ??
                  extractPreviewUrlFromCommand(script.command);
                const previewUrlDetail = detectedDevServerUrl
                  ? formatPreviewUrlDetail(detectedDevServerUrl)
                  : null;
                const showScriptDetails = scriptRunning || previewUrlDetail !== null;
                const actionLabel = scriptRunning ? "View" : "Run";
                return (
                  <MenuItem
                    key={script.id}
                    className={cn(
                      "group grid min-h-11 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md px-3 py-2 text-left sm:min-h-11 sm:py-2",
                      dropdownItemClassName,
                      scriptRunning && "bg-accent/25",
                    )}
                    onClick={() =>
                      scriptRunning ? onViewRunningScript(script) : onRunScript(script)
                    }
                  >
                    {previewUrlDetail ? (
                      <GlobeIcon
                        className={cn("row-span-2 size-4.5", scriptServerIconClassName(script.id))}
                      />
                    ) : (
                      <ScriptIcon
                        icon={script.icon}
                        className={cn(
                          "row-span-2 size-4.5 text-muted-foreground",
                          scriptRunning && "text-emerald-500",
                        )}
                      />
                    )}
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      {script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name}
                    </span>
                    <span className="col-start-2 min-w-0 truncate text-xs leading-5 text-muted-foreground empty:hidden">
                      {showScriptDetails ? script.command : null}
                    </span>
                    {previewUrlDetail ? (
                      <span className="col-start-2 min-w-0 truncate text-xs leading-5 text-muted-foreground">
                        {previewUrlDetail}
                      </span>
                    ) : null}
                    <span className="col-start-3 row-span-2 row-start-1 flex min-w-16 items-center justify-end gap-2 text-muted-foreground">
                      {shortcutLabel && (
                        <MenuShortcut className="ms-0 hidden transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0 sm:inline">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                        {scriptRunning ? (
                          <TerminalSquareIcon className="size-4" />
                        ) : (
                          <PlayIcon className="size-4" />
                        )}
                        {actionLabel}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-6 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
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
              <MenuSeparator />
              <MenuItem className={dropdownItemClassName} onClick={openProjectSettings}>
                <SettingsIcon className="size-4" />
                Project settings
              </MenuItem>
              <MenuItem className={dropdownItemClassName} onClick={openAddDialog}>
                <PlusIcon className="size-4" />
                Add action
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      ) : (
        <Group aria-label="Project actions">
          <Button size="xs" variant="outline" onClick={openAddDialog} title="Add action">
            <PlusIcon className="size-3.5" />
            <span className="ml-0.5">Add action</span>
          </Button>
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  onClick={openProjectSettings}
                  aria-label="Project settings"
                  title="Project settings"
                />
              }
            >
              <SettingsIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Project settings</TooltipPopup>
          </Tooltip>
        </Group>
      )}

      <Dialog open={projectSettingsOpen} onOpenChange={setProjectSettingsOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Project Settings</DialogTitle>
            <DialogDescription>Stored in .t3code/project.json.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={projectSettingsFormId} className="space-y-2">
              <Label htmlFor={previewUrlInputId} className="flex items-center gap-2">
                <MonitorUpIcon className="size-4 text-muted-foreground" />
                Preview URL
              </Label>
              <DraftInput
                id={previewUrlInputId}
                value={previewUrl ?? ""}
                onCommit={commitPreviewUrl}
                placeholder="http://localhost:3000/"
                spellCheck={false}
                inputMode="url"
                type="url"
                aria-label="Preview URL"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Leave empty to use the detected or inferred project dev-server URL.
              </p>
              {projectSettingsError ? (
                <p className="text-xs leading-5 text-destructive" role="alert">
                  {projectSettingsError}
                </p>
              ) : null}
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjectSettingsOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setIconPickerOpen(false);
          }
        }}
        onOpenChangeComplete={(open) => {
          if (open) return;
          setEditingScriptId(null);
          setName("");
          setCommand("");
          setIcon("play");
          setRunOnWorktreeCreate(false);
          setPinnedToTopBar(false);
          setKeybinding("");
          setValidationError(null);
        }}
        open={dialogOpen}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Action" : "Add Action"}</DialogTitle>
            <DialogDescription>
              Actions are project-scoped commands you can run from the top bar or keybindings.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id={addScriptFormId} className="space-y-4" onSubmit={submitAddScript}>
              <div className="space-y-1.5">
                <Label htmlFor="script-name">Name</Label>
                <div className="flex items-center gap-2">
                  <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="size-9 shrink-0 hover:bg-popover active:bg-popover data-pressed:bg-popover data-pressed:shadow-xs/5 data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)]"
                          aria-label="Choose icon"
                        />
                      }
                    >
                      <ScriptIcon icon={icon} className="size-4.5" />
                    </PopoverTrigger>
                    <PopoverPopup align="start">
                      <div className="grid grid-cols-3 gap-2">
                        {SCRIPT_ICONS.map((entry) => {
                          const isSelected = entry.id === icon;
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs ${
                                isSelected
                                  ? "border-primary/70 bg-primary/10"
                                  : "border-border/70 hover:bg-accent/60"
                              }`}
                              onClick={() => {
                                setIcon(entry.id);
                                setIconPickerOpen(false);
                              }}
                            >
                              <ScriptIcon icon={entry.id} className="size-4" />
                              <span>{entry.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverPopup>
                  </Popover>
                  <Input
                    id="script-name"
                    autoFocus
                    placeholder="Test"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-keybinding">Keybinding</Label>
                <Input
                  id="script-keybinding"
                  placeholder="Press shortcut"
                  value={keybinding}
                  readOnly
                  onKeyDown={captureKeybinding}
                />
                <p className="text-xs text-muted-foreground">
                  Press a shortcut. Use <code>Backspace</code> to clear.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="script-command">Command</Label>
                <Textarea
                  id="script-command"
                  placeholder="bun test"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
                <span>Run automatically on worktree creation</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm">
                <span>Pin to top bar</span>
                <Switch
                  checked={pinnedToTopBar}
                  onCheckedChange={(checked) => setPinnedToTopBar(Boolean(checked))}
                />
              </label>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </form>
          </DialogPanel>
          <DialogFooter>
            {isEditing && (
              <Button
                type="button"
                variant="destructive-outline"
                className="mr-auto"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button form={addScriptFormId} type="submit">
              {isEditing ? "Save changes" : "Save action"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDeleteScript}>
              Delete action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
