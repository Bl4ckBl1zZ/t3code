import {
  ArrowUpDownIcon,
  DownloadIcon,
  CloudIcon,
  FilesIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  PanelTopIcon,
  PencilIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPr,
  ThreadStatusLabel,
} from "./ThreadStatusIndicators";
import { ProjectFavicon } from "./ProjectFavicon";
import { autoAnimate } from "@formkit/auto-animate";
import React, { useCallback, useEffect, memo, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { createModelSelection } from "@t3tools/shared/model";
import {
  type ContextMenuItem,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type DesktopUpdateState,
  EventId,
  ProjectId,
  ProviderDriverKind,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
  type ThreadEnvMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  type WorkbenchTab,
} from "@t3tools/client-runtime";
import { Link, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadPreviewCount,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { isElectron } from "../env";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform, newCommandId, newThreadId, randomUUID } from "../lib/utils";
import {
  selectProjectByRef,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectSidebarThreadsForProjectRefs,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  selectWorkspacesForProjectRefs,
  useStore,
} from "../store";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useModelPickerOpen } from "../modelPickerOpenState";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useVcsStatus } from "../lib/vcsStatusState";
import { useVcsPullAction, useVcsSyncBaseAction } from "../lib/sourceControlActions";
import { readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { retainThreadDetailSubscription } from "../environments/runtime/service";

import { isThreadDeleteBlockedByActiveSession, useThreadActions } from "../hooks/useThreadActions";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { stackedThreadToast, toastManager, type ThreadToastData } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { Kbd } from "./ui/kbd";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent } from "./ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  getSidebarThreadIdsToPrewarm,
  getSidebarTopLevelThreadId,
  buildSidebarWorkspaceThreadGroups,
  getSidebarWorkspaceThreadGroupKey,
  buildSidebarProjectFolderEntries,
  findSidebarProjectFolderForProject,
  getSidebarProjectPhysicalKeys,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  isSidebarImplicitDefaultWorkspaceGroup,
  isSidebarTopLevelThread,
  moveSidebarProjectAcrossFolders,
  moveSidebarProjectToFolder,
  resolveProjectStatusIndicator,
  resolveSidebarExplorerTarget,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveGroupedThreadStatusPills,
  reorderSidebarFolderProjectKeys,
  removeSidebarProjectFromFolders,
  orderItemsByPreferredIds,
  sidebarProjectFolderKey,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  useThreadJumpHintVisibility,
  type SidebarWorkspaceThreadGroup,
  type SidebarWorkspaceShell,
  type SidebarProjectFolderEntry,
  type ThreadStatusPill,
} from "./Sidebar.logic";
import { sortThreads } from "../lib/threadSort";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { CommandDialogTrigger } from "./ui/command";
import { readEnvironmentApi } from "../environmentApi";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerConfigLoaded, useServerKeybindings } from "../rpc/serverState";
import {
  derivePhysicalProjectKey,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type SidebarThreadSummary,
} from "../types";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { SidebarProviderUpdatePill } from "./sidebar/SidebarProviderUpdatePill";
import { WorkspaceExplorer } from "./workspace/WorkspaceExplorer";
import { useWorkbenchStore } from "../workbenchStore";
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

async function waitForThreadShell(threadRef: ScopedThreadRef, timeoutMs = 1_000): Promise<boolean> {
  const getThread = () => selectThreadByRef(useStore.getState(), threadRef);
  if (getThread()) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (selectThreadByRef(state, threadRef)) {
        finish(true);
      }
    });

    if (getThread()) {
      finish(true);
      return;
    }
    timeoutId = globalThis.setTimeout(() => finish(false), timeoutMs);
  });
}

function setSidebarProjectExpandedValue(
  current: Readonly<Record<string, boolean>>,
  projectKey: string,
  expanded: boolean,
): Record<string, boolean> {
  const next = { ...current };
  if (expanded) {
    delete next[projectKey];
  } else {
    next[projectKey] = false;
  }
  return next;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function materializeProjectExpandedById(input: {
  localProjectExpandedById: Readonly<Record<string, boolean>>;
  syncedProjectExpandedById: Readonly<Record<string, boolean>>;
  useSyncedProjectExpandedById: boolean;
}): Record<string, boolean> {
  if (!input.useSyncedProjectExpandedById) {
    return { ...input.localProjectExpandedById };
  }

  // BACKWARD COMPATIBILITY: Server settings omit expanded rows, while legacy UI
  // state materializes current project keys so bootstrap/re-key logic can carry
  // explicit true values across project syncs.
  const next: Record<string, boolean> = {};
  for (const key of Object.keys(input.localProjectExpandedById)) {
    next[key] = input.syncedProjectExpandedById[key] ?? true;
  }
  for (const [key, expanded] of Object.entries(input.syncedProjectExpandedById)) {
    next[key] = expanded;
  }
  return next;
}

function booleanRecordsEqual(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}

const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

function createSidebarProjectFolderId(): string {
  return `project-folder-${randomUUID()}`;
}

function formatProjectMemberActionLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) {
    return member.name;
  }

  return member.environmentLabel ? `${member.environmentLabel} — ${member.cwd}` : member.cwd;
}

function projectGroupingModeDescription(mode: SidebarProjectGroupingMode): string {
  switch (mode) {
    case "repository":
      return "Projects from the same repository share one sidebar row.";
    case "repository_path":
      return "Projects group only when both the repository and repo-relative path match.";
    case "separate":
      return "Every project path gets its own sidebar row.";
  }
}

function buildThreadJumpLabelMap(input: {
  keybindings: ReturnType<typeof useServerKeybindings>;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

interface SidebarWorkspaceCreateTarget {
  readonly workspaceId: NonNullable<SidebarThreadSummary["workspaceId"]>;
  readonly environmentId: SidebarThreadSummary["environmentId"];
  readonly projectId: SidebarThreadSummary["projectId"];
  readonly tabGroupId: ThreadId | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

type SidebarWorkspaceRowGroup = SidebarWorkspaceThreadGroup<SidebarThreadSummary>;

const SidebarWorkspacePrIndicator = memo(function SidebarWorkspacePrIndicator({
  group,
  projectCwd,
  openPrLink,
}: {
  group: SidebarWorkspaceRowGroup;
  projectCwd: string;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
}) {
  const gitStatus = useVcsStatus({
    environmentId: group.environmentId,
    cwd: group.branch !== null ? (group.worktreePath ?? projectCwd) : null,
  });
  const pr = resolveThreadPr(group.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!prStatus) return;
      openPrLink(event, prStatus.url);
    },
    [openPrLink, prStatus],
  );

  if (prStatus) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={prStatus.tooltip}
              className={`inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${prStatus.colorClass}`}
              onClick={handlePrClick}
            />
          }
        >
          <ChangeRequestStatusIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label="No PR"
            className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/55"
          />
        }
      >
        <PencilIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">No PR</TooltipPopup>
    </Tooltip>
  );
});

interface SidebarProjectThreadListProps {
  projectKey: string;
  projectExpanded: boolean;
  hasOverflowingThreads: boolean;
  hiddenThreadStatus: ThreadStatusPill | null;
  orderedProjectThreadKeys: readonly string[];
  workspaces: readonly SidebarWorkspaceShell[];
  availableThreads: readonly SidebarThreadSummary[];
  renderedThreads: readonly SidebarThreadSummary[];
  threadStatusByKey: ReadonlyMap<string, ThreadStatusPill | null>;
  workspaceStatusByKey: ReadonlyMap<string, ThreadStatusPill | null>;
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
  projectCwd: string;
  activeRouteThreadKey: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  handleCreateSubChatForWorkspace: (target: SidebarWorkspaceCreateTarget) => Promise<void>;
  handleWorkspaceContextMenu: (
    group: SidebarWorkspaceRowGroup,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  renamingWorkspaceKey: string | null;
  renamingWorkspaceTitle: string;
  setRenamingWorkspaceTitle: (title: string) => void;
  startWorkspaceRename: (group: SidebarWorkspaceRowGroup) => void;
  workspaceRenameInputRef: React.RefObject<HTMLInputElement | null>;
  workspaceRenamingCommittedRef: React.RefObject<boolean>;
  commitWorkspaceRename: (
    group: SidebarWorkspaceRowGroup,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelWorkspaceRename: () => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
}

const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const {
    workspaces,
    availableThreads,
    workspaceStatusByKey,
    showEmptyThreadState,
    shouldShowThreadPanel,
    projectCwd,
    activeRouteThreadKey,
    attachThreadListAutoAnimateRef,
    handleCreateSubChatForWorkspace,
    navigateToThread,
    handleWorkspaceContextMenu,
    openPrLink,
    renamingWorkspaceKey,
    renamingWorkspaceTitle,
    setRenamingWorkspaceTitle,
    startWorkspaceRename,
    workspaceRenameInputRef,
    workspaceRenamingCommittedRef,
    commitWorkspaceRename,
    cancelWorkspaceRename,
  } = props;
  const workspaceRowRender = useMemo(() => <div role="button" tabIndex={0} />, []);
  const renderedThreadGroups = useMemo(() => {
    const orderByGroupKey = new Map<string, number>();
    for (const [index, thread] of availableThreads.entries()) {
      const groupKey = getSidebarWorkspaceThreadGroupKey({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        workspaceId: thread.workspaceId,
        worktreePath: thread.worktreePath,
      });
      if (!orderByGroupKey.has(groupKey)) {
        orderByGroupKey.set(groupKey, index);
      }
    }

    return buildSidebarWorkspaceThreadGroups({
      threads: availableThreads,
      allThreads: availableThreads,
      workspaces,
    }).sort((left, right) => {
      const leftOrder = orderByGroupKey.get(left.key) ?? Number.POSITIVE_INFINITY;
      const rightOrder = orderByGroupKey.get(right.key) ?? Number.POSITIVE_INFINITY;
      if (leftOrder === rightOrder) {
        return 0;
      }
      return leftOrder < rightOrder ? -1 : 1;
    });
  }, [availableThreads, workspaces]);
  const visibleThreadGroups = useMemo(
    () => renderedThreadGroups.filter((group) => !isSidebarImplicitDefaultWorkspaceGroup(group)),
    [renderedThreadGroups],
  );
  const createTargetForWorkspaceGroup = useCallback((group: SidebarWorkspaceRowGroup) => {
    if (group.workspaceId === undefined) {
      return null;
    }
    return {
      workspaceId: group.workspaceId,
      environmentId: group.environmentId,
      projectId: group.projectId,
      tabGroupId: group.threads[0]?.tabGroupId ?? group.threads[0]?.id ?? null,
      branch: group.branch,
      worktreePath: group.worktreePath,
    } satisfies SidebarWorkspaceCreateTarget;
  }, []);
  const openWorkspaceGroup = useCallback(
    (group: SidebarWorkspaceRowGroup) => {
      const targetThread = group.threads[0] ?? null;
      if (targetThread) {
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }
      const createTarget = createTargetForWorkspaceGroup(group);
      if (createTarget !== null) {
        void handleCreateSubChatForWorkspace(createTarget);
      }
    },
    [createTargetForWorkspaceGroup, handleCreateSubChatForWorkspace, navigateToThread],
  );

  return (
    <SidebarMenuSub
      ref={attachThreadListAutoAnimateRef}
      className="mx-0.5 my-0 w-full translate-x-0 gap-1 overflow-hidden px-1 py-1 sm:mx-1 sm:px-1.5"
    >
      {shouldShowThreadPanel && showEmptyThreadState && renderedThreadGroups.length === 0 ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
          >
            <span>No chats yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {shouldShowThreadPanel &&
        visibleThreadGroups.map((group) => {
          const workspaceStatus = workspaceStatusByKey.get(group.key) ?? null;
          const isWorkspaceActive = group.threads.some(
            (thread) =>
              activeRouteThreadKey ===
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          );
          const representativeThread = group.threads[0] ?? null;
          const activityAt = representativeThread
            ? (representativeThread.latestUserMessageAt ??
              representativeThread.updatedAt ??
              representativeThread.createdAt)
            : null;
          const createTarget = createTargetForWorkspaceGroup(group);
          const startRename = () => startWorkspaceRename(group);
          return (
            <SidebarMenuSubItem key={group.key} className="w-full" data-thread-selection-safe>
              <SidebarMenuSubButton
                render={workspaceRowRender}
                data-thread-selection-safe
                size="sm"
                isActive={isWorkspaceActive}
                className="group/workspace-row h-8 min-h-8 w-full translate-x-0 justify-start gap-2 rounded-md border-l-2 border-l-transparent px-2 text-left text-xs font-medium hover:bg-accent/70 data-[active=true]:border-l-primary data-[active=true]:bg-accent"
                onClick={() => openWorkspaceGroup(group)}
                onDoubleClick={startRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openWorkspaceGroup(group);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleWorkspaceContextMenu(group, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <SidebarWorkspacePrIndicator
                    group={group}
                    projectCwd={projectCwd}
                    openPrLink={openPrLink}
                  />
                  {workspaceStatus ? <ThreadStatusLabel status={workspaceStatus} compact /> : null}
                  {renamingWorkspaceKey === group.key ? (
                    <input
                      ref={(element) => {
                        if (element && workspaceRenameInputRef.current !== element) {
                          workspaceRenameInputRef.current = element;
                          element.focus();
                          element.select();
                        }
                      }}
                      className="h-5 min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-1 text-base outline-none sm:text-xs"
                      value={renamingWorkspaceTitle}
                      onChange={(event) => setRenamingWorkspaceTitle(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          event.preventDefault();
                          workspaceRenamingCommittedRef.current = true;
                          void commitWorkspaceRename(group, renamingWorkspaceTitle, group.title);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          workspaceRenamingCommittedRef.current = true;
                          cancelWorkspaceRename();
                        }
                      }}
                      onBlur={() => {
                        if (!workspaceRenamingCommittedRef.current) {
                          void commitWorkspaceRename(group, renamingWorkspaceTitle, group.title);
                        }
                      }}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{group.title}</span>
                  )}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {activityAt ? (
                    <span className="text-[10px] text-muted-foreground/40">
                      {formatRelativeTimeLabel(activityAt)}
                    </span>
                  ) : null}
                  {createTarget !== null ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={`Create new sub-chat in ${group.title}`}
                            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/45 opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring group-hover/workspace-row:opacity-100 group-focus-within/workspace-row:opacity-100 max-sm:opacity-100"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleCreateSubChatForWorkspace(createTarget);
                            }}
                          >
                            <SquarePenIcon className="size-3" />
                          </button>
                        }
                      />
                      <TooltipPopup side="top">New sub-chat</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          );
        })}
    </SidebarMenuSub>
  );
});

