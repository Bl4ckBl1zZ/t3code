import { usePanelAnimationSettings } from "../panelAnimations";
import { cn } from "~/lib/utils";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CloudIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  MonitorIcon,
  ScaleIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useProject, useThreadShell, useThreadShellsForProjectRefs } from "../state/entities";
import { useIsMobile } from "../hooks/useMediaQuery";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import { ComposerControl } from "./chat/ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";
import { MiddleTruncate } from "./ui/middle-truncate";
import { ComposerSurface } from "./chat/ComposerSurface";

interface BranchToolbarProps {
  composerControlsHostRef?: ((element: HTMLDivElement | null) => void) | undefined;
  composerControlsVisible?: boolean;
  layout?: "composer" | "panel";
  panelSection?: "all" | "workspace" | "branch";
  environmentId: EnvironmentId;
  threadId: ThreadId;
  showGitControls: boolean;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  /** The thread's env mode as ChatView resolves it. */
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

interface MobileRunContextSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  previousWorktreeBranch: string | null;
  onUsePreviousWorktree: () => void;
}

const MobileRunContextSelector = memo(function MobileRunContextSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch,
  onUsePreviousWorktree,
}: MobileRunContextSelectorProps) {
  const activeEnvironment = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = envModeLocked
    ? resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)
    : effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isLocked = envLocked || envModeLocked;
  const EnvironmentIcon = activeEnvironment?.isPrimary ? MonitorIcon : CloudIcon;
  const icon = showEnvironmentIndicator ? (
    // Button's base styles apply `-mx-0.5` to descendant SVGs, which eats 4px
    // out of whatever gap we set. mx-0! cancels that so gap-0.5 reads as 2px.
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {autoEnvironmentLabel ? (
        <ScaleIcon className="size-3 shrink-0 mx-0!" />
      ) : (
        <EnvironmentIcon className="size-3 shrink-0 mx-0!" />
      )}
      <WorkspaceIcon className="size-3 shrink-0 mx-0!" />
    </span>
  ) : (
    <WorkspaceIcon className="size-3 shrink-0" />
  );
  const triggerContent = (
    <>
      {icon}
      <span className="min-w-0 truncate">
        {autoEnvironmentLabel ??
          (showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel)}
      </span>
    </>
  );

  if (isLocked) {
    return (
      <span className="inline-flex h-7 min-w-0 max-w-[48%] flex-1 items-center justify-start gap-1 rounded-md border border-transparent px-1.75 text-sm font-medium text-muted-foreground/70 sm:h-6 md:hidden">
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<ComposerControl size="xs" />}
        className="min-w-0 max-w-[48%] flex-1 justify-start md:hidden"
      >
        {triggerContent}
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        side="top"
        className={previousWorktreeLabel ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
      >
        {showEnvironmentPicker && availableEnvironments && onEnvironmentChange ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={autoEnvironmentLabel ? "auto" : environmentId}
                onValueChange={(value) =>
                  value === "auto"
                    ? onAutoEnvironment?.()
                    : onEnvironmentChange(value as EnvironmentId)
                }
              >
                {onAutoEnvironment ? (
                  <MenuRadioItem
                    value="auto"
                    disabled={envLocked}
                    closeOnClick
                    onClick={() => {
                      if (autoEnvironmentLabel) onAutoEnvironment();
                    }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <ScaleIcon className="size-3" />
                      {autoEnvironmentLabel ?? "Auto balance"}
                    </span>
                  </MenuRadioItem>
                ) : null}
                {availableEnvironments.map((env) => {
                  const Icon = env.isPrimary ? MonitorIcon : CloudIcon;
                  return (
                    <MenuRadioItem
                      key={env.environmentId}
                      disabled={envLocked}
                      value={env.environmentId}
                      closeOnClick
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-3" />
                        <span className="min-w-0 truncate">{env.label}</span>
                      </span>
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked} value="local" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <MiddleTruncate value={resolveCurrentWorkspaceLabel(activeWorktreePath)} />
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree" closeOnClick>
                <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

const COMPOSER_CONTEXT_MOTION_DURATION_MS = 180;
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_CONTEXT_LABEL_SELECTOR = "[data-composer-label]";

/**
 * The width a label takes when shown, clipped parts included.
 *
 * Text keeps its full width when its box clips it, so each text run measures
 * whole. A label can hold more than one run (MiddleTruncate splits a branch
 * into a head and a tail), so the runs are added. Reading one element's
 * scrollWidth drops the tail when the label is hidden or squeezed, and the
 * strip then flips between labels and icons on every measure.
 *
 * A shown label never grows past its motion span's max width, so longer text
 * reserves only that much.
 */
function labelTextWidth(label: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    width += range.getBoundingClientRect().width;
  }
  const motion = label.querySelector<HTMLElement>("[data-composer-label-motion]");
  const maxWidth = motion ? Number.parseFloat(getComputedStyle(motion).maxWidth) : Number.NaN;
  return Number.isFinite(maxWidth) ? Math.min(width, maxWidth) : width;
}

/**
 * Collapse the strip's labels to icons only when the text no longer fits.
 *
 * Hidden labels stay measurable because their inner text keeps its natural
 * width while the outer layout box collapses. This lets every pass recompute
 * the expanded width without remembered values that could go stale or latch
 * the strip compact. A small hysteresis keeps the boundary from flapping.
 */
const COMPACT_EXPAND_HYSTERESIS_PX = 16;

function useLabelsOverflow(element: HTMLDivElement | null): boolean {
  const motion = usePanelAnimationSettings();
  const [overflows, setOverflows] = useState(false);
  const pendingLabelRectsRef = useRef<Map<HTMLElement, DOMRect> | null>(null);
  const labelAnimationsRef = useRef(new Map<HTMLElement, Animation>());
  // A render-synced mirror instead of useEffectEvent: the compiler memoizes
  // the event callback, which left observers reading the first render's null
  // element forever.
  const stateRef = useRef({ element, overflows });
  stateRef.current = { element, overflows };

  const measure = useCallback(() => {
    const { element: current, overflows: compact } = stateRef.current;
    if (!current) return;
    const available = current.clientWidth;
    if (available === 0) return;
    // flex-1 stretches the groups to fill the strip, so their own boxes always
    // measure "full". Sum the laid-out content instead, skipping hidden form
    // artifacts and other out-of-flow nodes.
    const contentWidth = (parent: Element): number => {
      const gap = Number.parseFloat(getComputedStyle(parent).columnGap) || 0;
      let width = 0;
      let counted = 0;
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.offsetWidth <= 1) continue;
        const position = getComputedStyle(child).position;
        if (position === "absolute" || position === "fixed") continue;
        width += child.offsetWidth;
        counted += 1;
      }
      return width + gap * Math.max(0, counted - 1);
    };
    const stripGap = Number.parseFloat(getComputedStyle(current).columnGap) || 0;
    let needed = 0;
    let groups = 0;
    for (const child of current.children) {
      if (!(child instanceof HTMLElement)) continue;
      const width = contentWidth(child);
      if (width <= 1) continue;
      needed += width;
      groups += 1;
    }
    needed += stripGap * Math.max(0, groups - 1);
    const range = document.createRange();
    for (const label of current.querySelectorAll<HTMLElement>("[data-composer-label]")) {
      // Subtract the visible width even during an animation. The content
      // sum already includes it; only the hidden text needs reserving.
      needed += Math.max(0, labelTextWidth(label, range) - label.getBoundingClientRect().width);
    }
    const nextOverflows = compact
      ? needed > available - COMPACT_EXPAND_HYSTERESIS_PX
      : needed > available;
    if (nextOverflows !== compact) {
      pendingLabelRectsRef.current = new Map(
        Array.from(current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_LABEL_SELECTOR)).map(
          (control) => [control, control.getBoundingClientRect()],
        ),
      );
    }
    setOverflows(nextOverflows);
  }, []);

  useLayoutEffect(() => {
    const previousRects = pendingLabelRectsRef.current;
    if (!previousRects) return;
    pendingLabelRectsRef.current = null;

    for (const animation of labelAnimationsRef.current.values()) {
      animation.cancel();
    }
    labelAnimationsRef.current.clear();

    if (!motion.active || document.visibilityState === "hidden") return;

    for (const [label, previousRect] of previousRects) {
      if (!label.isConnected) continue;
      const nextWidth = label.getBoundingClientRect().width;
      if (Math.abs(previousRect.width - nextWidth) < 0.5) continue;

      // Animate the space occupied by each label so flex layout keeps the
      // trailing controls anchored. Translating the whole group after its
      // width snaps sends expanded text beyond the strip's right edge.
      const animation = label.animate(
        [
          { width: `${previousRect.width}px`, maxWidth: `${previousRect.width}px` },
          { width: `${nextWidth}px`, maxWidth: `${nextWidth}px` },
        ],
        {
          duration: COMPOSER_CONTEXT_MOTION_DURATION_MS,
          easing: COMPOSER_CONTEXT_MOTION_EASING,
          fill: "backwards",
        },
      );
      labelAnimationsRef.current.set(label, animation);
      animation.addEventListener(
        "finish",
        () => {
          if (labelAnimationsRef.current.get(label) === animation) {
            labelAnimationsRef.current.delete(label);
          }
        },
        { once: true },
      );
    }
  }, [overflows, motion.active]);

  useEffect(
    () => () => {
      for (const animation of labelAnimationsRef.current.values()) {
        animation.cancel();
      }
    },
    [],
  );

  // Label widths can change without the strip box moving (font family or
  // size preferences), so re-measure on every render as well as on resize
  // and font loads.
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [element, measure]);

  return overflows;
}

export const BranchToolbar = memo(function BranchToolbar({
  layout = "composer",
  panelSection = "all",
  environmentId,
  threadId,
  showGitControls,
  draftId,
  onEnvModeChange,
  envMode,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  composerControlsHostRef,
  composerControlsVisible = false,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThread = useThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const hasActiveThread = serverThread !== null || draftThread !== null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveEnvMode = envMode;
  const envModeLocked = envLocked || (serverThread !== null && activeWorktreePath !== null);

  // "Previous worktree" hops a draft into the most recently active worktree
  // of this project — the "keep going where I just was" follow-up flow. Only
  // drafts can hop; started server threads have their workspace pinned.
  const canUsePreviousWorktree = draftThread !== null && serverThread === null && !envModeLocked;
  const projectRefsForWorktreeLookup = useMemo(
    () => (canUsePreviousWorktree && activeProjectRef ? [activeProjectRef] : []),
    [canUsePreviousWorktree, activeProjectRef],
  );
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = useMemo(
    () =>
      canUsePreviousWorktree
        ? resolvePreviousWorktreeSeed({
            threads: projectThreads,
            currentWorktreePath: activeWorktreePath,
          })
        : null,
    [activeWorktreePath, canUsePreviousWorktree, projectThreads],
  );
  const previousWorktreeLabel = previousWorktreeSeed
    ? resolvePreviousWorktreeLabel(previousWorktreeSeed)
    : null;
  const onUsePreviousWorktree = useCallback(() => {
    if (!previousWorktreeSeed || !activeProjectRef) return;
    // Same shape the branch selector writes when picking a branch that
    // already lives in a worktree: point the draft at the existing tree.
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  }, [activeProjectRef, draftId, previousWorktreeSeed, setDraftThreadContext, threadRef]);

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: showEnvironmentPicker,
  });
  const isMobile = useIsMobile();
  const [stripElement, setStripElement] = useState<HTMLDivElement | null>(null);
  const labelsOverflow = useLabelsOverflow(stripElement);

  if (!hasActiveThread || !activeProject) return null;

  if (layout === "panel") {
    return (
      <div className="flex w-full flex-col" data-thread-panel-run-context>
        {panelSection !== "branch" ? (
          <BranchToolbarEnvModeSelector
            displayMode="panel"
            envLocked={envModeLocked}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            workspaceRoot={activeProject.workspaceRoot}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel={previousWorktreeLabel}
            previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
            onUsePreviousWorktree={onUsePreviousWorktree}
          />
        ) : null}
        {panelSection !== "workspace" ? (
          <BranchToolbarBranchSelector
            displayMode="panel"
            className="w-full"
            environmentId={environmentId}
            threadId={threadId}
            {...(draftId ? { draftId } : {})}
            envLocked={envLocked}
            effectiveEnvModeOverride={effectiveEnvMode}
            {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
            {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
            startFromOrigin={startFromOrigin}
            onStartFromOriginChange={onStartFromOriginChange}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
          />
        ) : null}
      </div>
    );
  }

  return (
    <ComposerSurface.ContextStrip
      ref={setStripElement}
      data-compact={labelsOverflow ? "" : undefined}
    >
      {isMobile && showGitControls ? (
        <MobileRunContextSelector
          autoEnvironmentLabel={autoEnvironmentLabel}
          onAutoEnvironment={onAutoEnvironment}
          envLocked={envLocked}
          envModeLocked={envModeLocked}
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          showEnvironmentPicker={showEnvironmentPicker}
          showEnvironmentIndicator={showEnvironmentIndicator}
          onEnvironmentChange={onEnvironmentChange}
          effectiveEnvMode={effectiveEnvMode}
          activeWorktreePath={activeWorktreePath}
          onEnvModeChange={onEnvModeChange}
          previousWorktreeLabel={previousWorktreeLabel}
          previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
          onUsePreviousWorktree={onUsePreviousWorktree}
        />
      ) : (
        <div
          className={cn(
            "flex min-w-10 items-center gap-1",
            composerControlsVisible ? "shrink" : "flex-1",
          )}
        >
          {showEnvironmentIndicator && availableEnvironments && (
            <>
              <BranchToolbarEnvironmentSelector
                autoEnvironmentLabel={autoEnvironmentLabel}
                onAutoEnvironment={onAutoEnvironment}
                envLocked={envLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments}
                {...(showEnvironmentPicker && onEnvironmentChange ? { onEnvironmentChange } : {})}
              />
              {showGitControls ? (
                <Separator
                  orientation="vertical"
                  className="mx-0.5 h-3.5!"
                  data-composer-context-control
                />
              ) : null}
            </>
          )}
          {showGitControls ? (
            <BranchToolbarEnvModeSelector
              envLocked={envModeLocked}
              effectiveEnvMode={effectiveEnvMode}
              activeWorktreePath={activeWorktreePath}
              onEnvModeChange={onEnvModeChange}
              previousWorktreeLabel={previousWorktreeLabel}
              previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
              onUsePreviousWorktree={onUsePreviousWorktree}
            />
          ) : null}
        </div>
      )}

      {composerControlsHostRef ? (
        <div
          ref={composerControlsHostRef}
          data-chat-resting-composer-controls-host="true"
          data-composer-context-control
          className={cn(
            "min-w-0 flex-1 items-center overflow-x-hidden",
            composerControlsVisible ? "flex" : "hidden",
          )}
        />
      ) : null}

      {showGitControls ? (
        <BranchToolbarBranchSelector
          className="min-w-0 flex-1 justify-end md:ml-auto md:flex-initial"
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          envLocked={envLocked}
          effectiveEnvModeOverride={effectiveEnvMode}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={onStartFromOriginChange}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : null}
    </ComposerSurface.ContextStrip>
  );
});
