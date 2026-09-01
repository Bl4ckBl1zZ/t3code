import { autoAnimate } from "@formkit/auto-animate";
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
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { resolveThreadPreview } from "@t3tools/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  DownloadIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import {
  requestThreadUnpinConfirmation,
  useMarkThreadUnread,
  useThreadActions,
} from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { orchestrationEnvironment } from "../state/orchestration";
import { useNowMinute } from "../hooks/useNowMinute";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { readThreadShell, useProjects, useThreadShells } from "../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { formatRelativeTimeLabel, parseTimestampDate } from "../timestampFormat";
import { useSidebarWorkspace } from "../sidebarWorkspace";
import { isT3WorkBackingProject, t3WorkDirectoryForEnvironment } from "../t3WorkProject";
import { createT3WorkBackingProject } from "../t3WorkProjectCreate";
import type { SidebarThreadSummary } from "../types";
import {
  findReadyHermesEntry,
  resolveWorkEnvironmentScope,
  useWorkEnvironmentScopePreference,
} from "../workEnvironmentScope";
import { cn } from "~/lib/utils";
import {
  animatePinnedLayoutChanges,
  applyManualThreadOrderForSidebarV2,
  buildBulkTitleRegenerationContextMenuItem,
  formatWorkingDurationLabel,
  firstValidTimestampMs,
  hasUnseenCompletion,
  canPinWorkInboxThread,
  formatBackgroundWorkTooltip,
  isSidebarNestedLinkClick,
  isThreadVisibleInSidebarWorkspace,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planPinnedReorder,
  resolveAdjacentThreadId,
  resolveWorkspaceSwitchNavigation,
  resolveSettledTimestamp,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  searchSidebarThreadsByTitle,
  shouldCreateNewThreadInCurrentProject,
  resolveWorkingStartedAt,
  resolveWorkInboxBadge,
  sidebarProjectKey,
  sidebarProviderInstanceKey,
  sortSidebarV2ProjectGroups,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
  workInboxActiveSection,
  workspaceLandingKind,
  type SidebarWorkspace,
  type WorkInboxBadge,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  ThreadWorktreeIndicator,
  nextThreadChangeRequestSnapshot,
  prStatusIndicator,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  setThreadChangeRequestSnapshot,
  settledPrHoverColorClass,
  terminalStatusFromRunningIds,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./Sidebar.snooze";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { T3Wordmark } from "./sidebar/SidebarChrome";
import { HermesImportOnboarding } from "./HermesImportOnboarding";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
// Keep the v2 key so existing preferences survive the v2-to-default rename.
const SETTLED_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:settled-expanded";
const SNOOZED_SHELF_EXPANDED_KEY = "t3code:sidebar-v2:snoozed-expanded";
const SIDEBAR_WORKSPACE_ROUTES_STORAGE_KEY = "t3code:sidebar-workspace-routes:v1";
const SIDEBAR_WORKSPACE_ROUTES_SCHEMA = Schema.Struct({
  work: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  chat: Schema.optional(Schema.String),
});
const SIDEBAR_WORKSPACE_OPTIONS: ReadonlyArray<{
  value: SidebarWorkspace;
  label: string;
  description: string;
}> = [
  {
    value: "code",
    label: "T3 Code",
    description: "Build, debug, and ship",
  },
  {
    value: "work",
    label: "T3 Work",
    description: "Create, learn, and explore",
  },
  {
    value: "chat",
    label: "T3 Chat",
    description: "Talk it through",
  },
];

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

function SidebarWorkspaceSelector(props: {
  workspace: SidebarWorkspace;
  onWorkspaceChange: (workspace: SidebarWorkspace) => void;
}) {
  const selected = SIDEBAR_WORKSPACE_OPTIONS.find((option) => option.value === props.workspace)!;

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Switch workspace. Current workspace: ${selected.label}`}
        className="relative z-10 ml-[var(--workspace-titlebar-content-left)] flex h-8 min-w-0 max-w-[calc(100%-var(--workspace-titlebar-content-left)-0.5rem)] cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring in-data-[on-backdrop]:text-white in-data-[on-backdrop]:hover:bg-white/15 in-data-[on-backdrop]:focus-visible:ring-white/90"
      >
        <T3Wordmark />
        <span className="truncate text-sm font-medium tracking-tight">
          {selected.label.slice(3)}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 shrink-0 text-sidebar-muted-foreground in-data-[on-backdrop]:text-white/70"
        />
      </MenuTrigger>
      <MenuPopup align="start" className="w-64">
        <MenuRadioGroup
          value={props.workspace}
          onValueChange={(value) => {
            if (value === "work" || value === "code" || value === "chat") {
              props.onWorkspaceChange(value);
            }
          }}
        >
          {SIDEBAR_WORKSPACE_OPTIONS.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              closeOnClick
              className="min-h-12 px-2 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{option.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                {props.workspace === option.value ? (
                  <CheckIcon aria-hidden className="size-4 shrink-0 text-foreground" />
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

// Settled rows read "how long ago did this wrap up", matching their sort
// key: both go through resolveSettledTimestamp so label and order can't
// disagree.
function settledTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = resolveSettledTimestamp(thread);
  return timestamp === null ? "" : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

// Floats at the row's right edge, vertically centered, while the jump
// modifier is held. An overlay pill instead of an inline slot: the hint
// must neither displace the status/time label (holding ⌘ used to blank
// out "Working") nor shift any layout when it appears. pointer-events-none
// so it never swallows clicks meant for the settle/un-settle buttons it
// can overlap.
function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

// Self-ticking so only this span re-renders each second, not the whole row.
function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return (
    <span className="font-mono tabular-nums">
      {formatWorkingDurationLabel(Date.now() - startedMs)}
    </span>
  );
}

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarThreadTooltip({
  thread,
  projectTitle,
  projectCwd,
  projectFaviconPath,
  environmentLabel,
  providerEntry,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
  showProjectContext,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  environmentLabel: string | null;
  providerEntry: ProviderInstanceEntry | null;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
  showProjectContext: boolean;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  return (
    <TooltipPopup
      side="right"
      align="start"
      sideOffset={4}
      variant="glass"
      className="max-w-80 text-left whitespace-normal [&_[data-slot=tooltip-viewport]]:p-0"
    >
      <div className="flex min-w-0 max-w-80 flex-col gap-2 p-[var(--floating-content-inset)]">
        <div className="min-w-0 truncate text-xs leading-none font-medium text-foreground">
          {thread.title}
        </div>
        <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
          {showProjectContext && projectTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={projectCwd ?? ""}
                faviconPath={projectFaviconPath}
                className="size-3 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 truncate text-foreground/75">{projectTitle}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
            </div>
          ) : null}
          {showProjectContext && thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{thread.branch}</div>
            </div>
          ) : null}
          {showProjectContext && branchMismatch ? (
            <div className="flex min-w-0 items-start gap-2 text-warning">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word leading-5">
                You're currently checked out on another branch.
              </div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={
                  providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
                }
                accentColor={providerEntry?.accentColor}
                // Initials would swallow a size-3 glyph: accent dot, name in label.
                showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
                badgeContent="none"
                badgeClassName="h-2 min-w-2 px-0"
                iconClassName="size-3 shrink-0 grayscale opacity-60"
              />
              <div className="min-w-0 truncate text-foreground/75">
                {showInstanceBadge && providerEntry
                  ? `${modelLabel} · ${providerEntry.displayName}`
                  : modelLabel}
              </div>
            </div>
          ) : null}
          {terminalStatus ? (
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon
                aria-hidden
                className={cn("size-3 shrink-0", terminalStatus.colorClass)}
              />
              <div className="min-w-0 truncate text-foreground/75">
                {terminalProcessLabel(terminalProcessCount)}
              </div>
            </div>
          ) : null}
          {thread.runtime?.lastError ? (
            <div className="flex min-w-0 items-center gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
              <div className="min-w-0 truncate">Error occurred</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}

/**
 * Hover entry point for snooze: a clock button opening the preset menu.
 * Controlled by the row (which also uses the open state to pin its hover
 * actions while the menu is up).
 */
function SnoozePopoverButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: SnoozePreset) => void;
}) {
  const { open, onOpenChange, onSnooze } = props;
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  // Presets resolve at open time so "In 1 hour" is relative to the click,
  // not to when the row mounted.
  const presets = useMemo(
    () => (open ? resolveSnoozePresets(new Date(), timestampFormat) : []),
    [open, timestampFormat],
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Snooze thread"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Snooze thread</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" className="w-56" viewportClassName="p-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenChange(false);
              onSnooze(preset);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
              {preset.whenLabel}
            </span>
          </button>
        ))}
      </PopoverPopup>
    </Popover>
  );
}

// The Work lozenge reuses the status hues, as a filled pill rather than a bare
// word: it stands where a Code card puts its project favicon and name, so it
// has to carry that slot's visual weight. The rail is the same hue down the
// row's leading edge, and only "Needs you" earns one — a rail on every row is a
// rail on none, and the point is that the inbox triages in one pass.
const WORK_INBOX_BADGE_STYLE: Record<
  WorkInboxBadge,
  {
    label: string;
    className: string;
    railClassName: string | null;
  }
> = {
  "needs-you": {
    label: "Needs you",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    railClassName: "bg-amber-500/70",
  },
  working: {
    label: "Working",
    className: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    railClassName: null,
  },
  failed: {
    label: "Failed",
    className: "bg-red-500/15 text-red-700 dark:text-red-300",
    railClassName: null,
  },
  done: {
    label: "Done",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    railClassName: null,
  },
};

// Drag plumbing handed down by SortableSidebarThreadRow: the row owns its <li>
// (no wrapper element — li>li nesting is invalid), so the sortable ref,
// transform, and activation listeners have to land on that li directly.
interface SidebarThreadRowSortable {
  setNodeRef: (node: HTMLElement | null) => void;
  style: CSSProperties;
  listeners: ReturnType<typeof useSortable>["listeners"];
  isDragging: boolean;
}

// One unsent draft session the user has invested content in. Two lines,
// nothing else: project name, then the typed prompt. All the draft's
// settings (model, env mode, branch, worktree) still travel with it —
// clicking is a plain navigation to /draft/$draftId, which touches nothing.
// While the draft is open the row renders a frozen snapshot (see
// SidebarDraftBlock); memoized so per-keystroke block re-renders skip it
// entirely.
const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
}) {
  const { composer, draftId, onDiscard, onNavigate, session } = props;
  const promptPreview = composer.prompt.trim().split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.terminalContexts.length +
    composer.elementContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  const handleActivate = useCallback(() => onNavigate(draftId), [draftId, onNavigate]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Keys targeting the nested discard button belong to the button:
      // preventDefault here would swallow Space's synthesized click and
      // navigate instead of discarding.
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNavigate(draftId);
      }
    },
    [draftId, onNavigate],
  );
  const handleDiscard = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onDiscard(draftId);
    },
    [draftId, onDiscard],
  );
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-draft-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none",
          props.isActive
            ? "bg-sidebar-row-active"
            : "bg-amber-400/[0.04] hover:bg-amber-400/[0.08]",
        )}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
      >
        <div className="relative z-10 px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon
              aria-hidden
              className="size-3 shrink-0 text-amber-600 dark:text-amber-300/80"
            />
            <ProjectFavicon
              environmentId={session.environmentId}
              cwd={props.projectCwd ?? ""}
              faviconPath={props.projectFaviconPath}
              className="size-4 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {props.projectTitle}
            </span>
            <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Discard draft"
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Discard draft</TooltipPopup>
              </Tooltip>
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground/90">{preview}</div>
        </div>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

// Draft sessions with user content, surfaced above the pinned block so an
// interrupted "new thread" stays one click away. Self-contained (own store
// subscription + closing divider) so per-keystroke composer updates
// re-render only this block, never the whole sidebar. Vanishes at count 0.
const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  projectCwdByKey: ReadonlyMap<string, string>;
  projectFaviconPathByKey: ReadonlyMap<string, string | null | undefined>;
  scopedProjectKeys: ReadonlySet<string> | null;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  // The open draft's row is FROZEN at the moment the draft became the route:
  // it stays visible (like a thread row) but never repaints while the user
  // types. A draft that was never navigated away from has no snapshot to
  // freeze, so a fresh typing session shows no row at all. Captured
  // synchronously on route change (setState-during-render derived state) so
  // the row never flickers out for a frame between route change and capture.
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      const composer = store.getComposerDraft(draftId);
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = useMemo(() => {
    const rows: SidebarDraftRowData[] = [];
    // Every non-promoted session with content gets a row, mapped or not:
    // new-thread surfaces mint fresh drafts and leave invested ones behind
    // unmapped, so the mapping only knows about the latest per project.
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (
        props.scopedProjectKeys !== null &&
        !props.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      if (draftKey === props.routeDraftId) {
        // Open draft: render the frozen entry snapshot, or nothing for a
        // draft that has never been left. Gated on the LIVE session above so
        // send/discard still removes the row immediately.
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push(frozenActive.row);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  }, [
    draftThreadsByThreadKey,
    draftsByThreadKey,
    frozenActive,
    props.routeDraftId,
    props.scopedProjectKeys,
  ]);
  const handleDiscard = useCallback(
    (draftId: DraftId) => {
      // The /draft/$draftId route redirects home on its own when the draft
      // it renders disappears, so discarding the open draft needs no
      // special-casing here.
      releaseComposerDraftUploads(draftId);
      clearDraftThread(draftId);
    },
    [clearDraftThread],
  );
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            session={session}
            composer={composer}
            projectTitle={props.projectDisplayNameByKey.get(projectKey) ?? null}
            projectCwd={props.projectCwdByKey.get(projectKey) ?? null}
            projectFaviconPath={props.projectFaviconPathByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            onNavigate={props.onNavigateToDraft}
            onDiscard={handleDiscard}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

const SidebarThreadRow = memo(function SidebarThreadRow(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  sortable?: SidebarThreadRowSortable;
  // Slim rows are either settled (action: un-settle) or merely quiet
  // (seen Ready threads — action: settle).
  variantAction: "settle" | "unsettle" | "unsnooze";
  // False on environments whose server predates thread.settle/unsettle:
  // the lifecycle affordances hide entirely rather than fail on click.
  settlementSupported: boolean;
  // Same contract for thread.snooze/unsnooze.
  snoozeSupported: boolean;
  // Compact wake countdown ("2h") for rows in the snoozed shelf.
  snoozeWakeLabelText: string | null;
  // Pins exist only in the unsettled card list. A lifecycle transition out
  // of that list removes the affordance and the pin no longer affects order.
  isPinned: boolean;
  canPin: boolean;
  // When a snooze ended (timer or early wake); drives the Woke pill until
  // the user visits the thread.
  wokeAt: string | null;
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  projectTitle: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: SnoozePreset) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onTogglePin: (threadRef: ScopedThreadRef) => void;
  changeRequestSnapshot: ThreadChangeRequestSnapshot | null;
  onChangeRequestSnapshot: (
    threadKey: string,
    snapshot: ThreadChangeRequestSnapshot | null,
  ) => void;
}) {
  const {
    isRenaming,
    changeRequestSnapshot,
    onChangeRequestSnapshot,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onRenameTitleChange,
    onSettle,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onTogglePin,
    onUnsettle,
    onUnsnooze,
    openPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const terminalProcessCount = runningTerminalIds.length;

  // Same semantics as v1 (never-visited counts as read): flipping the beta
  // flag must not light up every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  // A woken thread reappears at its original position (the sort is
  // deliberately static), so the pill has to carry the weight. Snoozing is
  // an explicit act, so unlike Done, a never-visited woke thread still
  // shows the pill; visiting clears it. An unparseable visit timestamp
  // counts as never-visited — corrupt local data must not eat the wake
  // signal.
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke = wokeAtDate !== null && (lastVisitedDate === null || lastVisitedDate < wokeAtDate);
  // In-flight rows (working, or waiting on approval/input) fade as a whole:
  // there is nothing for the user to do yet, so prominence is reserved for
  // rows that need a human — done (unread), read-but-unsettled, failed, and
  // freshly woken. The status label keeps its hue, so waiting rows stay
  // findable. In-flight rows recede the same as read-ready ones (inbox-zero:
  // working threads aren't your problem yet) — only the colored status label
  // stands out.
  const isInFlight =
    status === "working" || status === "background" || status === "approval" || status === "input";
  const shouldRecede =
    (status === "ready" || isInFlight) && !isUnread && !isWoke && !props.isActive && !isSelected;
  // Status hues follow the system-wide convention set by sidebar v1 and the
  // mobile Live Activity/widgets (amber approval, indigo input, sky working)
  // so a thread reads the same color everywhere it surfaces.
  const topStatus =
    status === "working"
      ? {
          label: "Working",
          icon: "working" as const,
          className:
            "animate-sidebar-working-text text-sky-600 motion-reduce:animate-none dark:text-sky-400",
        }
      : status === "approval"
        ? {
            label: "Approval",
            icon: null,
            className: "text-amber-700 dark:text-amber-300",
          }
        : status === "input"
          ? {
              label: "Input",
              icon: null,
              className: "text-indigo-600 dark:text-indigo-300",
            }
          : status === "failed"
            ? {
                label: "Failed",
                icon: null,
                className: "text-red-700 dark:text-red-300",
              }
            : isWoke
              ? {
                  label: "Woke",
                  icon: "woke" as const,
                  className: "text-amber-700 dark:text-amber-300",
                }
              : isUnread
                ? {
                    label: "Done",
                    icon: "done" as const,
                    className: "text-emerald-700 dark:text-emerald-300",
                  }
                : // Ranked under Done and Woke, matching sidebar v1: a result the
                  // reader has not seen yet outranks work that is still going.
                  // Sky like Working, but unanimated — nothing is generating,
                  // something is merely still out there.
                  status === "background"
                  ? {
                      label: "Background",
                      icon: "working" as const,
                      className: "text-sky-600/80 dark:text-sky-400/80",
                    }
                  : null;

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const driverKind = providerEntry?.driverKind ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const isHermes = driverKind === "hermes" || (driverKind === null && modelInstanceId === "hermes");
  // Chat conversations are Hermes threads born on the Chat surface; the rest of
  // Hermes is the Work inbox. Same split the workspace filter makes, so a row
  // renders as what its workspace says it is.
  const isChat = isHermes && thread.workInboxRole === "chat";
  const isWork = isHermes && !isChat;
  const workBadge = isWork
    ? resolveWorkInboxBadge({ status, hasUnseenCompletion: isUnread })
    : null;
  const workBadgeStyle = workBadge === null ? null : WORK_INBOX_BADGE_STYLE[workBadge];
  const preview = resolveThreadPreview(thread);
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    !isHermes && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const isWokeStatus = topStatus?.icon === "woke";

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  // A local checkout keeps its terminal PR badge after the working copy moves
  // to another branch: the snapshot remembers the pull request the thread's own
  // branch had, so switching checkouts no longer blanks the row.
  const retainTerminalOnBranchMismatch = thread.worktreePath === null;
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
  );
  const pr = resolveDisplayedThreadPr({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
    snapshot: changeRequestSnapshot,
    retainTerminalOnBranchMismatch,
    linkedPullRequest: thread.linkedPullRequest,
    linkedPullRequestStatus,
  });
  const prProvider = resolveDisplayedThreadPrProvider({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
    snapshot: changeRequestSnapshot,
    retainTerminalOnBranchMismatch,
    linkedPullRequest: thread.linkedPullRequest,
    linkedPullRequestStatus,
  });
  const prStatus = prStatusIndicator(pr, prProvider);
  const settledPrHoverClass = pr ? settledPrHoverColorClass(pr.state) : undefined;
  useEffect(() => {
    const nextSnapshot = nextThreadChangeRequestSnapshot({
      threadBranch: thread.branch,
      gitStatus: gitStatus.data,
      snapshot: changeRequestSnapshot,
      retainTerminalOnBranchMismatch,
      linkedPullRequest: thread.linkedPullRequest,
      linkedPullRequestStatus,
    });
    if (nextSnapshot === undefined) return;
    onChangeRequestSnapshot(threadKey, nextSnapshot);
  }, [
    changeRequestSnapshot,
    gitStatus.data,
    linkedPullRequestStatus,
    onChangeRequestSnapshot,
    retainTerminalOnBranchMismatch,
    thread.branch,
    thread.linkedPullRequest,
    threadKey,
  ]);

  const isRemote =
    props.currentEnvironmentId !== null && thread.environmentId !== props.currentEnvironmentId;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={thread}
      projectTitle={isHermes ? null : props.projectTitle}
      projectCwd={props.projectCwd}
      projectFaviconPath={props.projectFaviconPath}
      environmentLabel={props.environmentLabel}
      providerEntry={providerEntry}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={isHermes ? null : branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
      showProjectContext={!isHermes}
    />
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(threadRef);
    },
    [onSettle, threadRef],
  );
  const handleUnsettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsettle(threadRef);
    },
    [onUnsettle, threadRef],
  );
  const handleUnsnoozeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsnooze(threadRef);
    },
    [onUnsnooze, threadRef],
  );
  const handleSnoozePreset = useCallback(
    (preset: SnoozePreset) => {
      onSnooze(threadRef, preset);
    },
    [onSnooze, threadRef],
  );
  const handleTogglePinClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // A clicked button keeps focus, and the hover-action cluster stays
      // visible via focus-within; drop focus so it fades with the pointer.
      // Keyboard activation (detail === 0) keeps focus so the cluster stays
      // reachable for Enter/Space users.
      if (event.detail > 0) event.currentTarget.blur();
      onTogglePin(threadRef);
    },
    [onTogglePin, threadRef],
  );
  // While the snooze popover is open the pointer leaves the row, which
  // would fade the hover actions out from under the open menu; pin them.
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // Snooze is offered only where it can succeed: capability-gated and never
  // on blocked-on-you work or queued turns (the server rejects both).
  const showSnoozeButton =
    props.snoozeSupported && canSnooze(thread, { now: new Date().toISOString() });
  // If the thread becomes blocked while the popover is open, the button
  // unmounts without firing onOpenChange(false). Deriving the flag keeps a
  // stale true from permanently hiding the status label / pinning the
  // hover actions, and the effect clears the raw state so the popover
  // doesn't resurrect if the button later remounts.
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  useEffect(() => {
    if (!showSnoozeButton) setSnoozeMenuOpen(false);
  }, [showSnoozeButton]);
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!pr?.url) return;
      const openedInRightPanel = openPrLink(
        event,
        pr.url,
        openPullRequestsInRightPanel ? threadRef : undefined,
      );
      if (openedInRightPanel && openPullRequestsInRightPanel && !props.isActive) {
        onThreadActivate(threadRef);
      }
    },
    [onThreadActivate, openPrLink, openPullRequestsInRightPanel, pr, props.isActive, threadRef],
  );

  // All sidebar rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : isSelected
        ? "bg-sidebar-row-selected text-sidebar-foreground"
        : shouldRecede
          ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    isInFlight &&
      !props.isActive &&
      !isSelected &&
      "opacity-70 transition-opacity hover:opacity-100",
  );

  const title = isRenaming ? (
    <input
      autoFocus
      value={renamingTitle}
      aria-label="Thread title"
      onChange={(event) => onRenameTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleRenameKeyDown}
      onBlur={handleRenameBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      className={cn(
        "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
        shouldRecede ? "font-normal" : "font-medium",
        variant === "card"
          ? cn(
              "truncate",
              isUnread || isWoke
                ? "text-foreground"
                : shouldRecede
                  ? "text-muted-foreground/80"
                  : status === "failed"
                    ? "text-foreground/95"
                    : "text-foreground/90",
            )
          : cn(
              "truncate group-hover/sidebar-row:text-foreground",
              props.isActive || isWoke
                ? "text-foreground"
                : isUnread
                  ? "text-muted-foreground"
                  : "text-muted-foreground/70",
            ),
        isRegeneratingTitle && "opacity-[0.55]",
      )}
    >
      {thread.title}
    </span>
  );

  // A real link so cmd/ctrl+click and middle-click open the host in the
  // browser. A plain click still opens T3's pull request view.
  const prBadge =
    prStatus && pr ? (
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={handlePrClick}
        className={cn(
          // Sidebar chrome follows the interface font; tabular digits keep the
          // number from reflowing as PR states stream in.
          "shrink-0 text-xs tabular-nums hover:underline",
          variant === "slim" && variantAction === "unsettle"
            ? props.isActive
              ? "text-muted-foreground/70"
              : cn("text-muted-foreground/35 transition-colors", settledPrHoverClass)
            : prStatus.colorClass,
        )}
        aria-label={prStatus.tooltip}
      >
        #{pr.number}
      </a>
    ) : null;
  // A t3-generated branch ("t3code/ffeef775") tells you nothing the row does
  // not already say. Once the work has a change request, that is the thing
  // worth naming, so it takes the branch's slot and absorbs the badge.
  // Only the number opens the change request. The title is a label, not a
  // second link to the same place: it stays part of the row, so clicking it
  // opens the thread like clicking any other text on the row does.
  const prLine =
    !isHermes && prStatus && pr ? (
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
        <button
          type="button"
          onClick={handlePrClick}
          className={cn("shrink-0 tabular-nums hover:underline", prStatus.colorClass)}
          aria-label={prStatus.tooltip}
        >
          #{pr.number}
        </button>
        <span className="min-w-0 truncate whitespace-nowrap">{pr.title}</span>
      </span>
    ) : null;
  const terminalStatusIcon = terminalStatus ? (
    <span
      role="img"
      aria-label={terminalProcessLabel(terminalProcessCount)}
      data-testid={`sidebar-terminal-status-${thread.id}`}
      className={cn("inline-flex shrink-0 items-center justify-center", terminalStatus.colorClass)}
    >
      <TerminalIcon className={cn("size-3.5", terminalStatus.pulse && "animate-status-pulse")} />
    </span>
  ) : null;
  // A pinned thread now reaches every shelf, so the marker is the row's pin
  // state cue wherever it lands. It unpins where the environment supports
  // pinning at all, and stays a passive glyph otherwise.
  const pinIndicator = props.isPinned ? (
    props.canPin ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Unpin thread"
              onClick={handleTogglePinClick}
              className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <PinIcon aria-hidden className="size-3 shrink-0" />
        </TooltipTrigger>
        <TooltipPopup>Unpin thread</TooltipPopup>
      </Tooltip>
    ) : (
      <PinIcon
        aria-label="Pinned"
        role="img"
        className="size-3 shrink-0 text-muted-foreground/65"
      />
    )
  ) : null;

  if (variant === "slim") {
    return (
      <li
        data-thread-item
        className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_34px]"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                data-testid="sidebar-row-slim"
                aria-busy={isRegeneratingTitle || undefined}
                className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {/* Settled history recedes: dimmed favicon at rest, restored on
              hover so the tail stays scannable when you're hunting. */}
            <span
              className={cn(
                "shrink-0 transition-opacity",
                !props.isActive &&
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            >
              {isHermes ? (
                <ProviderInstanceIcon
                  driverKind={ProviderDriverKind.make("hermes")}
                  displayName="Hermes"
                  iconClassName="size-4"
                />
              ) : (
                <ProjectFavicon
                  environmentId={thread.environmentId}
                  cwd={props.projectCwd ?? ""}
                  faviconPath={props.projectFaviconPath}
                  className="size-4"
                  fallbackIcon={MessageSquareIcon}
                />
              )}
            </span>
            {title}
            {pinIndicator}
            {terminalStatusIcon}
            {isRegeneratingTitle ? (
              <span role="status" className="sr-only">
                Regenerating title
              </span>
            ) : null}
            {/* The PR badge stays outside the hover-fading slot: it must
              remain visible AND clickable while the row is hovered. Only
              the time/jump label yields to the settle affordance. */}
            {prBadge}
            <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
              <span
                className={cn(
                  "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                  !isWoke && "group-hover/sidebar-row:opacity-0",
                )}
              >
                {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                  // Snoozed rows show when they come BACK, not when they were
                  // last touched — the return ticket is the row's whole story.
                  <span className="text-xs text-blue-600 tabular-nums dark:text-blue-400">
                    {props.snoozeWakeLabelText}
                  </span>
                ) : isWoke ? (
                  // A wake can land straight in the settled tail (e.g. PR
                  // merged while snoozed); the signal must survive the trip.
                  <span
                    role="status"
                    aria-label="Woke from snooze"
                    className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300"
                  >
                    <AlarmClockIcon aria-hidden className="size-3" />
                    Woke
                  </span>
                ) : (
                  <span className="text-xs">
                    {variantAction === "unsettle"
                      ? settledTimeLabel(thread)
                      : threadTimeLabel(thread)}
                  </span>
                )}
              </span>
              {variantAction === "unsnooze" ? (
                !props.snoozeSupported ? null : (
                  <button
                    type="button"
                    aria-label="Wake thread now"
                    onClick={handleUnsnoozeClick}
                    className={cn(
                      "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100",
                      isWoke && "group-hover/sidebar-row:static",
                    )}
                  >
                    <AlarmClockOffIcon className="mb-px size-3" />
                  </button>
                )
              ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Un-settle thread"
                        onClick={handleUnsettleClick}
                        className={cn(
                          "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100",
                          isWoke && "group-hover/sidebar-row:static",
                        )}
                      />
                    }
                  >
                    <Undo2Icon className="mb-px size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Un-settle thread</TooltipPopup>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  aria-label="Settle thread"
                  onClick={handleSettleClick}
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100",
                    isWoke && "group-hover/sidebar-row:static",
                  )}
                >
                  <CheckIcon className="size-3" />
                </button>
              )}
            </span>
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  const diff = latestTurnDiff(thread);

  // Where the row already carries its state, the right slot goes back to being
  // the row's age: Work says it in the leading lozenge and Chat says it as
  // "responding…" under the title, the way a message list does. Woke survives
  // both — a wake is a lifecycle signal neither the lozenge nor the preview
  // line models.
  const headStatus = isWokeStatus
    ? topStatus
    : isWork && workBadge !== null
      ? null
      : isChat && status === "working"
        ? null
        : topStatus;

  // The visible state owns this slot's width: status at rest, actions on
  // hover/keyboard focus or while the popover is open. Keeping the hidden state
  // out of flow lets the label beside it reclaim space without either state
  // overlapping it. Code and Work hang it off the meta line; Chat has no meta
  // line, so it hangs off the title.
  const statusSlot = (
    <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
      {/* Read-only status labels yield to the hover actions. Woke is
          itself an action, so it stays pointer-enabled and visible
          while the other controls appear beside it. */}
      <span
        className={cn(
          isWokeStatus
            ? "pointer-events-auto"
            : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-hover/sidebar-row:absolute group-hover/sidebar-row:right-0 group-hover/sidebar-row:opacity-0",
          "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",
          snoozeMenuOpen && "pointer-events-none absolute right-0 opacity-0",
        )}
      >
        {headStatus ? (
          <span
            className={cn("inline-flex items-center gap-1 font-medium", headStatus.className)}
            // "Background" alone does not say what is out there; the title names
            // the agents and commands the row is still waiting on.
            {...(status === "background" ? { title: formatBackgroundWorkTooltip(thread) } : {})}
          >
            {headStatus.icon === "working" ? (
              <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
            ) : headStatus.icon === "done" ? (
              <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
            ) : headStatus.icon === "woke" ? (
              <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
            ) : null}
            {/* The label alone is the live region: a role="status"
                wrapper around the ticking duration would make
                screen readers announce every second. */}
            <span role="status">{headStatus.label}</span>
            {status === "working" ? (
              <span aria-hidden>
                <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
              </span>
            ) : null}
          </span>
        ) : (
          threadTimeLabel(thread)
        )}
      </span>
      {props.settlementSupported || showSnoozeButton || variant === "card" ? (
        <span
          className={cn(
            // focus-visible, not focus-within: a mouse click leaves
            // the Settle button focused, and a plain focus-within
            // would keep the controls pinned over the status label
            // once the pointer moves away (e.g. after a failed
            // settle) instead of cross-fading back.
            "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:static group-hover/sidebar-row:opacity-100",
            snoozeMenuOpen && "pointer-events-auto static opacity-100",
          )}
        >
          {thread.workInboxRole === "main" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label="Main thread is always pinned"
                    className="inline-flex items-center px-1.5 text-muted-foreground"
                  />
                }
              >
                <PinIcon aria-hidden className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Main thread is always pinned</TooltipPopup>
            </Tooltip>
          ) : props.canPin ? (
            <button
              type="button"
              aria-label={props.isPinned ? "Unpin thread" : "Pin thread"}
              onClick={handleTogglePinClick}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {props.isPinned ? (
                <PinOffIcon aria-hidden className="size-3" />
              ) : (
                <PinIcon aria-hidden className="size-3" />
              )}
            </button>
          ) : null}
          {showSnoozeButton ? (
            <SnoozePopoverButton
              open={snoozeMenuOpen}
              onOpenChange={setSnoozeMenuOpen}
              onSnooze={handleSnoozePreset}
            />
          ) : null}
          {props.settlementSupported ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Settle thread"
                    onClick={handleSettleClick}
                    className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <CheckIcon className="size-3.5" />
                Settle
              </TooltipTrigger>
              <TooltipPopup>Settle thread</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      ) : null}
    </span>
  );

  const titleLine = (
    <>
      {title}
      {isRegeneratingTitle ? (
        <span role="status" className="sr-only">
          Regenerating title
        </span>
      ) : null}
    </>
  );

  // The last thing said, dimmed where the user is the one who said it. Hermes
  // rows have no branch, no repo and no diff, so this is what differs between
  // them — the same line every message list leads with.
  const previewLine = preview ? (
    <span className="min-w-0 flex-1 truncate whitespace-nowrap">
      {preview.fromUser ? <span className="opacity-60">You: </span> : null}
      {preview.text}
    </span>
  ) : (
    <span className="flex-1" />
  );

  const rowIconCluster = (
    <span
      aria-hidden
      className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
    >
      {isRemote ? (
        <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
          <ServerIcon aria-hidden className="size-3.5" />
        </span>
      ) : null}
      {props.isPinned ? (
        <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
          <PinIcon aria-hidden className="size-3.5" />
        </span>
      ) : driverKind && !isHermes ? (
        <span className="inline-flex shrink-0 items-center opacity-60">
          <ProviderInstanceIcon
            driverKind={driverKind}
            displayName={thread.runtime?.providerName ?? modelInstanceId}
            iconClassName="size-3.5"
          />
        </span>
      ) : null}
    </span>
  );

  const sortable = props.sortable;
  return (
    <li
      ref={props.sortable?.setNodeRef}
      style={props.sortable?.style}
      {...props.sortable?.listeners}
      data-thread-item
      className={cn(
        "list-none py-0.5 [content-visibility:auto]",
        isChat ? "[contain-intrinsic-size:auto_66px]" : "[contain-intrinsic-size:auto_96px]",
        props.sortable?.isDragging && "relative z-20 opacity-80",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="button"
              tabIndex={0}
              data-testid="sidebar-row-card"
              aria-busy={isRegeneratingTitle || undefined}
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {workBadgeStyle?.railClassName != null ? (
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-1.5 left-0 z-10 w-[3px] rounded-full",
                workBadgeStyle.railClassName,
              )}
            />
          ) : null}
          <div
            className={cn(
              "relative z-10 px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]",
              // Chat is two lines, not three: it has no meta line to fill.
              isChat ? "h-[3.375rem]" : "h-[4.875rem]",
              workBadgeStyle?.railClassName != null &&
                "pl-[calc(var(--sidebar-row-content-inset)+0.25rem)]",
            )}
          >
            {isChat ? (
              /* T3 Chat: a conversation, so title and time share one line and
                 the last thing said sits under it. There is no meta line above
                 the title, because every row in Chat would have filled it with
                 the same word. */
              <>
                <div className="flex min-w-0 items-center gap-1.5">
                  {titleLine}
                  {statusSlot}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/75">
                  {status === "working" ? (
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sky-600 dark:text-sky-400">
                      responding…
                    </span>
                  ) : (
                    previewLine
                  )}
                  {terminalStatusIcon}
                  {rowIconCluster}
                </div>
              </>
            ) : (
              <>
                <div className="flex h-5 min-w-0 items-center gap-1.5">
                  {isWork ? (
                    /* T3 Work: an inbox item, so the row leads with its state
                       instead of the backing checkout's name. Every Work row
                       runs the same assistant on the same hidden checkout, so
                       naming that is a constant; what differs is state. */
                    <>
                      {workBadgeStyle ? (
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
                            workBadgeStyle.className,
                          )}
                        >
                          {workBadgeStyle.label}
                        </span>
                      ) : null}
                      {/* Only a live run gets a ticking duration. A background
                          row wears the same badge, but its run already settled,
                          so a timer there would be counting nothing. */}
                      {status === "working" ? (
                        <span
                          aria-hidden
                          className="shrink-0 text-xs text-sky-600 tabular-nums dark:text-sky-400"
                        >
                          <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                        </span>
                      ) : null}
                      <span className="flex-1" />
                    </>
                  ) : (
                    <>
                      <ProjectFavicon
                        environmentId={thread.environmentId}
                        cwd={props.projectCwd ?? ""}
                        faviconPath={props.projectFaviconPath}
                        className="size-4 shrink-0"
                      />
                      {props.projectTitle ? (
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-xs text-muted-foreground/85",
                            shouldRecede ? "font-normal" : "font-medium",
                          )}
                        >
                          {props.projectTitle}
                        </span>
                      ) : (
                        <span className="flex-1" />
                      )}
                    </>
                  )}
                  {statusSlot}
                </div>
                <div className="mt-1 flex min-w-0">{titleLine}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/75">
                  {isWork ? (
                    previewLine
                  ) : prLine ? (
                    prLine
                  ) : thread.branch ? (
                    <>
                      <ThreadWorktreeIndicator thread={thread} />
                      <span className="min-w-0 flex-1 truncate whitespace-nowrap">
                        {thread.branch}
                      </span>
                    </>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {terminalStatusIcon}
                  {isWork || prLine ? null : prBadge}
                  {!isHermes && diff ? (
                    <span className="shrink-0 font-mono">
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{diff.insertions}
                      </span>{" "}
                      <span className="text-red-600 dark:text-red-400">−{diff.deletions}</span>
                    </span>
                  ) : null}
                  {rowIconCluster}
                </div>
              </>
            )}
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );
});

type SidebarThreadRowProps = ComponentProps<typeof SidebarThreadRow>;

// Sortable shell for active cards: useSortable is a hook, so it can't run
// inside the render loop's row factory — each draggable row needs its own
// component instance.
function SortableSidebarThreadRow(
  props: Omit<SidebarThreadRowProps, "sortable"> & { sortableId: string },
) {
  const { sortableId, ...rowProps } = props;
  const { isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: sortableId,
    animateLayoutChanges: animatePinnedLayoutChanges,
  });
  const sortable = useMemo<SidebarThreadRowSortable>(
    () => ({
      setNodeRef,
      style: { transform: CSS.Translate.toString(transform), transition },
      listeners,
      isDragging,
    }),
    [isDragging, listeners, setNodeRef, transform, transition],
  );
  return <SidebarThreadRow {...rowProps} sortable={sortable} />;
}

function latestTurnDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  // Shells don't carry checkpoint summaries; diff stats render only when the
  // shell projection grows them. Kept as a seam so the row layout is ready.
  void thread;
  return null;
}

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  thread: SidebarThreadSummary;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  projectTitle: string | null;
  environmentLabel: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  onHighlight: () => void;
  onSelect: () => void;
}) {
  const { thread } = props;
  // Same details tooltip as the regular rows: a search hit is still a thread,
  // and the hover card is how you disambiguate identically-titled results.
  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const driverKind = providerEntry?.driverKind ?? null;
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  return (
    <li role="presentation" className="list-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              id={props.resultId}
              type="button"
              role="option"
              // aria-activedescendant options: focus stays on the search input,
              // which owns all keyboard interaction for the listbox.
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={props.isRouteActive ? "page" : undefined}
              aria-label={
                props.projectTitle ? `${thread.title}, ${props.projectTitle}` : thread.title
              }
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
            />
          }
        >
          <ProjectFavicon
            environmentId={thread.environmentId}
            cwd={props.projectCwd ?? ""}
            faviconPath={props.projectFaviconPath}
            className="size-4 shrink-0"
            fallbackIcon={MessageSquareIcon}
          />
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground/55 tabular-nums">
            {threadTimeLabel(thread)}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={thread}
          projectTitle={props.projectTitle}
          projectCwd={props.projectCwd}
          projectFaviconPath={props.projectFaviconPath}
          environmentLabel={props.environmentLabel}
          providerEntry={providerEntry}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={
            driverKind === "hermes" || (driverKind === null && modelInstanceId === "hermes")
              ? null
              : branchMismatch
          }
          showProjectContext={
            !(driverKind === "hermes" || (driverKind === null && modelInstanceId === "hermes"))
          }
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});

export default function Sidebar() {
  const [workspace, setWorkspace] = useSidebarWorkspace();
  const [workspaceRoutes, setWorkspaceRoutes] = useLocalStorage(
    SIDEBAR_WORKSPACE_ROUTES_STORAGE_KEY,
    {},
    SIDEBAR_WORKSPACE_ROUTES_SCHEMA,
  );
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threadOrder = useUiStateStore((store) => store.threadOrder);
  const reorderThreads = useUiStateStore((store) => store.reorderThreads);
  const threads = useThreadShells();
  const pinnedThreadKeySet = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => thread.pinnedAt !== null || thread.workInboxRole === "main")
          .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      ),
    [threads],
  );
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((s) => s.sidebarAutoSettleOnMerge);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const confirmThreadUnpin = useClientSettings((s) => s.confirmThreadUnpin);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const markThreadUnread = useMarkThreadUnread();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const generateHandoffScript = useAtomCommand(orchestrationEnvironment.v2.generateHandoffScript, {
    reportFailure: false,
  });
  const toggleThreadPin = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        const nextPinned = !pinnedThreadKeySet.has(threadKey);
        if (!nextPinned) {
          // Unpinning is the destructive half: it drops the thread out of the
          // pinned section and clears its order key. Gated on the same
          // `confirmThreadUnpin` preference the thread action menu reads.
          const localApi = readLocalApi();
          const confirmation = await requestThreadUnpinConfirmation({
            enabled: confirmThreadUnpin,
            title: readThreadShell(threadRef)?.title ?? "this thread",
            confirm: localApi ? (message) => localApi.dialogs.confirm(message) : null,
          });
          if (confirmation._tag === "Failure" || !confirmation.value) {
            return;
          }
        }
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            pinned: nextPinned,
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to update pin",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [confirmThreadUnpin, pinnedThreadKeySet, updateThreadMetadata],
  );
  const createProject = useAtomCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
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
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyHandoffScriptToClipboard } = useCopyToClipboard({
    target: "handoff script",
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Handoff script copied",
        description: "Paste it into a new agent session to continue this thread.",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy handoff script",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
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
  const [projectScopeMenuOpen, setProjectScopeMenuOpen] = useState(false);
  const newThreadContext = useHandleNewThread();
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;
  // Post-settle navigation validates against the CURRENT route, not the one
  // captured when the settle started: if the user navigated elsewhere while
  // the command was in flight, completing it must not yank them away.
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;
  useEffect(() => {
    if (routeThreadKey === null || workspaceRoutes[workspace] === routeThreadKey) return;
    setWorkspaceRoutes((current) => ({ ...current, [workspace]: routeThreadKey }));
  }, [routeThreadKey, setWorkspaceRoutes, workspace, workspaceRoutes]);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const visibleProjects = useMemo(
    () => projects.filter((project) => !isT3WorkBackingProject(project, serverConfigs)),
    [projects, serverConfigs],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: visibleProjects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, visibleProjects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: sidebarProjectSortOrder === "manual" ? orderedProjects : visibleProjects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      visibleProjects,
      sidebarProjectSortOrder,
    ],
  );
  const projectGroups = useMemo(
    () => sortSidebarV2ProjectGroups(unsortedProjectGroups, threads, sidebarProjectSortOrder),
    [sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  // Threads on non-primary environments (T3 Connect, hosted) resolve their
  // provider entry from their own environment's config: default instance ids
  // are driver slugs, so a flat map would collide across environments.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );
  const providerDriverKindByInstance = useMemo(() => {
    const result = new Map<string, ProviderInstanceEntry["driverKind"]>();
    for (const [environmentId, serverConfig] of serverConfigs) {
      for (const provider of serverConfig.providers) {
        result.set(sidebarProviderInstanceKey(environmentId, provider.instanceId), provider.driver);
      }
    }
    return result;
  }, [serverConfigs]);
  // Work-mode environment scope: one menu above the list, mirroring the
  // code-mode project scope. Scoping filters the visible work threads and
  // retargets the New-thread composer to the selected environment. Unlike the
  // project scope this is never "all": Work and Chat run on one machine's
  // Hermes, so the menu offers the machines that can host them and the choice
  // is remembered across reloads.
  const [storedWorkEnvironmentScopeId, setStoredWorkEnvironmentScopeId] =
    useWorkEnvironmentScopePreference();
  const workThreadEnvironmentIds = useMemo(() => {
    const ids = new Set<EnvironmentId>();
    if (workspace !== "work" && workspace !== "chat") return ids;
    for (const thread of threads) {
      if (isThreadVisibleInSidebarWorkspace(thread, workspace, providerDriverKindByInstance)) {
        ids.add(thread.environmentId);
      }
    }
    return ids;
  }, [providerDriverKindByInstance, threads, workspace]);
  const { options: workEnvironmentOptions, scopeId: workEnvironmentScopeId } = useMemo(
    () =>
      resolveWorkEnvironmentScope({
        environments,
        serverConfigs,
        threadEnvironmentIds: workThreadEnvironmentIds,
        storedEnvironmentId: storedWorkEnvironmentScopeId,
        primaryEnvironmentId,
      }),
    [
      environments,
      primaryEnvironmentId,
      serverConfigs,
      storedWorkEnvironmentScopeId,
      workThreadEnvironmentIds,
    ],
  );
  const workTargetEnvironmentId = workEnvironmentScopeId ?? primaryEnvironmentId;
  const hermesProviderEntry = useMemo(() => {
    const scopedProviders =
      workTargetEnvironmentId === null
        ? undefined
        : serverConfigs.get(workTargetEnvironmentId)?.providers;
    if (scopedProviders !== undefined) return findReadyHermesEntry(scopedProviders);
    if (workTargetEnvironmentId !== primaryEnvironmentId || primaryEnvironmentId === null) {
      return null;
    }
    return findReadyHermesEntry(serverConfigs.get(primaryEnvironmentId)?.providers ?? []);
  }, [primaryEnvironmentId, serverConfigs, workTargetEnvironmentId]);
  const t3WorkDirectory = t3WorkDirectoryForEnvironment(serverConfigs, workTargetEnvironmentId);
  const hermesBackingProject =
    projects.find(
      (project) =>
        project.environmentId === workTargetEnvironmentId &&
        t3WorkDirectory !== null &&
        project.workspaceRoot === t3WorkDirectory,
    ) ?? null;
  const t3WorkProjectCreateRef = useRef<string | null>(null);
  // Bumped by the failure toast's "Try again" action: clearing the ref alone
  // would not re-run the effect, since none of its other inputs changed.
  const [t3WorkCreateRetry, setT3WorkCreateRetry] = useState(0);
  useEffect(() => {
    if (
      (workspace !== "work" && workspace !== "chat") ||
      workTargetEnvironmentId === null ||
      t3WorkDirectory === null ||
      hermesProviderEntry === null ||
      hermesBackingProject !== null
    ) {
      return;
    }
    const createKey = `${workTargetEnvironmentId}:${t3WorkDirectory}`;
    if (t3WorkProjectCreateRef.current === createKey) return;
    t3WorkProjectCreateRef.current = createKey;
    void createT3WorkBackingProject({
      createProject,
      environmentId: workTargetEnvironmentId,
      workspaceRoot: t3WorkDirectory,
      hermesProviderEntry,
      onRetry: () => {
        t3WorkProjectCreateRef.current = null;
        setT3WorkCreateRetry((value) => value + 1);
      },
    }).then((outcome) => {
      // An interrupted command may retry later; release the guard. Keep it
      // set on a real failure so effect re-runs for the same
      // environment/directory pair do not retry and re-toast endlessly.
      if (outcome === "interrupted") {
        t3WorkProjectCreateRef.current = null;
      }
    });
  }, [
    createProject,
    hermesBackingProject,
    hermesProviderEntry,
    t3WorkDirectory,
    t3WorkCreateRetry,
    workTargetEnvironmentId,
    workspace,
  ]);
  const [hermesImportOpen, setHermesImportOpen] = useState(false);
  const projectCwdByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          `${project.environmentId}:${project.id}`,
          project.workspaceRoot,
        ]),
      ),
    [projects],
  );
  const projectFaviconPathByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [`${project.environmentId}:${project.id}`, project.faviconPath]),
      ),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );

  // now is quantized to the minute so effectiveSettled memoization doesn't
  // churn on every render; auto-settle thresholds are day-granular anyway.
  const nowMinute = useNowMinute();
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute. The
  // tick is a plain counter bumped exactly at the next wake boundary (armed
  // below, after the partition knows the boundary); the partition reads a
  // fresh clock whenever it recomputes.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);

  // PR snapshots stream in per-row (rows own the VCS subscriptions) and
  // outlive a checkout switch. The next partition applies the configured merge
  // rule and the always-on close rule.
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom);

  // Project scope: one menu above the list. Scoping filters the list without
  // making the header width depend on the number or length of project names.
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null);
  const scopedProjectGroup = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null),
    [projectGroups, projectScopeKey],
  );
  const scopedProjectKeys = useMemo(
    () =>
      scopedProjectGroup === null
        ? null
        : new Set(
            scopedProjectGroup.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
    [scopedProjectGroup],
  );
  useEffect(() => {
    if (projectScopeKey !== null && scopedProjectGroup === null) {
      setProjectScopeKey(null);
    }
  }, [projectScopeKey, scopedProjectGroup]);
  // Count-only subscription: the parent needs "are there draft rows" for the
  // empty state, while SidebarDraftBlock owns the per-keystroke content
  // subscription. Selecting a number keeps typing in a draft composer from
  // re-rendering the whole sidebar. Approximates the block's row filter
  // (every non-promoted session with content); it can overcount by one for
  // an open never-left draft, which only softens the empty state.
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (
        scopedProjectKeys !== null &&
        !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      count += 1;
    }
    return count;
  });
  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey, workEnvironmentScopeId]);

  const handleProjectSettings = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, projectGroup: SidebarProjectSnapshot) => {
      event.preventDefault();
      event.stopPropagation();
      setProjectScopeMenuOpen(false);
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: { projectKey: projectGroup.projectKey },
      });
    },
    [isMobile, router, setOpenMobile],
  );

  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells: no archived-snapshot
  // merging, no optimistic holds. Archived threads remain hidden here —
  // archive keeps its original "remove from sidebar" meaning.
  const { activeThreads, snoozedThreads, settledThreads, snoozeNow } = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    // Snooze classification uses a REAL clock, not the quantized minute:
    // wake times are second-precise and a woken thread must not linger on
    // the shelf for the rest of the minute. snoozeWakeTick re-runs this
    // memo exactly at the next wake boundary.
    void snoozeWakeTick;
    const preciseNow = new Date().toISOString();
    const visible = threads.filter(
      (thread) =>
        isThreadVisibleInSidebarWorkspace(thread, workspace, providerDriverKindByInstance) &&
        (workspace === "work" || workspace === "chat"
          ? workEnvironmentScopeId === null || thread.environmentId === workEnvironmentScopeId
          : scopedProjectKeys === null ||
            scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
    );
    const active: EnvironmentThreadShell[] = [];
    const snoozed: EnvironmentThreadShell[] = [];
    const settled: EnvironmentThreadShell[] = [];
    for (const thread of visible) {
      // Threads on servers without the settlement capability (old server,
      // or descriptor not loaded yet) never classify as settled: the user
      // could neither un-settle nor pin them, so auto-settling them would
      // strand rows in a tail with no working affordances.
      const supportsSettlement =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
      const supportsSnooze =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const snapshot = changeRequestSnapshotByKey.get(threadKey);
      const changeRequest =
        snapshot != null &&
        (thread.linkedPullRequest == null
          ? thread.worktreePath === null || snapshot.branch === thread.branch
          : snapshot.linkedPullRequest?.projectId === thread.linkedPullRequest.projectId &&
            snapshot.linkedPullRequest.repository === thread.linkedPullRequest.repository &&
            snapshot.linkedPullRequest.number === thread.linkedPullRequest.number)
          ? snapshot.pr
          : null;
      // Snooze outranks settled classification: an explicitly snoozed thread
      // belongs to the shelf even if it would also auto-settle (the shelf's
      // wake time is a stronger statement about when it matters again).
      // A pin does not outrank either: a settled pinned thread belongs in the
      // settled shelf, keeping its pin (and its place at the top of active)
      // for when it wakes.
      const fixedInMain = thread.workInboxRole === "main";
      if (!fixedInMain && supportsSnooze && effectiveSnoozed(thread, { now: preciseNow })) {
        snoozed.push(thread);
      } else if (
        !fixedInMain &&
        supportsSettlement &&
        effectiveSettled(thread, {
          now,
          autoSettleAfterDays,
          autoSettleOnMerge,
          changeRequest,
        })
      ) {
        settled.push(thread);
      } else {
        active.push(thread);
      }
    }
    const isPinnedThread = (thread: EnvironmentThreadShell) =>
      pinnedThreadKeySet.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
    return {
      activeThreads: applyManualThreadOrderForSidebarV2(
        sortThreadsForSidebar(active, isPinnedThread),
        threadOrder,
        (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        isPinnedThread,
      ),
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozedThreads: snoozed.toSorted(
        (left, right) =>
          firstValidTimestampMs(left.snoozedUntil ?? null) -
          firstValidTimestampMs(right.snoozedUntil ?? null),
      ),
      settledThreads: sortSettledThreadsForSidebar(settled),
      snoozeNow: preciseNow,
    };
  }, [
    autoSettleAfterDays,
    autoSettleOnMerge,
    changeRequestSnapshotByKey,
    nowMinute,
    pinnedThreadKeySet,
    providerDriverKindByInstance,
    scopedProjectKeys,
    serverConfigs,
    snoozeWakeTick,
    threadOrder,
    threads,
    workEnvironmentScopeId,
    workspace,
  ]);
  const { mainThreads, needsYouThreads, ordinaryActiveThreads } = useMemo(() => {
    const main: EnvironmentThreadShell[] = [];
    const needsYou: EnvironmentThreadShell[] = [];
    const active: EnvironmentThreadShell[] = [];
    for (const thread of activeThreads) {
      switch (workInboxActiveSection(thread)) {
        case "main":
          main.push(thread);
          break;
        case "needs-you":
          needsYou.push(thread);
          break;
        case "active":
          active.push(thread);
          break;
      }
    }
    return {
      mainThreads: main,
      needsYouThreads: needsYou,
      ordinaryActiveThreads: active,
    };
  }, [activeThreads]);

  // Drag scope: the sortable id list in exact render order, plus each key's
  // visual section. A drop only reorders within its own section — dragging a
  // card into Snoozed/Settled or across work-inbox sections has no meaning
  // here (section membership comes from thread state, not position).
  const { sortableThreadKeys, activeSectionByKey } = useMemo(() => {
    const keyOf = (thread: EnvironmentThreadShell) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (workspace !== "work") {
      const keys = activeThreads.map(keyOf);
      return {
        sortableThreadKeys: keys,
        activeSectionByKey: new Map(keys.map((key) => [key, "active"] as const)),
      };
    }
    const sectionByKey = new Map<string, "main" | "needs-you" | "active">();
    const keys: string[] = [];
    for (const [section, sectionThreads] of [
      ["main", mainThreads],
      ["needs-you", needsYouThreads],
      ["active", ordinaryActiveThreads],
    ] as const) {
      for (const thread of sectionThreads) {
        const key = keyOf(thread);
        keys.push(key);
        sectionByKey.set(key, section);
      }
    }
    return { sortableThreadKeys: keys, activeSectionByKey: sectionByKey };
  }, [activeThreads, mainThreads, needsYouThreads, ordinaryActiveThreads, workspace]);

  const threadDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const threadCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }
    return closestCorners(args);
  }, []);
  // A completed drag's pointerup still fires a click on the row, which would
  // navigate to the dropped thread. The flag stays up through that synchronous
  // click and resets on the next macrotask, so a cancelled drag (Escape, no
  // click) can't swallow a later legitimate click.
  const suppressThreadClickAfterDragRef = useRef(false);
  // Auto-animate FLIPs rows on DOM reorder, which fights dnd-kit's transforms
  // mid-drag; pause it for the drag and resume after the drop settles.
  const listAutoAnimateControllerRef = useRef<ReturnType<typeof autoAnimate> | null>(null);
  const handleThreadDragStart = useCallback((_event: DragStartEvent) => {
    suppressThreadClickAfterDragRef.current = true;
    listAutoAnimateControllerRef.current?.disable();
  }, []);
  const finishThreadDrag = useCallback(() => {
    window.setTimeout(() => {
      suppressThreadClickAfterDragRef.current = false;
    }, 0);
    window.requestAnimationFrame(() => listAutoAnimateControllerRef.current?.enable());
  }, []);
  const handleThreadDragCancel = useCallback(
    (_event: DragCancelEvent) => finishThreadDrag(),
    [finishThreadDrag],
  );
  const handleThreadDragEnd = useCallback(
    (event: DragEndEvent) => {
      finishThreadDrag();
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeKey = String(active.id);
      const overKey = String(over.id);
      const activeSection = activeSectionByKey.get(activeKey);
      if (activeSection === undefined || activeSection !== activeSectionByKey.get(overKey)) {
        return;
      }
      reorderThreads(sortableThreadKeys, [activeKey], [overKey]);
    },
    [activeSectionByKey, finishThreadDrag, reorderThreads, sortableThreadKeys],
  );

  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const searchableThreads = useMemo(
    () => [...activeThreads, ...snoozedThreads, ...settledThreads],
    [activeThreads, settledThreads, snoozedThreads],
  );
  const threadSearchResults = useMemo(
    () => searchSidebarThreadsByTitle(searchableThreads, threadSearchQuery),
    [searchableThreads, threadSearchQuery],
  );
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    .join("\0");

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [threadSearchResultOrderKey]);

  useEffect(() => {
    if (!isSearchingThreads) return;
    document
      .getElementById(`sidebar-thread-search-result-${activeSearchResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isSearchingThreads, threadSearchResultOrderKey]);

  // Arm a timeout for the earliest upcoming wake so the shelf empties the
  // moment a snooze expires instead of on the next minute tick. Sorted
  // soonest-first, so entry 0 is the boundary.
  useEffect(() => {
    const nextWakeAtMs =
      snoozedThreads.length > 0 && snoozedThreads[0]?.snoozedUntil != null
        ? Date.parse(snoozedThreads[0].snoozedUntil)
        : Number.NaN;
    if (Number.isNaN(nextWakeAtMs)) return;
    // setTimeout delays are signed 32-bit: anything larger overflows and
    // fires immediately, turning a far-future wake (event-condition snoozes
    // synced from elsewhere) into a tight re-arm loop. Clamped, the timer
    // just re-arms every ~24.8 days until the wake is in range.
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozedThreads]);

  // The settled tail renders in pages: history shouldn't dominate the
  // sidebar, and the common lookups are recent. Expansion resets when the
  // filter context changes so a scope/search flip never inherits a deep
  // page state.
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const settledResetKey =
    workspace === "work" || workspace === "chat"
      ? `${workspace}:${workEnvironmentScopeId ?? "all"}`
      : `code:${projectScopeKey ?? "all"}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
  }
  const visibleSettledThreads = useMemo(() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    // The open thread must never hide under "Show more": navigating into a
    // deep settled thread (search, deep link) pulls its row into the visible
    // tail so the highlight and the un-settle affordance stay reachable.
    if (routeThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  }, [routeThreadKey, settledThreads, settledVisibleCount]);
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const toggleSettledShelf = useCallback(
    () => setSettledShelfExpanded((value) => !value),
    [setSettledShelfExpanded],
  );
  const renderedSettledThreads = useMemo(() => {
    if (settledShelfExpanded) return visibleSettledThreads;
    if (routeThreadKey === null) return [];
    const routeThread = visibleSettledThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? [] : [routeThread];
  }, [routeThreadKey, settledShelfExpanded, visibleSettledThreads]);

  // The snoozed shelf is collapsed by default: out of the way, never gone.
  // Collapsed threads don't render (and so don't participate in jump
  // shortcuts or multi-select), matching the settled tail's paging model.
  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSnoozedShelf = useCallback(
    () => setSnoozedShelfExpanded((value) => !value),
    [setSnoozedShelfExpanded],
  );
  const visibleSnoozedThreads = useMemo(() => {
    if (snoozedShelfExpanded) return snoozedThreads;
    // The open thread must never vanish behind the collapsed shelf: a
    // snoozed thread reached by route (deep link, open before snoozing
    // elsewhere) keeps its row — with highlight and wake affordance — same
    // exception the settled tail's "Show more" makes.
    if (routeThreadKey === null) return [];
    const routeThread = snoozedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? [] : [routeThread];
  }, [routeThreadKey, snoozedShelfExpanded, snoozedThreads]);

  const orderedThreads = useMemo(
    () => [...activeThreads, ...visibleSnoozedThreads, ...renderedSettledThreads],
    [activeThreads, visibleSnoozedThreads, renderedSettledThreads],
  );
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  // Rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  // handleNewThread is inherently unstable (depends on the projects list);
  // a ref keeps it out of attemptSettle's dependency array.
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  handleNewThreadRef.current = newThreadContext.handleNewThread;
  const settledThreadKeys = useMemo(
    () =>
      new Set(
        settledThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [settledThreads],
  );
  const settledThreadKeysRef = useRef(settledThreadKeys);
  settledThreadKeysRef.current = settledThreadKeys;
  const snoozedThreadKeys = useMemo(
    () =>
      new Set(
        snoozedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [snoozedThreads],
  );
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);
  snoozedThreadKeysRef.current = snoozedThreadKeys;

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();

  // Settled threads are live shells, so opening one is plain navigation:
  // history stays readable without un-settling, and sending a message or
  // starting a session un-settles server-side.
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
  // The work-mode composer target: a fresh draft on the Hermes backing
  // project. Returns false when Hermes is not ready so callers can fall back.
  const openWorkComposer = useCallback((): boolean => {
    const hermesModel =
      hermesProviderEntry?.models.find((model) => model.slug === "default") ??
      hermesProviderEntry?.models[0] ??
      null;
    if (!hermesBackingProject || !hermesProviderEntry || !hermesModel) return false;
    if (isMobile) setOpenMobile(false);
    void newThreadContext.handleNewThread(
      scopeProjectRef(hermesBackingProject.environmentId, hermesBackingProject.id),
      {
        fresh: true,
        modelSelection: {
          instanceId: hermesProviderEntry.instanceId,
          model: hermesModel.slug,
        },
      },
    );
    return true;
  }, [hermesBackingProject, hermesProviderEntry, isMobile, newThreadContext, setOpenMobile]);
  const handleWorkspaceChange = useCallback(
    (nextWorkspace: SidebarWorkspace) => {
      if (nextWorkspace === workspace) return;
      setWorkspace(nextWorkspace);
      // A draft composer is only workspace-neutral when its project does not
      // pin it to one side: a draft on the Hermes backing project is a Work
      // composer and must not stay open when switching to Code.
      const routeDraftWorkspace = (() => {
        const target = routeTargetRef.current;
        if (target?.kind !== "draft") return null;
        const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
        if (draft === null) return null;
        const draftProject =
          projects.find(
            (project) =>
              project.environmentId === draft.environmentId && project.id === draft.projectId,
          ) ?? null;
        // Unknown project (still loading) stays neutral rather than guessing.
        if (draftProject === null) return null;
        return isT3WorkBackingProject(draftProject, serverConfigs)
          ? ("work" as const)
          : ("code" as const);
      })();
      const navigation = resolveWorkspaceSwitchNavigation({
        nextWorkspace,
        rememberedThreadKey: workspaceRoutes[nextWorkspace],
        routeThreadKey,
        routeDraftWorkspace,
        threads: threads.map((thread) => ({
          ...thread,
          threadKey: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        })),
        providerDriverKindByInstance,
      });
      if (navigation.kind === "remembered-thread") {
        const rememberedThread = threads.find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
            navigation.threadKey,
        );
        if (rememberedThread) {
          navigateToThread(scopeThreadRef(rememberedThread.environmentId, rememberedThread.id));
        }
        return;
      }
      if (navigation.kind === "new-chat") {
        if (workspaceLandingKind(nextWorkspace) === "chat-composer") {
          // Chat lands on a composer, so open it here rather than bouncing
          // through the index route: this path honors the work environment
          // scope, and when Hermes cannot open, staying on the current thread
          // beats a dead landing. Code and Work land on a page, which the
          // index route renders per workspace.
          openWorkComposer();
          return;
        }
        void router.navigate({ to: "/" });
      }
    },
    [
      navigateToThread,
      openWorkComposer,
      projects,
      providerDriverKindByInstance,
      routeThreadKey,
      serverConfigs,
      router,
      setWorkspace,
      threads,
      workspace,
      workspaceRoutes,
    ],
  );
  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      // Unconditional: also drops a stale selection anchor left by
      // plain-click navigation, so a later shift-click starts fresh
      // instead of ranging from a row that is no longer the context.
      // (clearSelection no-ops when there is nothing to clear.)
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, router, setOpenMobile],
  );

  const clearThreadSearch = useCallback(() => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);
  const selectThreadSearchResult = useCallback(
    (thread: EnvironmentThreadShell) => {
      clearThreadSearch();
      navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [clearThreadSearch, navigateToThread],
  );
  const handleThreadSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // IME composition (Japanese/Chinese input) uses the same keys; committing
      // a candidate must not move the highlight or navigate away mid-compose.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && isSearchingThreads) {
        event.preventDefault();
        event.stopPropagation();
        clearThreadSearch();
        return;
      }
      if (threadSearchResults.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSearchResultIndex(
          (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = threadSearchResults[activeSearchResultIndex];
        if (result) selectThreadSearchResult(result);
      }
    },
    [
      activeSearchResultIndex,
      clearThreadSearch,
      isSearchingThreads,
      selectThreadSearchResult,
      threadSearchResults,
    ],
  );

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      void (async () => {
        const trimmed = title.trim();
        setRenamingThreadKey(null);
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
          return;
        }
        if (trimmed === originalTitle) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: trimmed },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [updateThreadMetadata],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      if (suppressThreadClickAfterDragRef.current) {
        event.preventDefault();
        return;
      }
      if (isSidebarNestedLinkClick(event.target)) return;
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  );

  // A settle per thread at a time: double clicks and repeated menu picks
  // must not dispatch a second settle that fails and toasts a false error.
  const settlingThreadKeysRef = useRef(new Set<string>());
  // Parking the thread you're looking at (settle or snooze) moves you
  // forward: the next remaining card (never a settled or snoozed row, never
  // one leaving in the same batch), or a fresh draft in this project when it
  // was the last active one. Callers snapshot the plan BEFORE the command
  // mutates the partition; background parks never navigate (null plan).
  const planForwardNavigation = useCallback(
    (threadKey: string, coParkingKeys?: ReadonlySet<string>): (() => void) | null => {
      if (routeThreadKeyRef.current !== threadKey) return null;
      const shell = threadByKeyRef.current.get(threadKey);
      const orderedKeys = orderedThreadKeysRef.current;
      const settledKeys = settledThreadKeysRef.current;
      const snoozedKeys = snoozedThreadKeysRef.current;
      const currentIndex = orderedKeys.indexOf(threadKey);
      const nextCardKey =
        currentIndex === -1
          ? null
          : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
              (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
            ) ?? null);
      const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
      return nextThread
        ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
        : shell
          ? () =>
              void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
          : () => void router.navigate({ to: "/" });
    },
    [navigateToThread, router],
  );

  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, opts: { coSettlingKeys?: ReadonlySet<string> } = {}) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (settlingThreadKeysRef.current.has(threadKey)) return;
        settlingThreadKeysRef.current.add(threadKey);
        try {
          const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
          const result = await settleThread(threadRef);
          if (result._tag === "Failure") {
            // Never navigate away from a thread that did not settle.
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to settle thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          // Only move forward if the user is still on the settled thread —
          // a navigation made during the await wins over ours.
          if (routeThreadKeyRef.current === threadKey) {
            navigateAfterSettle?.();
          }
        } finally {
          settlingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [planForwardNavigation, settleThread],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unsettleThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to un-settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [unsettleThread],
  );
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await unsnoozeThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to wake thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [unsnoozeThread],
  );
  // One snooze per thread at a time — same double-dispatch guard as settle.
  const snoozingThreadKeysRef = useRef(new Set<string>());
  const attemptSnooze = useCallback(
    (
      threadRef: ScopedThreadRef,
      preset: SnoozePreset,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (snoozingThreadKeysRef.current.has(threadKey)) return;
        snoozingThreadKeysRef.current.add(threadKey);
        try {
          // Snoozing the open thread moves you forward, same as settle —
          // both park the thread you're done with for now.
          const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure") {
            // Never navigate away from a thread that did not snooze.
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to snooze thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          // Snooze hides the row, so the toast is the only confirmation —
          // and the Undo is the escape hatch for a mis-click.
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `Snoozed until ${snoozeWakeDescription(preset.snoozedUntil, new Date(), timestampFormat)}`,
              timeout: 5_000,
              actionProps: {
                children: "Undo",
                onClick: () => attemptUnsnooze(threadRef),
              },
            }),
          );
          // Only move forward if the user is still on the snoozed thread —
          // a navigation made during the await wins over ours.
          if (routeThreadKeyRef.current === threadKey) {
            navigateAfterSnooze?.();
          }
        } finally {
          snoozingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [attemptUnsnooze, planForwardNavigation, snoozeThread],
  );

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // One exact actionable set: keys whose rows are actually rendered
      // right now. Selections can outlive their rows (settled-tail paging,
      // thread deletion elsewhere) and the menu labels must count only what
      // the actions will touch.
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys].filter(
        (threadKey) => threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      // Snooze (N) is offered when every selected thread can actually take
      // it — a mixed selection with blocked-on-you work would half-apply.
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread, { now: selectionNow.toISOString() }),
      );
      const titleRegenerationThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true,
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "settle", label: `Settle (${count})` },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    children: snoozePresets.map((preset) => ({
                      id: `snooze:${preset.id}`,
                      label: `${preset.label} (${preset.whenLabel})`,
                    })),
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem ? [titleRegenerationMenuItem] : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            { id: "delete", label: `Delete (${count})`, destructive: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value?.startsWith("snooze:")) {
        const preset = snoozePresets.find(
          (candidate) => `snooze:${candidate.id}` === clicked.value,
        );
        if (preset) {
          // Post-snooze navigation must skip threads snoozing in this same
          // batch — they are all leaving the card block together.
          const coSnoozingKeys = new Set(threadKeys);
          for (const thread of selectedThreads) {
            attemptSnooze(scopeThreadRef(thread.environmentId, thread.id), preset, {
              coSnoozingKeys,
            });
          }
          clearSelection();
        }
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        // Post-settle navigation must skip threads settling in this same
        // batch — they are all leaving the card block together. Rows that
        // are already explicitly settled are skipped: nothing to do on a
        // valid mixed selection. Pinned rows ARE included: the decider
        // clears the pin as part of settling, so they park like the rest.
        const coSettlingKeys = new Set(threadKeys);
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread || thread.settledOverride === "settled") continue;
          attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
        }
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) continue;
          markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      // Grown as deletions actually land, never seeded with the whole batch:
      // orphaned-worktree detection must only discount threads that are
      // really gone, or the first delete would treat still-alive batch mates
      // as deleted and remove a worktree they still point at.
      const deletedThreadKeys = new Set<string>();
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        const result = await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to delete threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        deletedThreadKeys.add(threadKey);
      }
      removeFromSelection(threadKeys);
    },
    [
      attemptSettle,
      attemptSnooze,
      clearSelection,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      serverConfigs,
      updateThreadMetadata,
    ],
  );

  const handleThreadContextMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
          null;
        // Un-settle works on every settled row: for explicit settles it
        // clears the override, for auto-settled rows it pins the thread
        // active until real activity clears the pin. Environments without
        // the settlement capability get no lifecycle items at all.
        const isWorkMain = thread.workInboxRole === "main";
        const supportsSettlement =
          !isWorkMain &&
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
            true;
        const supportsSnooze =
          !isWorkMain &&
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const supportsTitleRegeneration =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const isThreadRunning =
          thread.runtime?.status === "running" && thread.runtime.activeRunId != null;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        const isPinned = pinnedThreadKeySet.has(threadKey);
        const canPin = canPinWorkInboxThread({
          thread,
          providerDriverKindByInstance,
          isSnoozed,
          isSettled,
        });
        // Presets resolve at menu-open time (same as the popover).
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              ...(thread.branch
                ? [
                    {
                      id: "new-thread-on-branch",
                      label: `New thread on ${thread.branch}`,
                      icon: "message-square-plus",
                    },
                  ]
                : []),
              ...(supportsSettlement
                ? [
                    isSettled
                      ? { id: "unsettle", label: "Un-settle thread", icon: "circle-check" }
                      : { id: "settle", label: "Settle thread", icon: "circle-check" },
                  ]
                : []),
              ...(supportsSnooze
                ? [
                    isSnoozed
                      ? { id: "unsnooze", label: "Wake thread", icon: "clock" }
                      : {
                          id: "snooze",
                          label: "Snooze",
                          icon: "clock",
                          disabled: !canSnooze(thread, { now: new Date().toISOString() }),
                          children: snoozePresets.map((preset) => ({
                            id: `snooze:${preset.id}`,
                            label: `${preset.label} (${preset.whenLabel})`,
                          })),
                        },
                  ]
                : []),
              ...(canPin
                ? [
                    {
                      id: isPinned ? "unpin" : "pin",
                      label: isPinned ? "Unpin thread" : "Pin thread",
                      icon: isPinned ? "pin-off" : "pin",
                    },
                  ]
                : []),
              { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
              ...(supportsTitleRegeneration
                ? [
                    {
                      id: "regenerate-title",
                      label: isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
                      icon: "refresh-cw",
                      disabled: isRegeneratingTitle,
                    },
                  ]
                : []),
              { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
              // One "Copy" entry with a submenu, instead of four sibling rows
              // that each said "Copy ...".
              {
                id: "copy",
                label: "Copy",
                icon: "copy",
                separatorBefore: true,
                children: [
                  { id: "copy-path", label: "Path", icon: "folder" },
                  ...(thread.branch
                    ? [{ id: "copy-branch", label: "Branch", icon: "git-branch" }]
                    : []),
                  { id: "copy-handoff-script", label: "Handoff script", icon: "file-text" },
                  { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
                ],
              },
              // A running thread cannot be archived (the action would fail in
              // useThreadActions), so the entry is present but disabled rather
              // than silently missing.
              {
                id: "archive",
                label: "Archive",
                icon: "archive",
                disabled: isThreadRunning,
                separatorBefore: true,
              },
              { id: "delete", label: "Delete", destructive: true, icon: "trash" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset = snoozePresets.find(
            (candidate) => `snooze:${candidate.id}` === clicked.value,
          );
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        switch (clicked.value) {
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "pin":
          case "unpin":
            toggleThreadPin(threadRef);
            return;
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path":
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
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-handoff-script": {
            const loadingToastId = toastManager.add({
              type: "loading",
              title: "Generating handoff script…",
              description: thread.title,
              timeout: 0,
            });
            const result = await generateHandoffScript({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            });
            toastManager.close(loadingToastId);
            if (result._tag === "Failure") {
              if (!isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to generate handoff script",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
              return;
            }
            copyHandoffScriptToClipboard(result.value.script);
            return;
          }
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: didArchive
                    ? "Thread archived, but navigation failed"
                    : "Failed to archive thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure") {
              if (!isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to delete thread",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      attemptSettle,
      attemptSnooze,
      attemptUnsettle,
      attemptUnsnooze,
      confirmThreadArchive,
      confirmThreadDelete,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      pinnedThreadKeySet,
      projectCwdByKey,
      providerDriverKindByInstance,
      serverConfigs,
      startThreadRename,
      toggleThreadPin,
      updateThreadMetadata,
    ],
  );

  // Thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ]);

  // Same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  const attachListAutoAnimateRef = useCallback((node: HTMLUListElement | null) => {
    if (!node) {
      listAutoAnimateControllerRef.current = null;
      return;
    }
    listAutoAnimateControllerRef.current = autoAnimate(node, {
      duration: 150,
      easing: "ease-out",
    });
  }, []);

  // New thread defaults to the project you're in (active thread's project,
  // falling back to the top project) — same resolution the command palette
  // uses. The command palette already offers a "New thread in..." submenu
  // for multi-project setups.
  const handleNewThreadClick = useCallback(
    (event?: ReactMouseEvent) => {
      if (workspace === "work" || workspace === "chat") {
        if (!openWorkComposer()) {
          toastManager.add({
            type: "warning",
            title: "Hermes is not ready",
            description:
              "Enable and configure Hermes, then wait for T3 Work to finish preparing its private conversation directory.",
          });
        }
        return;
      }
      // One project: nothing to pick, create immediately. Shift+click creates
      // directly in the current project even with several projects, skipping
      // the palette picker.
      if (shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projectGroups.length)) {
        if (isMobile) setOpenMobile(false);
        void startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        });
        return;
      }
      if (isMobile) setOpenMobile(false);
      openCommandPalette({ open: "new-thread-in" });
    },
    [isMobile, newThreadContext, openWorkComposer, projectGroups.length, setOpenMobile, workspace],
  );

  // The button mirrors chat.new: in multi-project setups both route through
  // the command palette's "New thread in..." picker, and in single-project
  // setups both create immediately. In multi-project setups the label is only
  // the picker's shortcut: falling back to chat.newLocal would advertise the
  // same shortcut for both the picker and direct create. In single-project
  // setups both commands create directly, so chat.newLocal is a valid
  // fallback. The second tooltip line (multi-project only) advertises
  // shift+click and its keyboard twin chat.newLocal for direct create.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  return (
    <>
      <SidebarChromeHeader
        isElectron={isElectron}
        workspaceSelector={
          <SidebarWorkspaceSelector
            workspace={workspace}
            onWorkspaceChange={handleWorkspaceChange}
          />
        }
      />
      <SidebarContent
        className="gap-0"
        fixedHeader={
          <SidebarGroup className="gap-1 p-[var(--sidebar-content-inset)]">
            <div className="flex items-center gap-1">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
                <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                <Input
                  ref={threadSearchInputRef}
                  nativeInput
                  unstyled
                  type="search"
                  value={threadSearchQuery}
                  onChange={(event) => {
                    setThreadSearchQuery(event.currentTarget.value);
                    setActiveSearchResultIndex(0);
                  }}
                  onKeyDown={handleThreadSearchKeyDown}
                  placeholder="Search"
                  aria-label="Search threads"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={isSearchingThreads && threadSearchResults.length > 0}
                  aria-controls={
                    isSearchingThreads && threadSearchResults.length > 0
                      ? "sidebar-thread-search-results"
                      : undefined
                  }
                  aria-activedescendant={
                    isSearchingThreads && threadSearchResults[activeSearchResultIndex]
                      ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                      : undefined
                  }
                  className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
                />
                {isSearchingThreads ? (
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost"
                    className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
                    aria-label="Clear thread search"
                    onClick={() => {
                      clearThreadSearch();
                      threadSearchInputRef.current?.focus();
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
              {workspace === "work" || workspace === "chat" ? (
                <div className="shrink-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex">
                          <SidebarMenuButton
                            size="icon"
                            type="button"
                            className="relative focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                            onClick={() => setHermesImportOpen(true)}
                            disabled={hermesProviderEntry === null || hermesBackingProject === null}
                            aria-label="Import Hermes conversations"
                          >
                            <DownloadIcon />
                          </SidebarMenuButton>
                        </span>
                      }
                    />
                    <TooltipPopup side="right">Import Hermes conversations</TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
              <div className="shrink-0">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex">
                        <SidebarMenuButton
                          size="icon"
                          type="button"
                          className="relative focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                          onClick={handleNewThreadClick}
                          disabled={
                            workspace === "work" || workspace === "chat"
                              ? hermesProviderEntry === null || hermesBackingProject === null
                              : projects.length === 0
                          }
                          aria-label="New thread"
                        >
                          <SquarePenIcon />
                          <span
                            className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                            aria-hidden="true"
                          />
                        </SidebarMenuButton>
                      </span>
                    }
                  />
                  <TooltipPopup side="right">
                    {projectGroups.length > 1 ? (
                      <span className="flex flex-col gap-0.5">
                        <span>
                          {newThreadShortcutLabel
                            ? `New thread (${newThreadShortcutLabel})`
                            : "New thread"}
                        </span>
                        <span className="text-muted-foreground">
                          New thread in current project: Shift+click
                          {newThreadInProjectShortcutLabel
                            ? ` (${newThreadInProjectShortcutLabel})`
                            : ""}
                        </span>
                      </span>
                    ) : newThreadShortcutLabel ? (
                      `New thread (${newThreadShortcutLabel})`
                    ) : (
                      "New thread"
                    )}
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>
            {workspace === "code" && projectGroups.length > 0 ? (
              <div className="flex items-center gap-1">
                <Menu open={projectScopeMenuOpen} onOpenChange={setProjectScopeMenuOpen}>
                  <MenuTrigger
                    render={
                      <SidebarMenuButton
                        aria-label="Filter threads by project"
                        className="min-w-0 flex-1 ps-[calc(var(--sidebar-row-content-inset)-1px)] focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      />
                    }
                  >
                    {scopedProjectGroup ? (
                      <ProjectFavicon
                        environmentId={scopedProjectGroup.environmentId}
                        cwd={scopedProjectGroup.workspaceRoot}
                        faviconPath={scopedProjectGroup.faviconPath}
                        className="size-4 shrink-0"
                      />
                    ) : (
                      <FolderIcon className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {scopedProjectGroup?.displayName ?? "All projects"}
                    </span>
                    <ChevronDownIcon className="-mr-px size-4 shrink-0" />
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-(--anchor-width)">
                    <MenuRadioGroup
                      value={projectScopeKey ?? "all"}
                      onValueChange={(value) =>
                        setProjectScopeKey(value === "all" ? null : (value as string))
                      }
                    >
                      <MenuRadioItem
                        value="all"
                        closeOnClick
                        className="h-8 min-h-8 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                      >
                        <FolderIcon className="size-4 shrink-0" />
                        <span className="min-w-0 truncate text-sm">All projects</span>
                      </MenuRadioItem>
                      {projectGroups.map((project) => {
                        const scopeKey = project.projectKey;
                        return (
                          <MenuRadioItem
                            key={scopeKey}
                            value={scopeKey}
                            closeOnClick
                            className="h-8 min-h-8 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                          >
                            <ProjectFavicon
                              environmentId={project.environmentId}
                              cwd={project.workspaceRoot}
                              faviconPath={project.faviconPath}
                              className="size-4 shrink-0"
                            />
                            <span className="min-w-0 truncate text-sm">{project.displayName}</span>
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={`Project settings for ${project.displayName}`}
                              title={`Project settings for ${project.displayName}`}
                              className="ml-auto size-6 [--control-icon-color:currentColor] text-icon-muted focus-visible:bg-accent focus-visible:text-foreground"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                void handleProjectSettings(event, project);
                              }}
                            >
                              <SettingsIcon className="size-3.5" />
                            </Button>
                          </MenuRadioItem>
                        );
                      })}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        size="icon"
                        className="relative shrink-0 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                        onClick={openAddProjectCommandPalette}
                        type="button"
                        aria-label="New project"
                      />
                    }
                  >
                    <FolderPlusIcon />
                    <span
                      className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                      aria-hidden="true"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="right">New project</TooltipPopup>
                </Tooltip>
              </div>
            ) : null}
            {(workspace === "work" || workspace === "chat") && workEnvironmentOptions.length > 1 ? (
              <div className="flex items-center gap-1">
                <Menu>
                  <MenuTrigger
                    render={
                      <SidebarMenuButton
                        aria-label="Filter threads by environment"
                        className="min-w-0 flex-1 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                      />
                    }
                  >
                    <ServerIcon className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {(workEnvironmentScopeId !== null
                        ? environmentLabelById.get(workEnvironmentScopeId)
                        : null) ?? "Select environment"}
                    </span>
                    <ChevronDownIcon className="-mr-px size-4 shrink-0" />
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-(--anchor-width)">
                    <MenuRadioGroup
                      value={workEnvironmentScopeId ?? ""}
                      onValueChange={(value) =>
                        setStoredWorkEnvironmentScopeId(value as EnvironmentId)
                      }
                    >
                      {workEnvironmentOptions.map((environment) => (
                        <MenuRadioItem
                          key={environment.environmentId}
                          value={environment.environmentId}
                          closeOnClick
                          className="h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                        >
                          <ServerIcon className="size-4 shrink-0" />
                          <span className="min-w-0 truncate text-sm">{environment.label}</span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
              </div>
            ) : null}
          </SidebarGroup>
        }
      >
        <SidebarGroup className="ps-[calc(var(--sidebar-content-inset)+1px)] pe-[var(--sidebar-content-inset)] pb-1 pt-0">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarSearchResultRow
                        key={threadKey}
                        thread={thread}
                        projectCwd={
                          projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectFaviconPath={
                          projectFaviconPathByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        projectTitle={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeThreadKey === threadKey}
                        resultId={`sidebar-thread-search-result-${index}`}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                      />
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No threads found
              </p>
            )
          ) : null}
          {!isSearchingThreads ? (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <DndContext
                sensors={threadDragSensors}
                collisionDetection={threadCollisionDetection}
                modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                onDragStart={handleThreadDragStart}
                onDragEnd={handleThreadDragEnd}
                onDragCancel={handleThreadDragCancel}
              >
                <SortableContext items={sortableThreadKeys} strategy={verticalListSortingStrategy}>
                  <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">
                    {(() => {
                      const renderThreadRow = (
                        thread: EnvironmentThreadShell,
                        section: "active" | "snoozed" | "settled",
                      ) => {
                        const threadKey = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        // Settled and snoozed are the ONLY things that collapse a
                        // row: every other thread is a full card. Density comes
                        // from users (or the auto rules) actually parking work,
                        // not from the sidebar second-guessing what still matters.
                        const isCard = section === "active";
                        const rowVariant = isCard ? "card" : "slim";
                        // Keyed per variant on purpose: when a thread settles,
                        // the card fades out in place and the slim row fades
                        // in at its settled position instead of one element
                        // FLIP-sliding through every row in between (rows here
                        // are translucent, so a crossing row reads as text
                        // painted over text).
                        const rowKey = `${threadKey}:${rowVariant}`;
                        const rowProps: Omit<SidebarThreadRowProps, "sortable"> = {
                          thread,
                          variant: rowVariant,
                          // Snoozed rows wake; settled rows un-settle (explicit
                          // settles clear the override, auto-settled rows get
                          // pinned active); cards settle.
                          variantAction:
                            section === "snoozed"
                              ? "unsnooze"
                              : section === "settled"
                                ? "unsettle"
                                : "settle",
                          settlementSupported:
                            thread.workInboxRole !== "main" &&
                            serverConfigs.get(thread.environmentId)?.environment.capabilities
                              .threadSettlement === true,
                          snoozeSupported:
                            thread.workInboxRole !== "main" &&
                            serverConfigs.get(thread.environmentId)?.environment.capabilities
                              .threadSnooze === true,
                          snoozeWakeLabelText:
                            section === "snoozed" && thread.snoozedUntil != null
                              ? snoozeWakeLabel(thread.snoozedUntil, {
                                  now: new Date().toISOString(),
                                })
                              : null,
                          isPinned: pinnedThreadKeySet.has(threadKey),
                          canPin:
                            section === "active" &&
                            canPinWorkInboxThread({
                              thread,
                              providerDriverKindByInstance,
                              isSnoozed: false,
                              isSettled: false,
                            }),
                          // All sections: a woken thread can classify straight
                          // into the settled tail (PR merged while snoozed), and
                          // the wake signal must survive the trip. Still-snoozed
                          // rows resolve to null on their own.
                          wokeAt: threadWokeAt(thread, { now: snoozeNow }),
                          isActive: routeThreadKey === threadKey,
                          openPullRequestsInRightPanel: routeThreadRef !== null,
                          jumpLabel: showThreadJumpHints
                            ? (jumpLabelByKey.get(threadKey) ?? null)
                            : null,
                          currentEnvironmentId: primaryEnvironmentId,
                          environmentLabel: environmentLabelById.get(thread.environmentId) ?? null,
                          projectCwd:
                            projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                            null,
                          projectFaviconPath:
                            projectFaviconPathByKey.get(
                              `${thread.environmentId}:${thread.projectId}`,
                            ) ?? null,
                          projectTitle:
                            projectDisplayNameByKey.get(
                              `${thread.environmentId}:${thread.projectId}`,
                            ) ?? null,
                          providerEntryByInstanceId:
                            providerEntriesByEnvironment.get(thread.environmentId) ??
                            EMPTY_PROVIDER_ENTRIES,
                          onThreadClick: handleThreadClick,
                          onThreadActivate: navigateToThread,
                          onStartRename: startThreadRename,
                          onRenameTitleChange: setRenamingTitle,
                          onCommitRename: commitThreadRename,
                          onCancelRename: cancelThreadRename,
                          isRenaming: renamingThreadKey === threadKey,
                          renamingTitle: renamingThreadKey === threadKey ? renamingTitle : "",
                          onContextMenu: handleThreadContextMenu,
                          onSettle: attemptSettle,
                          onUnsettle: attemptUnsettle,
                          onSnooze: attemptSnooze,
                          onUnsnooze: attemptUnsnooze,
                          onTogglePin: toggleThreadPin,
                          changeRequestSnapshot: changeRequestSnapshotByKey.get(threadKey) ?? null,
                          onChangeRequestSnapshot: setThreadChangeRequestSnapshot,
                        };
                        // Only active cards are draggable: snoozed and settled
                        // rows sort by wake/settled time, so a manual position
                        // would be discarded on the next lifecycle transition.
                        return isCard ? (
                          <SortableSidebarThreadRow
                            key={rowKey}
                            sortableId={threadKey}
                            {...rowProps}
                          />
                        ) : (
                          <SidebarThreadRow key={rowKey} {...rowProps} />
                        );
                      };
                      const items: ReactNode[] = [
                        <SidebarDraftBlock
                          key="draft-sessions"
                          projectDisplayNameByKey={projectDisplayNameByKey}
                          projectCwdByKey={projectCwdByKey}
                          projectFaviconPathByKey={projectFaviconPathByKey}
                          scopedProjectKeys={scopedProjectKeys}
                          routeDraftId={routeDraftIdForRows}
                          onNavigateToDraft={navigateToDraft}
                        />,
                      ];
                      const addWorkSection = (
                        key: string,
                        label: string,
                        sectionThreads: readonly EnvironmentThreadShell[],
                        tone: "default" | "attention" = "default",
                      ) => {
                        if (sectionThreads.length === 0) return;
                        items.push(
                          <li
                            key={`${key}-header`}
                            data-thread-selection-safe
                            className="list-none"
                          >
                            <div className="mb-1 mt-3 flex items-center gap-2 px-2.5">
                              <span
                                className={cn(
                                  "text-xs font-medium",
                                  tone === "attention"
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-muted-foreground/65",
                                )}
                              >
                                {label}
                              </span>
                              <span
                                className={cn(
                                  "h-px flex-1",
                                  tone === "attention"
                                    ? "bg-amber-500/20 dark:bg-amber-400/15"
                                    : "bg-sidebar-border/60",
                                )}
                              />
                            </div>
                          </li>,
                        );
                        for (const thread of sectionThreads) {
                          items.push(renderThreadRow(thread, "active"));
                        }
                      };
                      if (workspace === "work") {
                        addWorkSection("main", "Main", mainThreads);
                        addWorkSection("needs-you", "Needs you", needsYouThreads, "attention");
                        addWorkSection("active", "Active", ordinaryActiveThreads);
                      } else {
                        for (const thread of activeThreads) {
                          items.push(renderThreadRow(thread, "active"));
                        }
                      }
                      // Snoozed shelf: between the inbox and Settled — out of the
                      // way, never gone. The header always renders while anything
                      // is snoozed (the count is the whole footprint when
                      // collapsed); rows only when expanded. Vanishes entirely at
                      // count 0.
                      if (snoozedThreads.length > 0) {
                        items.push(
                          <li
                            key="snoozed-shelf-header"
                            data-thread-selection-safe
                            className="list-none"
                          >
                            <button
                              type="button"
                              onClick={toggleSnoozedShelf}
                              aria-expanded={snoozedShelfExpanded}
                              data-testid="sidebar-v2-snoozed-shelf-toggle"
                              className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                            >
                              <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                                {snoozedShelfExpanded
                                  ? "Snoozed"
                                  : `Snoozed (${snoozedThreads.length})`}
                              </span>
                              <span className="h-px flex-1 bg-blue-500/20 dark:bg-blue-400/15" />
                              <ChevronDownIcon
                                aria-hidden
                                className={cn(
                                  "size-3 text-blue-600 transition-transform dark:text-blue-400",
                                  snoozedShelfExpanded && "rotate-180",
                                )}
                              />
                            </button>
                          </li>,
                        );
                        for (const thread of visibleSnoozedThreads) {
                          items.push(renderThreadRow(thread, "snoozed"));
                        }
                      }
                      if (settledThreads.length > 0) {
                        items.push(
                          <li
                            key="settled-shelf-header"
                            data-thread-selection-safe
                            className="list-none"
                          >
                            <button
                              type="button"
                              onClick={toggleSettledShelf}
                              aria-expanded={settledShelfExpanded}
                              data-testid="sidebar-v2-settled-shelf-toggle"
                              className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                            >
                              <span className="text-xs font-medium text-muted-foreground/50">
                                {settledShelfExpanded
                                  ? "Settled"
                                  : `Settled (${settledThreads.length})`}
                              </span>
                              <span className="h-px flex-1 bg-sidebar-border/60" />
                              <ChevronDownIcon
                                aria-hidden
                                className={cn(
                                  "size-3 text-muted-foreground/50 transition-transform",
                                  settledShelfExpanded && "rotate-180",
                                )}
                              />
                            </button>
                          </li>,
                        );
                      }
                      for (const thread of renderedSettledThreads) {
                        items.push(renderThreadRow(thread, "settled"));
                      }
                      return items;
                    })()}
                    {settledShelfExpanded && hiddenSettledCount > 0 ? (
                      <li className="list-none">
                        <button
                          type="button"
                          onClick={showMoreSettled}
                          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                        >
                          <PlusIcon aria-hidden className="size-4 shrink-0" />
                          Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </SortableContext>
              </DndContext>
            </TooltipProvider>
          ) : null}
          {!isSearchingThreads &&
          visibleDraftSessionCount === 0 &&
          activeThreads.length + snoozedThreads.length + settledThreads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroup ? (
                `No threads in ${scopedProjectGroup.displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <HermesImportOnboarding
        environmentId={hermesBackingProject?.environmentId ?? null}
        providerInstanceId={hermesProviderEntry?.instanceId ?? null}
        backingProjectId={hermesBackingProject?.id ?? null}
        autoOpenEnabled={workspace === "work"}
        open={hermesImportOpen}
        onOpenChange={setHermesImportOpen}
      />
      <SidebarChromeFooter />
    </>
  );
}