interface SidebarProjectItemProps {
  project: SidebarProjectSnapshot;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
}

const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProjectItemProps) {
  const {
    project,
    isThreadListExpanded,
    activeRouteThreadKey,
    newThreadShortcutLabel,
    handleNewThread,
    archiveThread,
    deleteThread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    isManualProjectSorting,
    dragHandleProps,
  } = props;
  const threadSortOrder = useSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const appSettingsConfirmThreadDelete = useSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const defaultThreadEnvMode = useSettings<ThreadEnvMode>(
    (settings) => settings.defaultThreadEnvMode,
  );
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const sidebarProjectFolders = useSettings((settings) => settings.sidebarProjectFolders);
  const sidebarProjectExpandedById = useSettings((settings) => settings.sidebarProjectExpandedById);
  const { updateSettings } = useUpdateSettings();
  const sidebarThreadPreviewCount = useSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const projectSourceControlScope = useMemo(
    () => ({
      environmentId: project.environmentId,
      cwd: project.cwd,
    }),
    [project.cwd, project.environmentId],
  );
  const projectGitStatus = useVcsStatus(projectSourceControlScope);
  const pullAction = useVcsPullAction(projectSourceControlScope);
  const syncBaseAction = useVcsSyncBaseAction(projectSourceControlScope);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
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
  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, []);
  const sidebarThreads = useStore(
    useShallow(
      useMemo(
        () => (state: import("../store").AppState) =>
          selectSidebarThreadsForProjectRefs(state, project.memberProjectRefs),
        [project.memberProjectRefs],
      ),
    ),
  );
  const sidebarWorkspaces = useStore(
    useShallow(
      useMemo(
        () => (state: import("../store").AppState) =>
          selectWorkspacesForProjectRefs(state, project.memberProjectRefs),
        [project.memberProjectRefs],
      ),
    ),
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Keep a ref so callbacks can read the latest map without appearing in
  // dependency arrays (avoids invalidating every thread-row memo on each
  // thread-list change).
  const sidebarThreadByKeyRef = useRef(sidebarThreadByKey);
  sidebarThreadByKeyRef.current = sidebarThreadByKey;
  const projectThreads = useMemo(
    () => sidebarThreads.filter(isSidebarTopLevelThread),
    [sidebarThreads],
  );
  const projectExpanded = sidebarProjectExpandedById[project.projectKey] ?? true;
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      sidebarThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const sidebarThreadsWithLastVisitedAt = useMemo(
    () =>
      sidebarThreads.flatMap((thread, index) => {
        if (thread.archivedAt !== null) {
          return [];
        }
        const lastVisitedAt = threadLastVisitedAts[index] ?? null;
        return [
          {
            ...thread,
            ...(lastVisitedAt !== null ? { lastVisitedAt } : {}),
          },
        ];
      }),
    [sidebarThreads, threadLastVisitedAts],
  );
  const threadStatusByTopLevelKey = useMemo(() => {
    return resolveGroupedThreadStatusPills({
      threads: sidebarThreadsWithLastVisitedAt,
      getGroupKey: (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, getSidebarTopLevelThreadId(thread))),
    });
  }, [sidebarThreadsWithLastVisitedAt]);
  const workspaceStatusByKey = useMemo(() => {
    return resolveGroupedThreadStatusPills({
      threads: sidebarThreadsWithLastVisitedAt,
      getGroupKey: (thread) =>
        getSidebarWorkspaceThreadGroupKey({
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          workspaceId: thread.workspaceId,
          worktreePath: thread.worktreePath,
        }),
    });
  }, [sidebarThreadsWithLastVisitedAt]);
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [renamingWorkspaceKey, setRenamingWorkspaceKey] = useState<string | null>(null);
  const [renamingWorkspaceTitle, setRenamingWorkspaceTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectRenameTitle, setProjectRenameTitle] = useState("");
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >("inherit");
  const [projectFolderTarget, setProjectFolderTarget] = useState<SidebarProjectSnapshot | null>(
    null,
  );
  const [projectFolderName, setProjectFolderName] = useState("");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceRenamingCommittedRef = useRef(false);
  const workspaceRenameInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const memberProjectByScopedKey = useMemo(
    () =>
      new Map(
        project.memberProjects.map((member) => [
          scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
          member,
        ]),
      ),
    [project.memberProjects],
  );
  const memberThreadCountByPhysicalKey = useMemo(() => {
    const counts = new Map<string, number>(
      project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
    );
    for (const thread of sidebarThreads) {
      const member = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!member) {
        continue;
      }
      counts.set(member.physicalProjectKey, (counts.get(member.physicalProjectKey) ?? 0) + 1);
    }
    return counts;
  }, [memberProjectByScopedKey, project.memberProjects, sidebarThreads]);

  const { projectStatus, visibleProjectThreads, orderedProjectThreadKeys } = useMemo(() => {
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      return (
        threadStatusByTopLevelKey.get(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ) ?? null
      );
    };
    const visibleProjectThreads = sortThreads(
      projectThreads.filter((thread) => thread.archivedAt === null),
      threadSortOrder,
    );
    const projectStatus = resolveProjectStatusIndicator(
      visibleProjectThreads.map((thread) => resolveProjectThreadStatus(thread)),
    );
    return {
      orderedProjectThreadKeys: visibleProjectThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
      projectStatus,
      visibleProjectThreads,
    };
  }, [projectThreads, threadSortOrder, threadStatusByTopLevelKey]);
  const workspaceThreadGroupsForProject = useMemo(
    () =>
      buildSidebarWorkspaceThreadGroups({
        threads: visibleProjectThreads,
        allThreads: visibleProjectThreads,
        workspaces: sidebarWorkspaces,
      }),
    [sidebarWorkspaces, visibleProjectThreads],
  );
  const hasVisibleWorkspaceRows = useMemo(
    () =>
      workspaceThreadGroupsForProject.some(
        (group) => !isSidebarImplicitDefaultWorkspaceGroup(group),
      ),
    [workspaceThreadGroupsForProject],
  );
  const defaultWorkspaceThreadRef = useMemo(() => {
    const defaultWorkspaceGroup = workspaceThreadGroupsForProject.find(
      isSidebarImplicitDefaultWorkspaceGroup,
    );
    const defaultThread = defaultWorkspaceGroup?.threads[0] ?? null;
    return defaultThread ? scopeThreadRef(defaultThread.environmentId, defaultThread.id) : null;
  }, [workspaceThreadGroupsForProject]);

  const pinnedCollapsedThread = useMemo(() => {
    const activeThreadKey = activeRouteThreadKey ?? undefined;
    if (!activeThreadKey || projectExpanded) {
      return null;
    }
    return (
      visibleProjectThreads.find(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
      ) ?? null
    );
  }, [activeRouteThreadKey, projectExpanded, visibleProjectThreads]);

  const {
    hasOverflowingThreads,
    hiddenThreadStatus,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
  } = useMemo(() => {
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      return (
        threadStatusByTopLevelKey.get(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ) ?? null
      );
    };
    const hasOverflowingThreads = visibleProjectThreads.length > sidebarThreadPreviewCount;
    const previewThreads =
      isThreadListExpanded || !hasOverflowingThreads
        ? visibleProjectThreads
        : visibleProjectThreads.slice(0, sidebarThreadPreviewCount);
    const visibleThreadKeys = new Set(
      [...previewThreads, ...(pinnedCollapsedThread ? [pinnedCollapsedThread] : [])].map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    );
    const renderedThreads = pinnedCollapsedThread
      ? [pinnedCollapsedThread]
      : visibleProjectThreads.filter((thread) =>
          visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
        );
    const hiddenThreads = visibleProjectThreads.filter(
      (thread) =>
        !visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    return {
      hasOverflowingThreads,
      hiddenThreadStatus: resolveProjectStatusIndicator(
        hiddenThreads.map((thread) => resolveProjectThreadStatus(thread)),
      ),
      renderedThreads,
      showEmptyThreadState: projectExpanded && visibleProjectThreads.length === 0,
      shouldShowThreadPanel: projectExpanded || pinnedCollapsedThread !== null,
    };
  }, [
    isThreadListExpanded,
    pinnedCollapsedThread,
    projectExpanded,
    projectThreads,
    sidebarThreadPreviewCount,
    threadStatusByTopLevelKey,
    visibleProjectThreads,
  ]);

  const toggleProjectExpanded = useCallback(() => {
    const nextExpanded = !projectExpanded;
    useUiStateStore.getState().setProjectExpanded(project.projectKey, nextExpanded);
    updateSettings({
      sidebarProjectExpandedById: setSidebarProjectExpandedValue(
        sidebarProjectExpandedById,
        project.projectKey,
        nextExpanded,
      ),
    });
  }, [project.projectKey, projectExpanded, sidebarProjectExpandedById, updateSettings]);

  const handleProjectButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      if (!hasVisibleWorkspaceRows) {
        if (defaultWorkspaceThreadRef) {
          setSelectionAnchor(scopedThreadKey(defaultWorkspaceThreadRef));
          if (isMobile) {
            setOpenMobile(false);
          }
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(defaultWorkspaceThreadRef),
          });
        }
        return;
      }
      toggleProjectExpanded();
    },
    [
      clearSelection,
      defaultWorkspaceThreadRef,
      dragInProgressRef,
      hasVisibleWorkspaceRows,
      isMobile,
      router,
      setOpenMobile,
      setSelectionAnchor,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
      toggleProjectExpanded,
    ],
  );

  const handleProjectButtonKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      if (!hasVisibleWorkspaceRows) {
        if (defaultWorkspaceThreadRef) {
          setSelectionAnchor(scopedThreadKey(defaultWorkspaceThreadRef));
          if (isMobile) {
            setOpenMobile(false);
          }
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(defaultWorkspaceThreadRef),
          });
        }
        return;
      }
      toggleProjectExpanded();
    },
    [
      defaultWorkspaceThreadRef,
      dragInProgressRef,
      hasVisibleWorkspaceRows,
      isMobile,
      router,
      setOpenMobile,
      setSelectionAnchor,
      toggleProjectExpanded,
    ],
  );

  const handleProjectButtonPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [suppressProjectClickAfterDragRef, suppressProjectClickForContextMenuRef],
  );

  const openProjectRenameDialog = useCallback((member: SidebarProjectGroupMember) => {
    setProjectRenameTarget(member);
    setProjectRenameTitle(member.name);
  }, []);

  const openProjectGroupingDialog = useCallback(
    (member: SidebarProjectGroupMember) => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      setProjectGroupingTarget(member);
      setProjectGroupingSelection(
        projectGroupingSettings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
      );
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides],
  );

  const openCreateProjectFolderDialog = useCallback((targetProject: SidebarProjectSnapshot) => {
    setProjectFolderTarget(targetProject);
    setProjectFolderName("");
  }, []);

  const closeCreateProjectFolderDialog = useCallback(() => {
    setProjectFolderTarget(null);
    setProjectFolderName("");
  }, []);

  const moveProjectToFolder = useCallback(
    (targetProject: SidebarProjectSnapshot, folderId: string) => {
      updateSettings({
        sidebarProjectFolders: moveSidebarProjectToFolder({
          folders: sidebarProjectFolders,
          folderId,
          projectKeys: getSidebarProjectPhysicalKeys(targetProject),
        }),
      });
    },
    [sidebarProjectFolders, updateSettings],
  );

  const removeProjectFromFolder = useCallback(
    (targetProject: SidebarProjectSnapshot) => {
      updateSettings({
        sidebarProjectFolders: removeSidebarProjectFromFolders({
          folders: sidebarProjectFolders,
          projectKeys: getSidebarProjectPhysicalKeys(targetProject),
        }),
      });
    },
    [sidebarProjectFolders, updateSettings],
  );

  const submitCreateProjectFolder = useCallback(() => {
    if (!projectFolderTarget) {
      return;
    }

    const trimmed = projectFolderName.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Folder name cannot be empty",
      });
      return;
    }

    const folderId = createSidebarProjectFolderId();
    updateSettings({
      sidebarProjectFolders: moveSidebarProjectToFolder({
        folders: [
          ...sidebarProjectFolders,
          {
            id: folderId,
            name: trimmed,
            projectKeys: [],
          },
        ],
        folderId,
        projectKeys: getSidebarProjectPhysicalKeys(projectFolderTarget),
      }),
    });
    closeCreateProjectFolderDialog();
  }, [
    closeCreateProjectFolderDialog,
    projectFolderName,
    projectFolderTarget,
    sidebarProjectFolders,
    updateSettings,
  ]);

  const removeProject = useCallback(
    async (member: SidebarProjectGroupMember, options: { force?: boolean } = {}): Promise<void> => {
      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const draftStore = useComposerDraftStore.getState();
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(memberProjectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(memberProjectRef);

      const projectApi = readEnvironmentApi(member.environmentId);
      if (!projectApi) {
        throw new Error("Project API unavailable.");
      }

      await projectApi.orchestration.dispatchCommand({
        type: "project.delete",
        commandId: newCommandId(),
        projectId: member.id,
        ...(options.force === true ? { force: true } : {}),
      });
    },
    [],
  );

  const handleRemoveProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const memberThreadCount = memberThreadCountByPhysicalKey.get(member.physicalProjectKey) ?? 0;
      if (memberThreadCount > 0) {
        const warningToastId = toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Project is not empty",
            description: "Delete all chats in this project before removing it.",
            actionVariant: "destructive",
            actionProps: {
              children: "Delete anyway",
              onClick: () => {
                void (async () => {
                  toastManager.close(warningToastId);
                  await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 180);
                  });

                  const latestProjectThreads = selectSidebarThreadsForProjectRefs(
                    useStore.getState(),
                    [memberProjectRef],
                  );
                  const confirmed = await api.dialogs.confirm(
                    latestProjectThreads.length > 0
                      ? [
                          `Remove project "${member.name}" and delete its ${latestProjectThreads.length} chat${
                            latestProjectThreads.length === 1 ? "" : "s"
                          }?`,
                          `Path: ${member.cwd}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This permanently clears conversation history for those chats.",
                          "This removes only this project entry.",
                          "This action cannot be undone.",
                        ].join("\n")
                      : [
                          `Remove project "${member.name}"?`,
                          `Path: ${member.cwd}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This removes only this project entry.",
                        ].join("\n"),
                  );
                  if (!confirmed) {
                    return;
                  }

                  await removeProject(member, { force: true });
                })().catch((error) => {
                  const message =
                    error instanceof Error ? error.message : "Unknown error removing project.";
                  console.error("Failed to remove project", {
                    projectId: member.id,
                    environmentId: member.environmentId,
                    error,
                  });
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Failed to remove "${member.name}"`,
                      description: message,
                    }),
                  );
                });
              },
            },
          }),
        );
        return;
      }

      const message = [
        `Remove project "${member.name}"?`,
        `Path: ${member.cwd}`,
        ...(member.environmentLabel ? [`Environment: ${member.environmentLabel}`] : []),
        "This removes only this project entry.",
      ].join("\n");
      const confirmed = await api.dialogs.confirm(message);
      if (!confirmed) {
        return;
      }

      try {
        await removeProject(member);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", {
          projectId: member.id,
          environmentId: member.environmentId,
          error,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to remove "${member.name}"`,
            description: message,
          }),
        );
      }
    },
    [memberThreadCountByPhysicalKey, removeProject],
  );

  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const actionHandlers = new Map<string, () => Promise<void> | void>();
        const makeLeaf = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          member: SidebarProjectGroupMember,
          options?: {
            destructive?: boolean;
            disabled?: boolean;
          },
        ): ContextMenuItem<string> => {
          const id = `${action}:${member.physicalProjectKey}`;
          actionHandlers.set(id, () => {
            switch (action) {
              case "rename":
                openProjectRenameDialog(member);
                return;
              case "grouping":
                openProjectGroupingDialog(member);
                return;
              case "copy-path":
                copyPathToClipboard(member.cwd, { path: member.cwd });
                return;
              case "delete":
                return handleRemoveProject(member);
            }
          });

          return {
            id,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
            ...(options?.destructive ? { destructive: true } : {}),
            ...(options?.disabled ? { disabled: true } : {}),
          };
        };

        const buildTargetedItem = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          label: string,
          options?: {
            destructive?: boolean;
            isDisabled?: (member: SidebarProjectGroupMember) => boolean;
          },
        ): ContextMenuItem<string> => {
          if (project.memberProjects.length === 1) {
            const singleMember = project.memberProjects[0]!;
            return {
              ...makeLeaf(action, singleMember, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(singleMember) ? { disabled: true } : {}),
              }),
              label,
            };
          }

          return {
            id: `${action}:submenu`,
            label,
            children: project.memberProjects.map((member) =>
              makeLeaf(action, member, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(member) ? { disabled: true } : {}),
              }),
            ),
          };
        };

        const projectPhysicalKeys = getSidebarProjectPhysicalKeys(project);
        const currentFolder = findSidebarProjectFolderForProject(sidebarProjectFolders, project);
        actionHandlers.set("folder:new", () => {
          openCreateProjectFolderDialog(project);
        });
        actionHandlers.set("folder:remove", () => {
          removeProjectFromFolder(project);
        });
        const folderItems: ContextMenuItem<string>[] = [
          {
            id: "folder:new",
            label: "New folder…",
          },
        ];
        const moveFolderItems = sidebarProjectFolders
          .filter((folder) => folder.id !== currentFolder?.id)
          .map((folder) => {
            const id = `folder:move:${folder.id}`;
            actionHandlers.set(id, () => {
              moveProjectToFolder(project, folder.id);
            });
            return {
              id,
              label: folder.name,
            } satisfies ContextMenuItem<string>;
          });
        if (moveFolderItems.length > 0) {
          folderItems.push({
            id: "folder:move",
            label: "Move to folder",
            children: moveFolderItems,
          });
        }
        if (currentFolder) {
          folderItems.push({
            id: "folder:remove",
            label: `Remove from ${currentFolder.name}`,
          });
        }

        const clicked = await api.contextMenu.show(
          [
            buildTargetedItem("rename", "Rename project"),
            buildTargetedItem("grouping", "Project grouping…"),
            {
              id: "folder:submenu",
              label:
                projectPhysicalKeys.length > 1
                  ? `Organize ${projectPhysicalKeys.length} projects`
                  : "Organize project",
              children: folderItems,
            },
            buildTargetedItem("copy-path", "Copy Project Path"),
            buildTargetedItem("delete", "Remove project", {
              destructive: true,
            }),
          ],
          {
            x: event.clientX,
            y: event.clientY,
          },
        );

        if (!clicked) {
          return;
        }

        await actionHandlers.get(clicked)?.();
      })();
    },
    [
      copyPathToClipboard,
      handleRemoveProject,
      moveProjectToFolder,
      openProjectGroupingDialog,
      openCreateProjectFolderDialog,
      openProjectRenameDialog,
      project,
      removeProjectFromFolder,
      sidebarProjectFolders,
      suppressProjectClickForContextMenuRef,
    ],
  );

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const handleThreadClick = useCallback(
    (
      event: React.MouseEvent,
      threadRef: ScopedThreadRef,
      orderedProjectThreadKeys: readonly string[],
    ) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;
      const threadKey = scopedThreadKey(threadRef);
      const currentSelectionCount = useThreadSelectionStore.getState().selectedThreadKeys.size;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedProjectThreadKeys);
        return;
      }

      if (currentSelectionCount > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadKey);
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [
      clearSelection,
      isMobile,
      rangeSelectTo,
      router,
      setOpenMobile,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = sidebarThreadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} chat${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these chats.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedThreadKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = sidebarThreadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
      }
      removeFromSelection(threadKeys);
    },
    [
      appSettingsConfirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );

  const startWorkspaceRename = useCallback((group: SidebarWorkspaceRowGroup) => {
    if (group.workspaceId === undefined) {
      return;
    }
    setRenamingWorkspaceKey(group.key);
    setRenamingWorkspaceTitle(group.title);
    workspaceRenamingCommittedRef.current = false;
  }, []);

  const handleCreateSubChatForWorkspace = useCallback(
    async (target: SidebarWorkspaceCreateTarget) => {
      const member =
        memberProjectByScopedKey.get(
          scopedProjectKey(scopeProjectRef(target.environmentId, target.projectId)),
        ) ?? null;
      if (!member) {
        return;
      }

      const api = readEnvironmentApi(target.environmentId);
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Environment unavailable",
          description: "Could not create a sub-chat because the environment is disconnected.",
        });
        return;
      }

      const threadId = newThreadId();
      const threadRef = scopeThreadRef(target.environmentId, threadId);
      const createdAt = new Date().toISOString();
      const commandId = newCommandId();
      const modelSelection =
        member.defaultModelSelection ??
        createModelSelection(
          defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
          DEFAULT_MODEL,
        );

      try {
        const command = {
          type: "thread.create",
          commandId,
          threadId,
          projectId: target.projectId,
          workspaceId: target.workspaceId,
          tabGroupId: target.tabGroupId ?? threadId,
          tabType: "chat",
          title: "New Chat",
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: target.branch,
          worktreePath: target.worktreePath,
          createdAt,
        } as const;
        const result = await api.orchestration.dispatchCommand(command);

        useStore.getState().applyOrchestrationEvent(
          {
            sequence: result.sequence,
            eventId: EventId.make(`client-confirmed:${commandId}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: createdAt,
            commandId,
            causationEventId: null,
            correlationId: commandId,
            metadata: {},
            type: "thread.created",
            payload: {
              threadId,
              projectId: target.projectId,
              workspaceId: target.workspaceId,
              tabGroupId: target.tabGroupId ?? threadId,
              tabType: "chat",
              title: "New Chat",
              modelSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_INTERACTION_MODE,
              branch: target.branch,
              worktreePath: target.worktreePath,
              createdAt,
              updatedAt: createdAt,
            },
          },
          target.environmentId,
        );

        const threadShellReady = await waitForThreadShell(threadRef);
        if (!threadShellReady) {
          throw new Error("Created sub-chat is not available in the local thread state yet.");
        }
        if (isMobile) {
          setOpenMobile(false);
        }
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create sub-chat",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [isMobile, memberProjectByScopedKey, router, setOpenMobile],
  );

  const createTargetForWorkspaceGroup = useCallback(
    (group: SidebarWorkspaceRowGroup): SidebarWorkspaceCreateTarget | null => {
      if (group.workspaceId === undefined) {
        return null;
      }
      return {
        workspaceId: group.workspaceId,
        environmentId: group.environmentId,
        projectId: group.projectId,
        tabGroupId: group.threads[0]?.tabGroupId ?? group.threads[0]?.id ?? null,
        branch: group.branch,
        worktreePath: group.worktreePath,
      };
    },
    [],
  );

  const handleWorkspaceContextMenu = useCallback(
    async (group: SidebarWorkspaceRowGroup, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;

      const clicked = await api.contextMenu.show(
        [
          ...(group.workspaceId !== undefined ? [{ id: "rename", label: "Rename workspace" }] : []),
          ...(createTargetForWorkspaceGroup(group) !== null
            ? [{ id: "new-sub-chat", label: "New sub-chat" }]
            : []),
          ...(group.workspaceId !== undefined
            ? [{ id: "archive", label: "Archive workspace", destructive: true }]
            : []),
        ],
        position,
      );

      if (clicked === "rename") {
        startWorkspaceRename(group);
        return;
      }

      if (clicked === "new-sub-chat") {
        const target = createTargetForWorkspaceGroup(group);
        if (target !== null) {
          await handleCreateSubChatForWorkspace(target);
        }
        return;
      }

      if (clicked === "archive" && group.workspaceId !== undefined) {
        const confirmed = await api.dialogs.confirm(
          [
            `Archive workspace "${group.title}"?`,
            "This hides the workspace from the sidebar. Active sub-chats or actions must be stopped first.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }

        const environmentApi = readEnvironmentApi(group.environmentId);
        if (!environmentApi) {
          toastManager.add({
            type: "error",
            title: "Environment unavailable",
            description: "Could not archive the workspace because the environment is disconnected.",
          });
          return;
        }

        try {
          await environmentApi.orchestration.dispatchCommand({
            type: "workspace.archive",
            commandId: newCommandId(),
            workspaceId: group.workspaceId,
          });
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not archive workspace",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      }
    },
    [createTargetForWorkspaceGroup, handleCreateSubChatForWorkspace, startWorkspaceRename],
  );

  const createThreadForProjectMember = useCallback(
    (member: SidebarProjectGroupMember) => {
      const currentRouteParams =
        router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const currentRouteTarget = resolveThreadRouteTarget(currentRouteParams);
      const currentActiveThread =
        currentRouteTarget?.kind === "server"
          ? (selectThreadByRef(useStore.getState(), currentRouteTarget.threadRef) ?? null)
          : null;
      const draftStore = useComposerDraftStore.getState();
      const currentActiveDraftThread =
        currentRouteTarget?.kind === "server"
          ? (draftStore.getDraftThread(currentRouteTarget.threadRef) ?? null)
          : currentRouteTarget?.kind === "draft"
            ? (draftStore.getDraftSession(currentRouteTarget.draftId) ?? null)
            : null;
      const seedContext = resolveSidebarNewThreadSeedContext({
        projectId: member.id,
        defaultEnvMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: defaultThreadEnvMode,
        }),
        activeThread:
          currentActiveThread && currentActiveThread.projectId === member.id
            ? {
                projectId: currentActiveThread.projectId,
                branch: currentActiveThread.branch,
                worktreePath: currentActiveThread.worktreePath,
              }
            : null,
        activeDraftThread:
          currentActiveDraftThread && currentActiveDraftThread.projectId === member.id
            ? {
                projectId: currentActiveDraftThread.projectId,
                branch: currentActiveDraftThread.branch,
                worktreePath: currentActiveDraftThread.worktreePath,
                envMode: currentActiveDraftThread.envMode,
                ...(currentActiveDraftThread.worktreeMode
                  ? { worktreeMode: currentActiveDraftThread.worktreeMode }
                  : {}),
              }
            : null,
      });
      if (isMobile) {
        setOpenMobile(false);
      }
      void handleNewThread(scopeProjectRef(member.environmentId, member.id), {
        ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
        ...(seedContext.worktreePath !== undefined
          ? { worktreePath: seedContext.worktreePath }
          : {}),
        envMode: seedContext.envMode,
        ...(seedContext.worktreeMode ? { worktreeMode: seedContext.worktreeMode } : {}),
        useProjectDefault: true,
      });
    },
    [defaultThreadEnvMode, handleNewThread, isMobile, router, setOpenMobile],
  );

  const handleCreateThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (project.memberProjects.length === 1) {
        createThreadForProjectMember(project.memberProjects[0]!);
        return;
      }

      void (async () => {
        const api = readLocalApi();
        if (!api) {
          return;
        }
        const clicked = await api.contextMenu.show(
          project.memberProjects.map((member) => ({
            id: member.physicalProjectKey,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
          })),
          {
            x: event.clientX,
            y: event.clientY,
          },
        );
        if (!clicked) {
          return;
        }
        const targetMember = project.memberProjects.find(
          (member) => member.physicalProjectKey === clicked,
        );
        if (!targetMember) {
          return;
        }
        createThreadForProjectMember(targetMember);
      })();
    },
    [createThreadForProjectMember, project.groupedProjectCount, project.memberProjects],
  );
  const projectRepoUpdateAction = useMemo(() => {
    const gitStatus = projectGitStatus.data;
    if (!gitStatus?.isRepo || gitStatus.refName === null) {
      return null;
    }
    if (gitStatus.behindCount > 0) {
      return {
        kind: "pull" as const,
        label: "Pull",
        ariaLabel: `Pull ${project.displayName}`,
        tooltip: "Pull before starting a new thread",
      };
    }
    if (
      !gitStatus.isDefaultRef &&
      !gitStatus.hasWorkingTreeChanges &&
      (gitStatus.behindOfDefaultCount ?? 0) > 0
    ) {
      return {
        kind: "rebase" as const,
        label: "Rebase",
        ariaLabel: `Rebase ${project.displayName}`,
        tooltip: "Rebase before starting a new thread",
      };
    }
    return null;
  }, [project.displayName, projectGitStatus.data]);
  const isProjectRepoUpdatePending = pullAction.isPending || syncBaseAction.isPending;
  const handleProjectRepoUpdateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!projectRepoUpdateAction || isProjectRepoUpdatePending) {
        return;
      }

      if (projectRepoUpdateAction.kind === "pull") {
        const promise = pullAction.run();
        void toastManager.promise<Awaited<ReturnType<typeof pullAction.run>>, ThreadToastData>(
          promise,
          {
            loading: { title: "Pulling..." },
            success: (result) => ({
              title: result.status === "pulled" ? "Pulled" : "Already up to date",
              description:
                result.status === "pulled"
                  ? `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}.`
                  : `${result.refName} is already synchronized.`,
            }),
            error: (err) => ({
              title: "Pull failed",
              description: err instanceof Error ? err.message : "An error occurred.",
            }),
          },
        );
        void promise.catch(() => undefined);
        return;
      }

      const promise = syncBaseAction.run();
      void toastManager.promise<Awaited<ReturnType<typeof syncBaseAction.run>>, ThreadToastData>(
        promise,
        {
          loading: { title: "Rebasing..." },
          success: (result) => ({
            title: result.status === "rebased" ? "Rebased" : "Already up to date",
            description:
              result.status === "rebased"
                ? `Rebased ${result.refName} onto ${result.baseRef}.`
                : `${result.refName} already includes ${result.baseRef}.`,
          }),
          error: (err) => ({
            title: "Rebase failed",
            description: err instanceof Error ? err.message : "An error occurred.",
          }),
        },
      );
      void promise.catch(() => undefined);
    },
    [isProjectRepoUpdatePending, projectRepoUpdateAction, pullAction, syncBaseAction],
  );

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await archiveThread(threadRef);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, newTitle: string, originalTitle: string) => {
      const threadKey = scopedThreadKey(threadRef);
      const finishRename = () => {
        setRenamingThreadKey((current) => {
          if (current !== threadKey) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      finishRename();
    },
    [],
  );

  const cancelWorkspaceRename = useCallback(() => {
    setRenamingWorkspaceKey(null);
    setRenamingWorkspaceTitle("");
    workspaceRenameInputRef.current = null;
  }, []);

  const commitWorkspaceRename = useCallback(
    async (group: SidebarWorkspaceRowGroup, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingWorkspaceKey((current) => {
          if (current !== group.key) return current;
          workspaceRenameInputRef.current = null;
          return null;
        });
        setRenamingWorkspaceTitle("");
      };

      if (group.workspaceId === undefined) {
        finishRename();
        return;
      }

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Workspace name cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }

      const api = readEnvironmentApi(group.environmentId);
      if (!api) {
        finishRename();
        return;
      }

      try {
        await api.orchestration.dispatchCommand({
          type: "workspace.meta.update",
          commandId: newCommandId(),
          workspaceId: group.workspaceId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename workspace",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      finishRename();
    },
    [],
  );

  const closeProjectRenameDialog = useCallback(() => {
    setProjectRenameTarget(null);
    setProjectRenameTitle("");
  }, []);

  const submitProjectRename = useCallback(async () => {
    if (!projectRenameTarget) {
      return;
    }

    const trimmed = projectRenameTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Project title cannot be empty",
      });
      return;
    }

    if (trimmed === projectRenameTarget.name) {
      closeProjectRenameDialog();
      return;
    }

    const api = readEnvironmentApi(projectRenameTarget.environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: "Project API unavailable.",
        }),
      );
      return;
    }

    try {
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: projectRenameTarget.id,
        title: trimmed,
      });
      closeProjectRenameDialog();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [closeProjectRenameDialog, projectRenameTarget, projectRenameTitle]);

  const closeProjectGroupingDialog = useCallback(() => {
    setProjectGroupingTarget(null);
    setProjectGroupingSelection("inherit");
  }, []);

  const saveProjectGroupingPreference = useCallback(() => {
    if (!projectGroupingTarget) {
      return;
    }

    const overrideKey = deriveProjectGroupingOverrideKey(projectGroupingTarget);
    const nextOverrides = {
      ...projectGroupingSettings.sidebarProjectGroupingOverrides,
    };
    if (projectGroupingSelection === "inherit") {
      delete nextOverrides[overrideKey];
    } else {
      nextOverrides[overrideKey] = projectGroupingSelection;
    }
    updateSettings({
      sidebarProjectGroupingOverrides: nextOverrides,
    });
    closeProjectGroupingDialog();
  }, [
    closeProjectGroupingDialog,
    projectGroupingSelection,
    projectGroupingSettings.sidebarProjectGroupingOverrides,
    projectGroupingTarget,
    updateSettings,
  ]);

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const threadProject = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      const threadWorkspacePath = thread.worktreePath ?? threadProject?.cwd ?? project.cwd ?? null;
      const deleteBlockedByActiveSession = isThreadDeleteBlockedByActiveSession(thread.session);
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          deleteBlockedByActiveSession
            ? { id: "stop-and-delete", label: "Stop and delete", destructive: true }
            : { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingThreadKey(threadKey);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadKey, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Path unavailable",
              description: "This thread does not have a workspace path to copy.",
            }),
          );
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (clicked !== "delete" && clicked !== "stop-and-delete") return;
      if (appSettingsConfirmThreadDelete) {
        const isStopAndDelete = clicked === "stop-and-delete";
        const confirmed = await api.dialogs.confirm(
          isStopAndDelete
            ? [
                `Stop and delete thread "${thread.title}"?`,
                "This stops the running action and permanently clears conversation history for this thread.",
              ].join("\n")
            : [
                `Delete chat "${thread.title}"?`,
                "This permanently clears conversation history for this thread.",
              ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      try {
        await deleteThread(threadRef, { stopRunning: clicked === "stop-and-delete" });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: clicked === "stop-and-delete" ? "Could not stop and delete" : "Could not delete",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [
      appSettingsConfirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      memberProjectByScopedKey,
      project.cwd,
    ],
  );

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={cn(
            "gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground",
            projectRepoUpdateAction ? "pr-16 max-sm:pr-24" : "pr-8 max-sm:pr-14",
            isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          )}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          onPointerDownCapture={handleProjectButtonPointerDownCapture}
          onClick={handleProjectButtonClick}
          onKeyDown={handleProjectButtonKeyDown}
          onContextMenu={handleProjectButtonContextMenu}
        >
          {!hasVisibleWorkspaceRows && projectStatus ? (
            <span
              aria-hidden="true"
              title={projectStatus.label}
              className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
            >
              <span
                className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                  projectStatus.pulse ? "animate-pulse" : ""
                }`}
              />
            </span>
          ) : !hasVisibleWorkspaceRows ? (
            <span aria-hidden="true" className="-ml-0.5 size-3.5 shrink-0" />
          ) : !projectExpanded && projectStatus ? (
            <span
              aria-hidden="true"
              title={projectStatus.label}
              className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
            >
              <span
                className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                  projectStatus.pulse ? "animate-pulse" : ""
                }`}
              />
            </span>
          ) : (
            <span aria-hidden="true" className="-ml-0.5 size-3.5 shrink-0" />
          )}
          <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-xs font-medium text-foreground/90">
              {project.displayName}
            </span>
            {project.groupedProjectCount > 1 ? (
              <span className="shrink-0 text-[10px] text-muted-foreground/60">
                {project.groupedProjectCount} projects
              </span>
            ) : null}
          </span>
        </SidebarMenuButton>
        {/* Environment badge – visible by default, shifting left when a repo update action is pinned. */}
        {project.environmentPresence === "remote-only" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={
                    project.environmentPresence === "remote-only"
                      ? "Remote project"
                      : "Available in multiple environments"
                  }
                  className={cn(
                    "pointer-events-none absolute top-1 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/60 transition-opacity duration-150",
                    projectRepoUpdateAction
                      ? "right-14 max-sm:right-[4.75rem]"
                      : "right-1.5 max-sm:right-7 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 max-sm:group-hover/project-header:opacity-100 max-sm:group-focus-within/project-header:opacity-100",
                  )}
                />
              }
            >
              <CloudIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              Remote environment: {project.remoteEnvironmentLabels.join(", ")}
            </TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                className={cn(
                  "absolute top-1 right-1.5 transition-opacity duration-150",
                  projectRepoUpdateAction
                    ? "pointer-events-auto opacity-100"
                    : "pointer-events-none opacity-0 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100",
                )}
              >
                {projectRepoUpdateAction ? (
                  <button
                    type="button"
                    aria-label={projectRepoUpdateAction.ariaLabel}
                    data-testid="project-repo-update-button"
                    className="inline-flex h-5 min-w-12 cursor-pointer items-center justify-center gap-1 rounded-md border border-yellow-500/75 bg-yellow-500/10 px-1.5 text-[10px] font-medium text-yellow-700 transition-colors hover:border-yellow-500 hover:bg-yellow-500/15 hover:text-yellow-800 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-yellow-500/70 disabled:cursor-wait disabled:opacity-70 dark:border-yellow-400/65 dark:bg-yellow-400/10 dark:text-yellow-300 dark:hover:border-yellow-300 dark:hover:bg-yellow-400/15 dark:hover:text-yellow-200"
                    disabled={isProjectRepoUpdatePending}
                    onClick={handleProjectRepoUpdateClick}
                  >
                    <DownloadIcon className="size-3" />
                    <span>{projectRepoUpdateAction.label}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`Create new chat in ${project.displayName}`}
                    data-testid="new-thread-button"
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={handleCreateThreadClick}
                  >
                    <SquarePenIcon className="size-3.5" />
                  </button>
                )}
              </div>
            }
          />
          <TooltipPopup side="top">
            {projectRepoUpdateAction
              ? projectRepoUpdateAction.tooltip
              : newThreadShortcutLabel
                ? `New chat (${newThreadShortcutLabel})`
                : "New chat"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <SidebarProjectThreadList
        projectKey={project.projectKey}
        projectExpanded={projectExpanded}
        hasOverflowingThreads={hasOverflowingThreads}
        hiddenThreadStatus={hiddenThreadStatus}
        orderedProjectThreadKeys={orderedProjectThreadKeys}
        workspaces={sidebarWorkspaces}
        availableThreads={visibleProjectThreads}
        renderedThreads={renderedThreads}
        threadStatusByKey={threadStatusByTopLevelKey}
        workspaceStatusByKey={workspaceStatusByKey}
        showEmptyThreadState={showEmptyThreadState}
        shouldShowThreadPanel={shouldShowThreadPanel}
        isThreadListExpanded={isThreadListExpanded}
        projectCwd={project.cwd}
        activeRouteThreadKey={activeRouteThreadKey}
        threadJumpLabelByKey={threadJumpLabelByKey}
        appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
        renamingThreadKey={renamingThreadKey}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadKey={confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        handleCreateSubChatForWorkspace={handleCreateSubChatForWorkspace}
        handleWorkspaceContextMenu={handleWorkspaceContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
        renamingWorkspaceKey={renamingWorkspaceKey}
        renamingWorkspaceTitle={renamingWorkspaceTitle}
        setRenamingWorkspaceTitle={setRenamingWorkspaceTitle}
        startWorkspaceRename={startWorkspaceRename}
        workspaceRenameInputRef={workspaceRenameInputRef}
        workspaceRenamingCommittedRef={workspaceRenamingCommittedRef}
        commitWorkspaceRename={commitWorkspaceRename}
        cancelWorkspaceRename={cancelWorkspaceRename}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
      />

      <Dialog
        open={projectRenameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRenameDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              {projectRenameTarget
                ? `Update the title for ${projectRenameTarget.cwd}.`
                : "Update the project title."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Project title</span>
              <Input
                aria-label="Project title"
                value={projectRenameTitle}
                onChange={(event) => setProjectRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitProjectRename();
                  }
                }}
              />
            </div>
            {projectRenameTarget?.environmentLabel ? (
              <p className="text-xs text-muted-foreground">
                Environment: {projectRenameTarget.environmentLabel}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRenameDialog}>
              Cancel
            </Button>
            <Button onClick={() => void submitProjectRename()}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={projectGroupingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectGroupingDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Project grouping</DialogTitle>
            <DialogDescription>
              {projectGroupingTarget
                ? `Choose how ${projectGroupingTarget.cwd} should be grouped in the sidebar.`
                : "Choose how this project should be grouped in the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Grouping rule</span>
              <Select
                value={projectGroupingSelection}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    setProjectGroupingSelection(value);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Project grouping rule">
                  <SelectValue>
                    {projectGroupingSelection === "inherit"
                      ? `Use global default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
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
            </div>
            <p className="text-xs text-muted-foreground">
              {projectGroupingSelection === "inherit"
                ? projectGroupingModeDescription(projectGroupingSettings.sidebarProjectGroupingMode)
                : projectGroupingModeDescription(projectGroupingSelection)}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectGroupingDialog}>
              Cancel
            </Button>
            <Button onClick={saveProjectGroupingPreference}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={projectFolderTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeCreateProjectFolderDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              {projectFolderTarget
                ? `Create a folder containing ${projectFolderTarget.displayName}.`
                : "Create a project folder."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Folder name</span>
              <Input
                aria-label="Folder name"
                autoFocus
                value={projectFolderName}
                onChange={(event) => setProjectFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitCreateProjectFolder();
                  }
                }}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeCreateProjectFolderDialog}>
              Cancel
            </Button>
            <Button onClick={submitCreateProjectFolder}>Create</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});

