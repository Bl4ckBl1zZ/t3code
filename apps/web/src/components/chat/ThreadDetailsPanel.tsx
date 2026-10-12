import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { AlertTriangleIcon } from "lucide-react";

import type { OpenPreviewMutation } from "../../browser/openFileInPreview";
import type { DraftId } from "../../composerDraftStore";
import {
  useT3ProjectFilePreviewUrl,
  useT3ProjectFileScripts,
} from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import type { ComponentProps } from "react";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useProjectScriptRunStates } from "../../state/projectScriptRuns";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import type { ThreadDetailsCardDensity } from "./threadDetailsCardLayout";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadBackgroundTasksPanel } from "./ThreadBackgroundTasksPanel";
import { ThreadPortsPanel } from "./ThreadPortsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

export interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle" | "onPresentationChange"
> {
  environmentId: EnvironmentId;
  environmentConnection: EnvironmentConnectionPresentation | null;
  threadId: ThreadId;
  draftId?: DraftId;
  /**
   * Whether a real thread backs this route. Not the inverse of `draftId`: a
   * draft that has been sent keeps its draft id and its `/draft/…` route for the
   * rest of the session while a live thread runs underneath it, so sections that
   * report what the thread is *doing* have to key off this instead.
   */
  isServerThread: boolean;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  /** The thread's env mode as ChatView resolves it. */
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  /**
   * Opens the thread's own change request beside it. Absent when the thread has no project to
   * place it against, in which case it still opens in the browser.
   */
  onOpenPullRequest?: ((number: number) => void) | undefined;
  onReconnectEnvironment: () => void;
  onOpenConnectionSettings: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  /** Opens a preview tab; absent for surfaces that have no browser to open into. */
  openPreview?: OpenPreviewMutation<unknown>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      onPresentationChange={props.onPresentationChange}
    >
      {(density) => <ThreadDetailsContent {...props} density={density} />}
    </ThreadDetailsCard>
  );
}

/**
 * The card's sections. A separate component so its subscriptions (scripts,
 * terminal sessions, ports) only run while the card is actually shown.
 */
function ThreadDetailsContent(
  props: Omit<ThreadDetailsPanelProps, "anchor" | "handle" | "onPresentationChange"> & {
    readonly density: ThreadDetailsCardDensity;
  },
) {
  const { density } = props;
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  // Not gated on `activeProjectScripts`: the pinned preview URL is independent
  // of whether this surface offers the scripts menu at all.
  const pinnedPreviewUrl = useT3ProjectFilePreviewUrl(props.environmentId, props.gitCwd);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  // Single-run scripts render as stop buttons while their run is live, so the
  // control needs the thread's terminal sessions to know what is running.
  const scriptRunStates = useProjectScriptRunStates({
    environmentId: props.environmentId,
    threadId: props.threadId,
    scripts: props.activeProjectScripts,
    sessions: knownTerminalSessions,
  });
  const connectionIssue =
    props.environmentConnection !== null &&
    props.environmentConnection.phase !== "connected" &&
    props.environmentConnection.phase !== "available";
  const isReconnecting =
    props.environmentConnection?.phase === "connecting" ||
    props.environmentConnection?.phase === "reconnecting";
  const branchToolbarProps = {
    environmentId: props.environmentId,
    threadId: props.threadId,
    showGitControls: props.isGitRepo,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    autoEnvironmentLabel: props.autoEnvironmentLabel,
    onAutoEnvironment: props.onAutoEnvironment,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <>
      {/* The rows name themselves; the card carries no section labels. */}
      <section aria-label="Workspace">
        <div className="h-2" aria-hidden />

        {connectionIssue ? (
          <div className="mx-3 mb-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
            <div className="flex gap-2">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">Environment unavailable</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {props.environmentConnection?.error ??
                    "Reconnect this environment before sending messages or running actions."}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <Button
                    size="xs"
                    disabled={isReconnecting}
                    onClick={props.onReconnectEnvironment}
                  >
                    {isReconnecting ? "Reconnecting..." : "Reconnect"}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={props.onOpenConnectionSettings}>
                    Connections
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col px-2 pb-2.5">
          {/* One row names the machine and workspace; a lone remote machine
              still shows, as a static label when there is nothing to pick. */}
          {density === "full" ? (
            <BranchToolbar
              layout="panel"
              panelSection="workspace"
              availableEnvironments={props.availableEnvironments}
              onEnvironmentChange={props.onEnvironmentChange}
              {...branchToolbarProps}
            />
          ) : null}

          {density !== "essential" && props.showOpenInPicker ? (
            <OpenInPicker
              environmentId={props.environmentId}
              keybindings={props.keybindings}
              availableEditors={props.availableEditors}
              openInCwd={props.gitCwd}
              displayMode="panel"
            />
          ) : null}

          {props.activeProjectScripts ? (
            <ProjectScriptsControl
              displayMode="panel"
              scripts={props.activeProjectScripts}
              fileScripts={fileScripts}
              keybindings={props.keybindings}
              preferredScriptId={props.preferredScriptId}
              scriptRunStates={scriptRunStates}
              onRunScript={props.onRunProjectScript}
              onAddScript={props.onAddProjectScript}
              onUpdateScript={props.onUpdateProjectScript}
              onDeleteScript={props.onDeleteProjectScript}
            />
          ) : null}
        </div>
      </section>

      {/* What the thread is running right now. Folded away before version
          control when space runs short; the pills above the composer
          still say it. */}
      {density === "full" && !props.draftId && props.openPreview ? (
        <ThreadPortsPanel
          environmentId={props.environmentId}
          threadId={props.threadId}
          threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
          scripts={props.activeProjectScripts}
          pinnedPreviewUrl={pinnedPreviewUrl}
          openPreview={props.openPreview}
        />
      ) : null}

      {/* Sits with Ports rather than lower down: both answer "what is this
          thread running right now", and both disappear when the answer is
          nothing. */}
      {density === "full" && props.isServerThread ? (
        <ThreadBackgroundTasksPanel environmentId={props.environmentId} threadId={props.threadId} />
      ) : null}

      {props.gitCwd ? (
        <section
          aria-label="Version Control"
          className={density === "full" ? "border-t border-border/65 pt-2" : undefined}
        >
          <div className="flex flex-col px-2 pb-2.5">
            {props.isGitRepo ? (
              <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
            ) : null}
            {props.activeProjectName ? (
              <GitActionsControl
                displayMode="panel"
                compact={density !== "full"}
                gitCwd={props.gitCwd}
                activeThreadRef={{
                  environmentId: props.environmentId,
                  threadId: props.threadId,
                }}
                {...(props.draftId ? { draftId: props.draftId } : {})}
                {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                onOpenPullRequest={props.onOpenPullRequest}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Local drafts have no task binding. */}
      {density === "full" && props.isServerThread ? (
        <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
      ) : null}

      {/* Keyed off `isServerThread`, not `draftId`: a sent draft keeps its
          draft route for the rest of the session while real work runs under it. */}
      {density === "full" && props.isServerThread ? (
        <ThreadRelationshipsPanel environmentId={props.environmentId} threadId={props.threadId} />
      ) : null}
    </>
  );
}