const SidebarProjectListRow = memo(function SidebarProjectListRow(props: SidebarProjectItemProps) {
  return (
    <SidebarMenuItem className="rounded-md">
      <SidebarProjectItem {...props} />
    </SidebarMenuItem>
  );
});

type SidebarProjectFolderView = Extract<
  SidebarProjectFolderEntry<SidebarProjectSnapshot>,
  { kind: "folder" }
>;

interface SidebarProjectFolderRowProps extends Omit<
  SidebarProjectItemProps,
  "project" | "isThreadListExpanded" | "activeRouteThreadKey"
> {
  folderEntry: SidebarProjectFolderView;
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  renderContainer?: boolean;
}

const SidebarProjectFolderRow = memo(function SidebarProjectFolderRow(
  props: SidebarProjectFolderRowProps,
) {
  const {
    folderEntry,
    expandedThreadListsByProject,
    activeRouteProjectKey,
    routeThreadKey,
    isManualProjectSorting,
    dragHandleProps,
    renderContainer = true,
    ...projectItemProps
  } = props;
  const sidebarProjectFolders = useSettings((settings) => settings.sidebarProjectFolders);
  const sidebarProjectExpandedById = useSettings((settings) => settings.sidebarProjectExpandedById);
  const { updateSettings } = useUpdateSettings();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const activeOrganizationId = useParams({
    strict: false,
    select: (params) => (typeof params.organizationId === "string" ? params.organizationId : null),
  });
  const folderExpanded = sidebarProjectExpandedById[folderEntry.folderKey] ?? true;
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(folderEntry.folder.name);

  useEffect(() => {
    if (!renameOpen) {
      setRenameValue(folderEntry.folder.name);
    }
  }, [folderEntry.folder.name, renameOpen]);

  const closeRenameDialog = useCallback(() => {
    setRenameOpen(false);
    setRenameValue(folderEntry.folder.name);
  }, [folderEntry.folder.name]);

  const submitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Folder name cannot be empty",
      });
      return;
    }
    updateSettings({
      sidebarProjectFolders: sidebarProjectFolders.map((folder) =>
        folder.id === folderEntry.folder.id ? { ...folder, name: trimmed } : folder,
      ),
    });
    setRenameOpen(false);
  }, [folderEntry.folder.id, renameValue, sidebarProjectFolders, updateSettings]);

  const deleteFolder = useCallback(() => {
    updateSettings({
      sidebarProjectFolders: sidebarProjectFolders.filter(
        (folder) => folder.id !== folderEntry.folder.id,
      ),
    });
  }, [folderEntry.folder.id, sidebarProjectFolders, updateSettings]);

  const setFolderIconProjectKey = useCallback(
    (iconProjectKey: string | null) => {
      updateSettings({
        sidebarProjectFolders: sidebarProjectFolders.map((folder) => {
          if (folder.id !== folderEntry.folder.id) {
            return folder;
          }
          if (iconProjectKey === null) {
            const { iconProjectKey: _iconProjectKey, ...nextFolder } = folder;
            return nextFolder;
          }
          return {
            ...folder,
            iconProjectKey,
          };
        }),
      });
    },
    [folderEntry.folder.id, sidebarProjectFolders, updateSettings],
  );

  const handleFolderContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      projectItemProps.suppressProjectClickForContextMenuRef.current = true;
      void (async () => {
        const api = readLocalApi();
        if (!api) {
          return;
        }
        const actionHandlers = new Map<string, () => void>();
        actionHandlers.set("rename", () => {
          setRenameOpen(true);
        });
        actionHandlers.set("delete", () => {
          deleteFolder();
        });
        actionHandlers.set("icon:auto", () => {
          setFolderIconProjectKey(null);
        });
        const iconItems: ContextMenuItem<string>[] = [
          {
            id: "icon:auto",
            label: folderEntry.folder.iconProjectKey ? "Automatic" : "Automatic (current)",
          },
        ];
        for (const project of folderEntry.projects) {
          const projectIconKey = getSidebarProjectPhysicalKeys(project)[0];
          if (!projectIconKey) {
            continue;
          }
          const id = `icon:${projectIconKey}`;
          const isSelected = projectIconKey === folderEntry.folder.iconProjectKey;
          actionHandlers.set(id, () => {
            setFolderIconProjectKey(projectIconKey);
          });
          iconItems.push({
            id,
            label: isSelected ? `${project.displayName} (current)` : project.displayName,
          });
        }
        const clicked = await api.contextMenu.show(
          [
            { id: "rename", label: "Rename folder" },
            { id: "icon:submenu", label: "Folder icon", children: iconItems },
            { id: "delete", label: "Remove folder" },
          ],
          {
            x: event.clientX,
            y: event.clientY,
          },
        );
        actionHandlers.get(clicked ?? "")?.();
      })();
    },
    [
      deleteFolder,
      folderEntry.folder.iconProjectKey,
      folderEntry.projects,
      projectItemProps.suppressProjectClickForContextMenuRef,
      setFolderIconProjectKey,
    ],
  );

  const handleFolderClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (projectItemProps.suppressProjectClickForContextMenuRef.current) {
        projectItemProps.suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (projectItemProps.dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (projectItemProps.suppressProjectClickAfterDragRef.current) {
        projectItemProps.suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const nextExpanded = !folderExpanded;
      useUiStateStore.getState().setProjectExpanded(folderEntry.folderKey, nextExpanded);
      updateSettings({
        sidebarProjectExpandedById: setSidebarProjectExpandedValue(
          sidebarProjectExpandedById,
          folderEntry.folderKey,
          nextExpanded,
        ),
      });
    },
    [
      folderEntry.folderKey,
      folderExpanded,
      projectItemProps.dragInProgressRef,
      projectItemProps.suppressProjectClickAfterDragRef,
      projectItemProps.suppressProjectClickForContextMenuRef,
      sidebarProjectExpandedById,
      updateSettings,
    ],
  );

  const handleFolderPanelClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (projectItemProps.suppressProjectClickForContextMenuRef.current) {
        projectItemProps.suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (projectItemProps.dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (projectItemProps.suppressProjectClickAfterDragRef.current) {
        projectItemProps.suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (useThreadSelectionStore.getState().hasSelection()) {
        useThreadSelectionStore.getState().clearSelection();
      }
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/organizations/$organizationId",
        params: { organizationId: folderEntry.folder.id },
      });
    },
    [
      folderEntry.folder.id,
      isMobile,
      navigate,
      projectItemProps.dragInProgressRef,
      projectItemProps.suppressProjectClickAfterDragRef,
      projectItemProps.suppressProjectClickForContextMenuRef,
      setOpenMobile,
    ],
  );

  const handleFolderPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      projectItemProps.suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        event.stopPropagation();
      }

      projectItemProps.suppressProjectClickAfterDragRef.current = false;
    },
    [
      projectItemProps.suppressProjectClickAfterDragRef,
      projectItemProps.suppressProjectClickForContextMenuRef,
    ],
  );

  const content = (
    <>
      <div className="flex w-full gap-1">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={cn(
            "min-w-0 flex-1 basis-1/2 gap-2 px-2 py-1.5 text-left hover:bg-accent",
            isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          )}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          aria-label={`${folderExpanded ? "Collapse" : "Expand"} ${folderEntry.folder.name}`}
          onPointerDownCapture={handleFolderPointerDownCapture}
          onClick={handleFolderClick}
          onContextMenu={handleFolderContextMenu}
        >
          <span aria-hidden="true" className="-ml-0.5 size-3.5 shrink-0" />
          <ProjectFavicon
            environmentId={folderEntry.iconProject.environmentId}
            cwd={folderEntry.iconProject.cwd}
          />
          <span className="truncate text-xs font-medium text-foreground/90">
            {folderEntry.folder.name}
          </span>
        </SidebarMenuButton>
        <SidebarMenuButton
          size="sm"
          isActive={activeOrganizationId === folderEntry.folder.id}
          className="min-w-0 flex-1 basis-1/2 justify-end gap-2 px-2 py-1.5 text-right text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          aria-label={`Open ${folderEntry.folder.name} organization panel`}
          onPointerDownCapture={handleFolderPointerDownCapture}
          onClick={handleFolderPanelClick}
          onContextMenu={handleFolderContextMenu}
        >
          <PanelTopIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="min-w-0 flex-none truncate text-xs font-medium">Panel</span>
        </SidebarMenuButton>
      </div>

      <Collapsible open={folderExpanded}>
        <CollapsibleContent>
          <SidebarMenuSub className="mx-3 py-0.5 pr-0">
            {isManualProjectSorting ? (
              <SortableContext
                items={folderEntry.projects.map((project) => project.projectKey)}
                strategy={verticalListSortingStrategy}
              >
                {folderEntry.projects.map((project) => (
                  <SortableProjectItem key={project.projectKey} projectId={project.projectKey}>
                    {(folderProjectDragHandleProps) => (
                      <SidebarProjectItem
                        {...projectItemProps}
                        project={project}
                        isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                        activeRouteThreadKey={
                          activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                        }
                        isManualProjectSorting={true}
                        dragHandleProps={folderProjectDragHandleProps}
                      />
                    )}
                  </SortableProjectItem>
                ))}
              </SortableContext>
            ) : (
              folderEntry.projects.map((project) => (
                <SidebarProjectListRow
                  key={project.projectKey}
                  {...projectItemProps}
                  project={project}
                  isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                  activeRouteThreadKey={
                    activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                  }
                  isManualProjectSorting={false}
                  dragHandleProps={null}
                />
              ))
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>

      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeRenameDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>Update the folder name.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Folder name</span>
              <Input
                aria-label="Folder name"
                autoFocus
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitRename();
                  }
                }}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeRenameDialog}>
              Cancel
            </Button>
            <Button onClick={submitRename}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );

  return renderContainer ? (
    <SidebarMenuItem className="rounded-md">{content}</SidebarMenuItem>
  ) : (
    content
  );
});

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0 text-foreground"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  projectGroupingMode,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
  onProjectGroupingModeChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sidebar options</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort workspaces
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 font-medium text-muted-foreground sm:text-xs">
            Group projects
          </div>
          <MenuRadioGroup
            value={projectGroupingMode}
            onValueChange={(value) => {
              if (value === "repository" || value === "repository_path" || value === "separate") {
                onProjectGroupingModeChange(value);
              }
            }}
          >
            {(
              Object.entries(PROJECT_GROUPING_MODE_LABELS) as Array<
                [SidebarProjectGroupingMode, string]
              >
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: string;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to chats"
              className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
              to="/"
            >
              <T3Wordmark />
              <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
                Code
              </span>
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                {APP_STAGE_LABEL}
              </span>
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return isElectron ? (
    <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]">
      {wordmark}
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">{wordmark}</SidebarHeader>
  );
});

const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={handleSettingsClick}
          >
            <SettingsIcon className="size-3.5" />
            <span className="text-xs">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});

type WorkbenchSidebarPanel = "threads" | "explorer";

const WorkbenchSidebarPanelSwitcher = memo(function WorkbenchSidebarPanelSwitcher({
  activePanel,
  onPanelChange,
}: {
  readonly activePanel: WorkbenchSidebarPanel;
  readonly onPanelChange: (panel: WorkbenchSidebarPanel) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 border-b border-border px-2 pb-2">
      <button
        type="button"
        className={cn(
          "flex h-8 cursor-pointer items-center justify-center gap-2 rounded-md text-xs outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
          activePanel === "threads"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )}
        aria-pressed={activePanel === "threads"}
        onClick={() => onPanelChange("threads")}
      >
        <MessageSquareIcon className="size-3.5" />
        <span>Chats</span>
      </button>
      <button
        type="button"
        className={cn(
          "flex h-8 cursor-pointer items-center justify-center gap-2 rounded-md text-xs outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
          activePanel === "explorer"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )}
        aria-pressed={activePanel === "explorer"}
        onClick={() => onPanelChange("explorer")}
      >
        <FilesIcon className="size-3.5" />
        <span>Explorer</span>
      </button>
    </div>
  );
});

interface SidebarProjectsContentProps {
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButtonAction: "download" | "install" | "none";
  desktopUpdateButtonDisabled: boolean;
  handleDesktopUpdateButtonClick: () => void;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
  openAddProject: () => void;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  sortedProjectEntries: readonly SidebarProjectFolderEntry<SidebarProjectSnapshot>[];
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  newThreadShortcutLabel: string | null;
  commandPaletteShortcutLabel: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  attachProjectListAutoAnimateRef: (node: HTMLElement | null) => void;
  projectsLength: number;
}

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    handleDesktopUpdateButtonClick,
    projectSortOrder,
    threadSortOrder,
    projectGroupingMode,
    updateSettings,
    openAddProject,
    isManualProjectSorting,
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleNewThread,
    archiveThread,
    deleteThread,
    sortedProjectEntries,
    expandedThreadListsByProject,
    activeRouteProjectKey,
    routeThreadKey,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    attachProjectListAutoAnimateRef,
    projectsLength,
  } = props;
  const handleProjectSortOrderChange = useCallback(
    (sortOrder: SidebarProjectSortOrder) => {
      updateSettings({ sidebarProjectSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleThreadSortOrderChange = useCallback(
    (sortOrder: SidebarThreadSortOrder) => {
      updateSettings({ sidebarThreadSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleProjectGroupingModeChange = useCallback(
    (groupingMode: SidebarProjectGroupingMode) => {
      updateSettings({ sidebarProjectGroupingMode: groupingMode });
    },
    [updateSettings],
  );
  return (
    <SidebarContent className="gap-0">
      <SidebarGroup className="px-2 pt-2 pb-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <CommandDialogTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
                  data-testid="command-palette-trigger"
                />
              }
            >
              <SearchIcon className="size-3.5" />
              <span className="flex-1 truncate text-left text-xs">Search</span>
              {commandPaletteShortcutLabel ? (
                <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">
                  {commandPaletteShortcutLabel}
                </Kbd>
              ) : null}
            </CommandDialogTrigger>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup className="px-2 pt-2 pb-0">
          <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
            <TriangleAlertIcon />
            <AlertTitle>Intel build on Apple Silicon</AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButtonAction !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButtonDisabled}
                  onClick={handleDesktopUpdateButtonClick}
                >
                  {desktopUpdateButtonAction === "download"
                    ? "Download ARM build"
                    : "Install ARM build"}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </SidebarGroup>
      ) : null}
      <SidebarGroup className="px-2 py-2">
        <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Projects
          </span>
          <div className="flex items-center gap-1">
            <ProjectSortMenu
              projectSortOrder={projectSortOrder}
              threadSortOrder={threadSortOrder}
              projectGroupingMode={projectGroupingMode}
              onProjectSortOrderChange={handleProjectSortOrderChange}
              onThreadSortOrderChange={handleThreadSortOrderChange}
              onProjectGroupingModeChange={handleProjectGroupingModeChange}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add project"
                    data-testid="sidebar-add-project-trigger"
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                    onClick={openAddProject}
                  />
                }
              >
                <FolderPlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
          </div>
        </div>

        {isManualProjectSorting ? (
          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu className="gap-2 py-1">
              <SortableContext
                items={sortedProjectEntries.map((entry) =>
                  entry.kind === "folder" ? entry.folderKey : entry.project.projectKey,
                )}
                strategy={verticalListSortingStrategy}
              >
                {sortedProjectEntries.map((entry) => {
                  const entryKey =
                    entry.kind === "folder" ? entry.folderKey : entry.project.projectKey;
                  return (
                    <SortableProjectItem key={entryKey} projectId={entryKey}>
                      {(dragHandleProps) =>
                        entry.kind === "folder" ? (
                          <SidebarProjectFolderRow
                            folderEntry={entry}
                            expandedThreadListsByProject={expandedThreadListsByProject}
                            activeRouteProjectKey={activeRouteProjectKey}
                            routeThreadKey={routeThreadKey}
                            newThreadShortcutLabel={newThreadShortcutLabel}
                            handleNewThread={handleNewThread}
                            archiveThread={archiveThread}
                            deleteThread={deleteThread}
                            threadJumpLabelByKey={threadJumpLabelByKey}
                            attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                            expandThreadListForProject={expandThreadListForProject}
                            collapseThreadListForProject={collapseThreadListForProject}
                            dragInProgressRef={dragInProgressRef}
                            suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                            suppressProjectClickForContextMenuRef={
                              suppressProjectClickForContextMenuRef
                            }
                            isManualProjectSorting={isManualProjectSorting}
                            dragHandleProps={dragHandleProps}
                            renderContainer={false}
                          />
                        ) : (
                          <SidebarProjectItem
                            project={entry.project}
                            isThreadListExpanded={expandedThreadListsByProject.has(
                              entry.project.projectKey,
                            )}
                            activeRouteThreadKey={
                              activeRouteProjectKey === entry.project.projectKey
                                ? routeThreadKey
                                : null
                            }
                            newThreadShortcutLabel={newThreadShortcutLabel}
                            handleNewThread={handleNewThread}
                            archiveThread={archiveThread}
                            deleteThread={deleteThread}
                            threadJumpLabelByKey={threadJumpLabelByKey}
                            attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                            expandThreadListForProject={expandThreadListForProject}
                            collapseThreadListForProject={collapseThreadListForProject}
                            dragInProgressRef={dragInProgressRef}
                            suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                            suppressProjectClickForContextMenuRef={
                              suppressProjectClickForContextMenuRef
                            }
                            isManualProjectSorting={isManualProjectSorting}
                            dragHandleProps={dragHandleProps}
                          />
                        )
                      }
                    </SortableProjectItem>
                  );
                })}
              </SortableContext>
            </SidebarMenu>
          </DndContext>
        ) : (
          <SidebarMenu ref={attachProjectListAutoAnimateRef} className="gap-2 py-1">
            {sortedProjectEntries.map((entry) =>
              entry.kind === "folder" ? (
                <SidebarProjectFolderRow
                  key={entry.folderKey}
                  folderEntry={entry}
                  expandedThreadListsByProject={expandedThreadListsByProject}
                  activeRouteProjectKey={activeRouteProjectKey}
                  routeThreadKey={routeThreadKey}
                  newThreadShortcutLabel={newThreadShortcutLabel}
                  handleNewThread={handleNewThread}
                  archiveThread={archiveThread}
                  deleteThread={deleteThread}
                  threadJumpLabelByKey={threadJumpLabelByKey}
                  attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                  expandThreadListForProject={expandThreadListForProject}
                  collapseThreadListForProject={collapseThreadListForProject}
                  dragInProgressRef={dragInProgressRef}
                  suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                  suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                  isManualProjectSorting={false}
                  dragHandleProps={null}
                />
              ) : (
                <SidebarProjectListRow
                  key={entry.project.projectKey}
                  project={entry.project}
                  isThreadListExpanded={expandedThreadListsByProject.has(entry.project.projectKey)}
                  activeRouteThreadKey={
                    activeRouteProjectKey === entry.project.projectKey ? routeThreadKey : null
                  }
                  newThreadShortcutLabel={newThreadShortcutLabel}
                  handleNewThread={handleNewThread}
                  archiveThread={archiveThread}
                  deleteThread={deleteThread}
                  threadJumpLabelByKey={threadJumpLabelByKey}
                  attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                  expandThreadListForProject={expandThreadListForProject}
                  collapseThreadListForProject={collapseThreadListForProject}
                  dragInProgressRef={dragInProgressRef}
                  suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                  suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                  isManualProjectSorting={isManualProjectSorting}
                  dragHandleProps={null}
                />
              ),
            )}
          </SidebarMenu>
        )}

        {projectsLength === 0 && (
          <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
            No projects yet
          </div>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
});

export default function Sidebar() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const localProjectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const localProjectOrder = useUiStateStore((store) => store.projectOrder);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const sidebarThreadSortOrder = useSettings((s) => s.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useSettings((s) => s.sidebarProjectSortOrder);
  const sidebarProjectGroupingMode = useSettings((s) => s.sidebarProjectGroupingMode);
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const sidebarProjectFolders = useSettings((s) => s.sidebarProjectFolders);
  const syncedProjectExpandedById = useSettings((s) => s.sidebarProjectExpandedById);
  const syncedProjectOrder = useSettings((s) => s.sidebarProjectOrder);
  const sidebarThreadPreviewCount = useSettings((s) => s.sidebarThreadPreviewCount);
  const { updateSettings } = useUpdateSettings();
  const { handleNewThread } = useNewThreadHandler();
  const { archiveThread, deleteThread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const activeRouteThread = useStore(
    useMemo(
      () => (state: import("../store").AppState) => selectThreadByRef(state, routeThreadRef),
      [routeThreadRef],
    ),
  );
  const activeRouteThreadSummary = useStore(
    useMemo(
      () => (state: import("../store").AppState) =>
        selectSidebarThreadSummaryByRef(state, routeThreadRef),
      [routeThreadRef],
    ),
  );
  const activeRouteDraftSession = useComposerDraftStore((store) =>
    routeDraftId ? store.getDraftSession(routeDraftId) : null,
  );
  const activeExplorerThread =
    activeRouteDraftSession ?? activeRouteThread ?? activeRouteThreadSummary;
  const activeExplorerProjectRef = useMemo(
    () =>
      activeExplorerThread
        ? scopeProjectRef(activeExplorerThread.environmentId, activeExplorerThread.projectId)
        : null,
    [activeExplorerThread],
  );
  const activeExplorerProject = useStore(
    useMemo(
      () => (state: import("../store").AppState) =>
        selectProjectByRef(state, activeExplorerProjectRef),
      [activeExplorerProjectRef],
    ),
  );
  const activeWorkbenchPanel = useWorkbenchStore((state) => state.activeSidebarPanel);
  const setActiveWorkbenchPanel = useWorkbenchStore((state) => state.setActiveSidebarPanel);
  const explorerRevealRequest = useWorkbenchStore((state) => state.explorerRevealRequest);
  const activeFileTab = useWorkbenchStore((state) =>
    state.fileTabsState.tabs.find(
      (tab): tab is Extract<WorkbenchTab, { kind: "file" }> =>
        tab.id === state.fileTabsState.activeTabId && tab.kind === "file",
    ),
  );
  const explorerTarget = resolveSidebarExplorerTarget({
    thread: activeExplorerThread,
    project: activeExplorerProject,
  });
  const activeExplorerRelativePath =
    explorerTarget &&
    activeFileTab?.environmentId === explorerTarget.environmentId &&
    (explorerTarget.workspaceId === undefined ||
      activeFileTab.workspaceId === explorerTarget.workspaceId) &&
    activeFileTab.cwd === explorerTarget.cwd
      ? activeFileTab.relativePath
      : null;
  const keybindings = useServerKeybindings();
  const openAddProjectCommandPalette = useCommandPaletteStore((store) => store.openAddProject);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const modelPickerOpen = useModelPickerOpen();
  const serverConfigLoaded = useServerConfigLoaded();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const useSyncedProjectExpandedById =
    serverConfigLoaded || Object.keys(syncedProjectExpandedById).length > 0;
  const projectExpandedById = useMemo(
    () =>
      materializeProjectExpandedById({
        localProjectExpandedById,
        syncedProjectExpandedById,
        useSyncedProjectExpandedById,
      }),
    [localProjectExpandedById, syncedProjectExpandedById, useSyncedProjectExpandedById],
  );
  const projectOrder =
    serverConfigLoaded || syncedProjectOrder.length > 0 ? syncedProjectOrder : localProjectOrder;

  useEffect(() => {
    if (booleanRecordsEqual(useUiStateStore.getState().projectExpandedById, projectExpandedById)) {
      return;
    }
    useUiStateStore.setState({ projectExpandedById: { ...projectExpandedById } });
  }, [projectExpandedById]);

  useEffect(() => {
    if (stringArraysEqual(useUiStateStore.getState().projectOrder, projectOrder)) {
      return;
    }
    useUiStateStore.setState({ projectOrder: [...projectOrder] });
  }, [projectOrder]);

  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);

  // Build a mapping from physical project key → logical project key for
  // cross-environment grouping.  Projects that share a repositoryIdentity
  // canonicalKey are treated as one logical project in the sidebar.
  const physicalToLogicalKey = useMemo(() => {
    return buildPhysicalToLogicalProjectKeyMap({
      projects: orderedProjects,
      settings: projectGroupingSettings,
    });
  }, [orderedProjects, projectGroupingSettings]);
  const projectPhysicalKeyByScopedRef = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          derivePhysicalProjectKey(project),
        ]),
      ),
    [orderedProjects],
  );

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(() => {
    return buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => {
        const rt = savedEnvironmentRuntimeById[environmentId];
        const saved = savedEnvironmentRegistry[environmentId];
        return rt?.descriptor?.label ?? saved?.label ?? null;
      },
    });
  }, [
    orderedProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);

  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  const topLevelSidebarThreads = useMemo(
    () => sidebarThreads.filter(isSidebarTopLevelThread),
    [sidebarThreads],
  );
  const activeSidebarThreadKey = useMemo(() => {
    if (!routeThreadKey) {
      return null;
    }
    const activeThread = sidebarThreadByKey.get(routeThreadKey);
    if (!activeThread) {
      return routeThreadKey;
    }
    return scopedThreadKey(
      scopeThreadRef(activeThread.environmentId, getSidebarTopLevelThreadId(activeThread)),
    );
  }, [routeThreadKey, sidebarThreadByKey]);
  // Resolve the active route's project key to a logical key so it matches the
  // sidebar's grouped project entries.
  const activeRouteProjectKey = useMemo(() => {
    if (!routeThreadKey) {
      return null;
    }
    const activeThread = sidebarThreadByKey.get(routeThreadKey);
    if (!activeThread) return null;
    const physicalKey =
      projectPhysicalKeyByScopedRef.get(
        scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId)),
      ) ?? scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId));
    return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
  }, [routeThreadKey, sidebarThreadByKey, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);

  // Group threads by logical project key so all threads from grouped projects
  // are displayed together.
  const threadsByProjectKey = useMemo(() => {
    const next = new Map<string, SidebarThreadSummary[]>();
    for (const thread of topLevelSidebarThreads) {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(logicalKey, [thread]);
      }
    }
    return next;
  }, [topLevelSidebarThreads, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeThreadRef
        ? selectThreadTerminalUiState(
            useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
      modelPickerOpen,
    }),
    [modelPickerOpen, routeThreadRef],
  );
  const newThreadShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: false,
      },
    }),
    [platform],
  );
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", newThreadShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", newThreadShortcutLabelOptions);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjectByKey.get(String(active.id));
      const overProject = sidebarProjectByKey.get(String(over.id));
      const overFolderEntry = sidebarProjectFolders.find(
        (candidate) => sidebarProjectFolderKey(candidate.id) === String(over.id),
      );
      if (activeProject && overProject) {
        const activeFolder = findSidebarProjectFolderForProject(
          sidebarProjectFolders,
          activeProject,
        );
        const overFolder = findSidebarProjectFolderForProject(sidebarProjectFolders, overProject);
        if (activeFolder && overFolder && activeFolder.id === overFolder.id) {
          const nextProjectKeys = reorderSidebarFolderProjectKeys({
            projectKeys: activeFolder.projectKeys,
            draggedProjectKeys: getSidebarProjectPhysicalKeys(activeProject),
            targetProjectKeys: getSidebarProjectPhysicalKeys(overProject),
          });
          if (!stringArraysEqual(activeFolder.projectKeys, nextProjectKeys)) {
            updateSettings({
              sidebarProjectFolders: sidebarProjectFolders.map((folder) =>
                folder.id === activeFolder.id
                  ? { ...folder, projectKeys: nextProjectKeys }
                  : folder,
              ),
            });
          }
          return;
        }

        if (activeFolder || overFolder) {
          updateSettings({
            sidebarProjectFolders: moveSidebarProjectAcrossFolders({
              folders: sidebarProjectFolders,
              projectKeys: getSidebarProjectPhysicalKeys(activeProject),
              targetFolderId: overFolder?.id ?? null,
              targetProjectKeys: overFolder ? getSidebarProjectPhysicalKeys(overProject) : [],
            }),
          });
        }
      } else if (activeProject && overFolderEntry) {
        updateSettings({
          sidebarProjectFolders: moveSidebarProjectAcrossFolders({
            folders: sidebarProjectFolders,
            projectKeys: getSidebarProjectPhysicalKeys(activeProject),
            targetFolderId: overFolderEntry.id,
          }),
        });
      }
      const getProjectOrderKeys = (entryId: string): readonly string[] => {
        const project = sidebarProjectByKey.get(entryId);
        if (project) {
          return project.memberProjects.map((member) => member.physicalProjectKey);
        }
        const folder = sidebarProjectFolders.find(
          (candidate) => sidebarProjectFolderKey(candidate.id) === entryId,
        );
        return folder?.projectKeys ?? [];
      };
      const activeMemberKeys = getProjectOrderKeys(String(active.id));
      const overMemberKeys = getProjectOrderKeys(String(over.id));
      if (activeMemberKeys.length === 0 || overMemberKeys.length === 0) return;
      reorderProjects(activeMemberKeys, overMemberKeys);
      updateSettings({ sidebarProjectOrder: useUiStateStore.getState().projectOrder });
    },
    [
      sidebarProjectFolders,
      sidebarProjectSortOrder,
      reorderProjects,
      sidebarProjectByKey,
      updateSettings,
    ],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);

  const visibleThreads = useMemo(
    () => topLevelSidebarThreads.filter((thread) => thread.archivedAt === null),
    [topLevelSidebarThreads],
  );
  const sortedProjects = useMemo(() => {
    const sortableProjects = sidebarProjects.map((project) => ({
      ...project,
      id: project.projectKey,
    }));
    const sortableThreads = visibleThreads.map((thread) => {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return {
        ...thread,
        projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
      };
    });
    return sortProjectsForSidebar(
      sortableProjects,
      sortableThreads,
      sidebarProjectSortOrder,
    ).flatMap((project) => {
      const resolvedProject = sidebarProjectByKey.get(project.id);
      return resolvedProject ? [resolvedProject] : [];
    });
  }, [
    sidebarProjectSortOrder,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjectByKey,
    sidebarProjects,
    visibleThreads,
  ]);
  const sortedProjectEntries = useMemo(
    () => buildSidebarProjectFolderEntries(sortedProjects, sidebarProjectFolders),
    [sidebarProjectFolders, sortedProjects],
  );
  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  const visibleSidebarThreadKeys = useMemo(
    () =>
      sortedProjectEntries.flatMap((entry) => {
        const projectsToVisit = entry.kind === "folder" ? entry.projects : [entry.project];
        if (entry.kind === "folder") {
          const folderExpanded = projectExpandedById[entry.folderKey] ?? true;
          if (!folderExpanded) {
            return [];
          }
        }
        return projectsToVisit.flatMap((project) => {
          const projectThreads = sortThreads(
            (threadsByProjectKey.get(project.projectKey) ?? []).filter(
              (thread) => thread.archivedAt === null,
            ),
            sidebarThreadSortOrder,
          );
          const projectExpanded = projectExpandedById[project.projectKey] ?? true;
          const activeThreadKey = activeSidebarThreadKey ?? undefined;
          const pinnedCollapsedThread =
            !projectExpanded && activeThreadKey
              ? (projectThreads.find(
                  (thread) =>
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                    activeThreadKey,
                ) ?? null)
              : null;
          const shouldShowThreadPanel = projectExpanded || pinnedCollapsedThread !== null;
          if (!shouldShowThreadPanel) {
            return [];
          }
          const isThreadListExpanded = expandedThreadListsByProject.has(project.projectKey);
          const hasOverflowingThreads = projectThreads.length > sidebarThreadPreviewCount;
          const previewThreads =
            isThreadListExpanded || !hasOverflowingThreads
              ? projectThreads
              : projectThreads.slice(0, sidebarThreadPreviewCount);
          const renderedThreads = pinnedCollapsedThread ? [pinnedCollapsedThread] : previewThreads;
          return renderedThreads.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          );
        });
      }),
    [
      sidebarThreadSortOrder,
      sidebarThreadPreviewCount,
      expandedThreadListsByProject,
      activeSidebarThreadKey,
      projectExpandedById,
      sortedProjectEntries,
      threadsByProjectKey,
    ],
  );
  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const sidebarShortcutContext = useMemo(
    () => ({
      terminalFocus: false,
      terminalOpen: routeThreadRef
        ? selectThreadTerminalUiState(
            useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
      modelPickerOpen,
    }),
    [modelPickerOpen, routeThreadRef],
  );
  const threadJumpLabelByKey = useMemo(
    () =>
      buildThreadJumpLabelMap({
        keybindings,
        platform,
        terminalOpen: sidebarShortcutContext.terminalOpen,
        threadJumpCommandByKey,
      }),
    [keybindings, platform, sidebarShortcutContext.terminalOpen, threadJumpCommandByKey],
  );
  const shouldShowThreadJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform,
      context: sidebarShortcutContext,
    },
  );
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  const orderedSidebarThreadKeys = visibleSidebarThreadKeys;
  const prewarmedSidebarThreadKeys = useMemo(
    () => getSidebarThreadIdsToPrewarm(visibleSidebarThreadKeys),
    [visibleSidebarThreadKeys],
  );
  const prewarmedSidebarThreadRefs = useMemo(
    () =>
      prewarmedSidebarThreadKeys.flatMap((threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref ? [ref] : [];
      }),
    [prewarmedSidebarThreadKeys],
  );

  useEffect(() => {
    const releases = prewarmedSidebarThreadRefs.map((ref) =>
      retainThreadDetailSubscription(ref.environmentId, ref.threadId),
    );

    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [prewarmedSidebarThreadRefs]);

  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowThreadJumpHintsNow);
  }, [shouldShowThreadJumpHintsNow, updateThreadJumpHintsVisibility]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcutContext = getCurrentSidebarShortcutContext();

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadKeys,
          currentThreadId: activeSidebarThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = sidebarThreadByKey.get(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = sidebarThreadByKey.get(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
    };

    window.addEventListener("keydown", onWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    getCurrentSidebarShortcutContext,
    keybindings,
    navigateToThread,
    orderedSidebarThreadKeys,
    platform,
    activeSidebarThreadKey,
    sidebarThreadByKey,
    threadJumpThreadKeys,
  ]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    newThreadShortcutLabelOptions,
  );
  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectKey)) return current;
      const next = new Set(current);
      next.add(projectKey);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  }, []);

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          <WorkbenchSidebarPanelSwitcher
            activePanel={activeWorkbenchPanel}
            onPanelChange={setActiveWorkbenchPanel}
          />

          {activeWorkbenchPanel === "threads" ? (
            <SidebarProjectsContent
              showArm64IntelBuildWarning={showArm64IntelBuildWarning}
              arm64IntelBuildWarningDescription={arm64IntelBuildWarningDescription}
              desktopUpdateButtonAction={desktopUpdateButtonAction}
              desktopUpdateButtonDisabled={desktopUpdateButtonDisabled}
              handleDesktopUpdateButtonClick={handleDesktopUpdateButtonClick}
              projectSortOrder={sidebarProjectSortOrder}
              threadSortOrder={sidebarThreadSortOrder}
              projectGroupingMode={sidebarProjectGroupingMode}
              updateSettings={updateSettings}
              openAddProject={openAddProjectCommandPalette}
              isManualProjectSorting={isManualProjectSorting}
              projectDnDSensors={projectDnDSensors}
              projectCollisionDetection={projectCollisionDetection}
              handleProjectDragStart={handleProjectDragStart}
              handleProjectDragEnd={handleProjectDragEnd}
              handleProjectDragCancel={handleProjectDragCancel}
              handleNewThread={handleNewThread}
              archiveThread={archiveThread}
              deleteThread={deleteThread}
              sortedProjectEntries={sortedProjectEntries}
              expandedThreadListsByProject={expandedThreadListsByProject}
              activeRouteProjectKey={activeRouteProjectKey}
              routeThreadKey={activeSidebarThreadKey}
              newThreadShortcutLabel={newThreadShortcutLabel}
              commandPaletteShortcutLabel={commandPaletteShortcutLabel}
              threadJumpLabelByKey={visibleThreadJumpLabelByKey}
              attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
              expandThreadListForProject={expandThreadListForProject}
              collapseThreadListForProject={collapseThreadListForProject}
              dragInProgressRef={dragInProgressRef}
              suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
              suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
              attachProjectListAutoAnimateRef={attachProjectListAutoAnimateRef}
              projectsLength={projects.length}
            />
          ) : (
            <SidebarContent className="gap-0">
              <WorkspaceExplorer
                target={explorerTarget}
                activeRelativePath={activeExplorerRelativePath}
                revealRequest={explorerRevealRequest}
              />
            </SidebarContent>
          )}

          <SidebarSeparator />
          <SidebarChromeFooter />
        </>
      )}
    </>
  );
}
