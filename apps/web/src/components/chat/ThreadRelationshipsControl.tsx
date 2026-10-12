import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  orderWebThreadLineageRows,
  resolveMergeBackTargetThreadId,
  liveThreadRunStatus,
  threadRelationshipRowStatus,
  type ThreadRelationshipEdge,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  canDetachThreadProviderSession,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { workflowPhaseProgress } from "@t3tools/shared/workflowObservability";
import * as DateTime from "effect/DateTime";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CornerLeftUpIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  GitForkIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  SquareIcon,
  UnplugIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { AgentOrb } from "./AgentOrb";
import { AgentElapsed, hasAgentElapsed, type AgentElapsedTiming } from "./AgentElapsed";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { shouldShowInstanceBadge } from "../../providerInstances";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { resolveSubagentModelTraits, resolveThreadModelBadge } from "./threadModelBadge";
import { WorkflowScriptDialog } from "../WorkflowScriptDialog";
import { ThreadLineageWorkflowRow } from "./ThreadLineageWorkflowRow";
import { deriveWorkflowGroup, type WorkflowGroup } from "./ThreadLineageWorkflowRow.logic";
import { relationshipOrbState, relationshipStatusLabel } from "./threadRelationshipStatus";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { readLocalApi } from "../../localApi";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useProjects, useThreadProjection, useThreadShells } from "../../state/entities";
import { useProviderEntryByInstanceId } from "../../state/providerEntries";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_MENU_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const THREAD_RELATIONSHIP_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId) {
  if (edge.kind === "transfer") return "Context transfer";
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Parent thread";
}

function statusDotClass(status: string | null): string {
  if (status === "running" || status === "in_progress") return "bg-info";
  if (status === "failed" || status === "error") return "bg-destructive";
  if (status === "completed") return "bg-success";
  return "bg-muted-foreground/45";
}

function subagentTiming(subagent: OrchestrationV2Subagent): AgentElapsedTiming {
  return {
    status: subagent.status,
    startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
    completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
  };
}

/**
 * The row's timer and hover card follow current child work, including queued
 * follow-ups whose provider turn has not started yet.
 */
function currentSubagent(
  subagent: OrchestrationV2Subagent | undefined,
  childThread: OrchestrationV2ThreadShell | null | undefined,
): OrchestrationV2Subagent | undefined {
  if (!subagent || !childThread) return subagent;
  const liveStatus =
    liveThreadRunStatus(childThread) ?? (childThread.status === "queued" ? "queued" : null);
  const newerRun =
    childThread.latestRunRequestedAt != null &&
    DateTime.toEpochMillis(childThread.latestRunRequestedAt) >
      DateTime.toEpochMillis(subagent.completedAt ?? subagent.startedAt ?? subagent.updatedAt);
  if (!liveStatus && !newerRun) return subagent;
  const status = liveStatus ?? childThread.status;
  return {
    ...subagent,
    status:
      status === "preparing" || status === "starting" || status === "queued" || status === "idle"
        ? "pending"
        : status === "rolled_back"
          ? "interrupted"
          : status,
    startedAt: liveStatus
      ? (childThread.activityRunStartedAt ?? null)
      : (childThread.latestRunStartedAt ?? null),
    completedAt: liveStatus ? null : (childThread.latestRunCompletedAt ?? null),
    // The task's output belongs to its recorded run, not newer child work.
    progress: undefined,
    result: null,
  };
}

const STOPPABLE_SUBAGENT_STATUSES: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "pending",
  "running",
  "waiting",
]);

/**
 * A T3-owned subagent with a started run has a child turn that Stop can
 * interrupt. A Claude-native one is stopped through its owning run while its
 * recorded task is still live; a workflow member has no run of its own, so
 * only the workflow's Stop reaches it.
 */
function canStopSubagent(
  subagent: OrchestrationV2Subagent | undefined,
  recorded: OrchestrationV2Subagent | undefined,
): boolean {
  if (subagent === undefined || recorded === undefined) return false;
  const stoppableOrigin =
    subagent.origin === "app_owned" ||
    (subagent.origin === "provider_native" &&
      subagent.driver === "claudeAgent" &&
      recorded.runId !== null &&
      subagent.nativeTaskRef?.strength === "strong" &&
      subagent.nativeTaskRef.nativeId !== null &&
      STOPPABLE_SUBAGENT_STATUSES.has(recorded.status));
  return (
    stoppableOrigin &&
    subagent.startedAt !== null &&
    STOPPABLE_SUBAGENT_STATUSES.has(subagent.status)
  );
}

function relationshipThreadTitle(input: {
  readonly title: string;
  readonly isSubagent: boolean;
}): string {
  if (!input.isSubagent) return input.title;
  return input.title.replace(/^Subagent:\s*/i, "");
}

export function ThreadRelationshipsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /**
   * Rendered instead of nothing when the thread has no relationships yet. Only
   * surfaces where this section is the panel's whole content pass one — a
   * coding thread still has a workspace to show, so a placeholder there would
   * be noise.
   */
  readonly emptyFallback?: ReactNode;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const threadShells = useThreadShells();
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const activeShells = threadShells.filter(
    (thread) => thread.environmentId === props.environmentId,
  );
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedShells = archived.snapshots.find(
    (entry) => entry.environmentId === props.environmentId,
  )?.snapshot.threads;
  const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
    ...activeShells.map((thread) => thread.source),
    ...(archivedShells ?? []),
  ];
  const graph = deriveThreadRelationshipGraph({ threads: shells, projection });
  const providerEntryByInstanceId = useProviderEntryByInstanceId();
  const navigate = useNavigate();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const stopWorkflowCommand = useAtomCommand(orchestrationEnvironment.v2.stopWorkflow);
  const canOperateWorkflow = useAtomValue(
    orchestrationEnvironment.v2.stopWorkflow.permissionAtom(props.environmentId),
  );
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const [stoppingThreadId, setStoppingThreadId] = useState<ThreadId | null>(null);
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  // A workflow coordinator that reported its roster unfolds into the phases and
  // members it ran, keyed by the child thread its row points at.
  const workflowsByChildThreadId = useMemo(() => {
    const workflows = new Map<
      ThreadId,
      { readonly coordinator: OrchestrationV2Subagent; readonly group: WorkflowGroup }
    >();
    for (const coordinator of projection?.subagents ?? []) {
      if (coordinator.childThreadId === null) continue;
      const group = deriveWorkflowGroup(coordinator);
      if (group !== null) workflows.set(coordinator.childThreadId, { coordinator, group });
    }
    return workflows;
  }, [projection?.subagents]);
  const relationshipRows = orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, props.threadId),
    currentThreadId: props.threadId,
    mergeTargetThreadId,
  }).map((row) => {
    // A workflow's row follows the run, not its coordinator chat, which can sit
    // idle while members still work.
    const workflow =
      row.edge.kind === "subagent" && !isParentThreadRelationship(row.edge, props.threadId)
        ? workflowsByChildThreadId.get(row.threadId)
        : undefined;
    return workflow === undefined
      ? row
      : { ...row, edge: { ...row.edge, status: workflow.coordinator.status } };
  });
  const canMerge = mergeTargetThreadId !== null && latestMergeBackRun !== null;
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;
  const [subagentsExpanded, setSubagentsExpanded] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [scriptPath, setScriptPath] = useState<string | null>(null);
  // Workflow progress, usage and run handles live on the parent's projected
  // subagent, keyed by the child thread the lineage row points at.
  const subagentByChildThreadId = new Map<ThreadId, OrchestrationV2Subagent>();
  for (const subagent of projection?.subagents ?? []) {
    if (subagent.childThreadId !== null) {
      subagentByChildThreadId.set(subagent.childThreadId, subagent);
    }
  }

  if (relationshipRows.length === 0) {
    return props.emptyFallback ?? null;
  }

  const isSubagentChildRow = ({ edge }: (typeof relationshipRows)[number]) =>
    edge.kind === "subagent" && edge.sourceThreadId === props.threadId;
  const lineageRows = relationshipRows.filter((row) => !isSubagentChildRow(row));
  const subagentRows = relationshipRows.filter(isSubagentChildRow);
  const doneSubagentRows = subagentRows.filter((row) => row.edge.status === "completed");
  const failedSubagentRows = subagentRows.filter(
    (row) => row.edge.status === "failed" || row.edge.status === "error",
  );
  const workingSubagentRows = subagentRows.filter(
    (row) => !doneSubagentRows.includes(row) && !failedSubagentRows.includes(row),
  );
  const activeSubagentRows = [...workingSubagentRows, ...failedSubagentRows];

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  const merge = async () => {
    if (!latestMergeBackRun || mergeTargetThreadId === null || busyAction !== null) return;
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: mergeTargetThreadId,
        runId: latestMergeBackRun.id,
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") openThread(mergeTargetThreadId);
  };

  const detach = async () => {
    if (!canDetach || busyAction !== null) return;
    setBusyAction("detach");
    await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setBusyAction(null);
  };

  // Stop in the child thread: interrupts its live run and the work it delegated.
  // A provider-native subagent stops through its owner, whose run keeps working.
  const stopSubagent = async (
    childThreadId: ThreadId,
    subagent: Pick<OrchestrationV2Subagent, "id" | "origin" | "threadId"> | undefined,
  ) => {
    if (stoppingThreadId !== null) return;
    setStoppingThreadId(childThreadId);
    const result = await interruptTurn({
      environmentId: props.environmentId,
      input:
        subagent?.origin === "provider_native"
          ? { threadId: subagent.threadId, subagentId: subagent.id }
          : { threadId: childThreadId },
    });
    setStoppingThreadId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop subagent" });
    }
  };

  // Stops the whole run: the coordinator and every member it still has going.
  const stopWorkflow = async (childThreadId: ThreadId, coordinator: OrchestrationV2Subagent) => {
    if (stoppingThreadId !== null) return;
    setStoppingThreadId(childThreadId);
    const result = await stopWorkflowCommand({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, subagentId: coordinator.id },
    });
    setStoppingThreadId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop workflow" });
    }
  };

  const parentTitle =
    mergeTargetThreadId === null
      ? null
      : (graph.nodes.get(mergeTargetThreadId)?.thread?.title ?? null);

  return (
    <section
      aria-labelledby="thread-details-lineage-heading"
      className="border-t border-border/65 px-2 pb-2.5 pt-2"
      data-thread-relationships-panel
    >
      <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-2">
        <h3
          id="thread-details-lineage-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          {lineageRows.length > 0 ? "Lineage" : "Subagents"}
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {canDetach ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_ICON_ACTION_CLASS}
                    aria-label="More thread actions"
                    disabled={busyAction !== null}
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end" className={THREAD_DETAILS_PANEL_MENU_POPUP_CLASS}>
                <MenuItem onClick={() => void detach()}>
                  <UnplugIcon className="size-3.5" />
                  Disconnect agent session
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>

      {(() => {
        const renderRelationshipRow = ({ threadId, edge }: (typeof relationshipRows)[number]) => {
          const node = graph.nodes.get(threadId);
          const isSubagent = edge.kind === "subagent";
          const isMergeTarget = threadId === mergeTargetThreadId;
          const isParent = isParentThreadRelationship(edge, props.threadId);
          const status = threadRelationshipRowStatus(graph, { threadId, edge });
          const showOrb = isSubagent && !isParent;
          const RelationshipIcon = isParent ? CornerLeftUpIcon : GitForkIcon;
          const relationship = relationshipLabel(edge, props.threadId);
          const recordedSubagent = showOrb ? subagentByChildThreadId.get(threadId) : undefined;
          const workflow = showOrb ? workflowsByChildThreadId.get(threadId) : undefined;
          const threadTitle = relationshipThreadTitle({
            // A workflow's name is shorter than its coordinator chat's title.
            title: recordedSubagent?.workflow?.name ?? node?.thread?.title ?? threadId,
            isSubagent,
          });
          // A workflow row follows the run, not newer work in its coordinator chat.
          const subagent = workflow
            ? recordedSubagent
            : currentSubagent(recordedSubagent, node?.thread);
          const phase = workflowPhaseProgress(subagent?.workflow);
          const runScriptPath = subagent?.runHandles?.scriptPath;
          const runSessionUrl = subagent?.runHandles?.sessionUrl;
          const hasRunHandles = runScriptPath !== undefined || runSessionUrl !== undefined;
          // A workflow stops as a whole; its coordinator has no Stop of its own.
          const canStop = !workflow && canStopSubagent(subagent, recordedSubagent);
          const canStopWorkflow =
            workflow !== undefined &&
            canOperateWorkflow &&
            workflow.coordinator.status === "running" &&
            workflow.coordinator.origin === "provider_native" &&
            workflow.coordinator.driver === "claudeAgent";
          // Stop appears on hover in place of the trailing time; rows with a run
          // menu or a merge action keep Stop in those controls instead.
          const hoverStop = (canStop || canStopWorkflow) && !hasRunHandles && !isMergeTarget;
          const trailingVisibilityClass = hoverStop
            ? "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0"
            : undefined;
          const failed = status === "failed" || status === "error";
          const subagentTimingValue = subagent ? subagentTiming(subagent) : null;
          const subagentElapsed =
            subagentTimingValue !== null && !failed && hasAgentElapsed(subagentTimingValue)
              ? subagentTimingValue
              : null;
          const stopping = stoppingThreadId === threadId;
          const relationshipHint = node?.missing
            ? "This related thread is unavailable"
            : `Open ${relationship.toLowerCase()} in this chat`;
          const modelSelection = node?.thread?.modelSelection ?? null;
          const providerEntry =
            providerEntryByInstanceId.get(
              modelSelection?.instanceId ?? subagent?.providerInstanceId ?? "",
            ) ?? null;
          const modelBadge = resolveThreadModelBadge({ modelSelection, providerEntry });
          // A subagent's hover is the thread hover card; other relatives keep the hint.
          const RelationshipPopup = subagent ? ThreadHoverCardPopup : TooltipPopup;
          const relationshipTooltip = subagent ? (
            <SubagentTooltipContent
              title={threadTitle}
              modelLabel={modelBadge?.model ?? subagent.model}
              driver={providerEntry?.driverKind ?? subagent.driver}
              providerDisplayName={providerEntry?.displayName}
              providerAccentColor={providerEntry?.accentColor}
              showInstanceBadge={
                providerEntry !== null &&
                shouldShowInstanceBadge(providerEntry, providerEntryByInstanceId.values())
              }
              traits={resolveSubagentModelTraits({ subagent, modelSelection, providerEntry })}
              elapsed={<AgentElapsed agent={subagentTiming(subagent)} />}
              status={subagent.status}
              result={subagent.result}
              progress={subagent.progress}
              workflow={subagent.workflow}
              usage={subagent.usage}
              parentThread={projection?.thread}
              childThread={node?.thread ?? undefined}
              parentProject={projects.find(
                (project) => project.id === projection?.thread.projectId,
              )}
              childProject={projects.find((project) => project.id === node?.thread?.projectId)}
            />
          ) : (
            relationshipHint
          );
          const relationshipContent = (
            <>
              <span className="relative grid size-4 shrink-0 place-items-center">
                {showOrb ? (
                  <AgentOrb seed={threadId} size={16} state={relationshipOrbState(status)} />
                ) : (
                  <>
                    <RelationshipIcon className={THREAD_RELATIONSHIP_ICON_CLASS} />
                    <span
                      className={cn(
                        "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
                        statusDotClass(status),
                      )}
                      aria-hidden="true"
                    />
                  </>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-left text-[13px] font-medium leading-4 text-foreground/85">
                  {threadTitle}
                </span>
              </span>
              {phase ? (
                <span
                  className="shrink-0 text-[11px] leading-4 tabular-nums text-muted-foreground"
                  aria-label={`Workflow phase ${phase.current} of ${phase.total}`}
                  data-thread-relationship-phase
                >
                  {phase.current}/{phase.total}
                </span>
              ) : null}
              {modelBadge ? (
                <span
                  className="flex min-w-0 shrink items-center gap-1 text-[11px] leading-4"
                  data-thread-relationship-model
                >
                  <span className="truncate rounded bg-muted/70 px-1 py-px font-medium text-muted-foreground">
                    {modelBadge.model}
                  </span>
                  {modelBadge.reasoning ? (
                    <span className="shrink-0 text-muted-foreground/70">
                      {modelBadge.reasoning}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {/* One trailing item keeps room for the title: the orb already carries
                  status, so a subagent with a known time shows only that. */}
              {subagentElapsed ? (
                <span
                  className={cn(
                    "shrink-0 text-[11px] leading-4 tabular-nums text-muted-foreground",
                    trailingVisibilityClass,
                  )}
                  data-thread-relationship-elapsed
                >
                  <AgentElapsed agent={subagentElapsed} compact />
                </span>
              ) : (
                <span
                  className={cn(
                    "shrink-0 text-[11px] leading-4",
                    failed ? "text-destructive" : "text-muted-foreground",
                    trailingVisibilityClass,
                  )}
                  data-thread-relationship-status
                >
                  {relationshipStatusLabel(status)}
                </span>
              )}
              {subagent ? null : (
                <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </>
          );
          // The row link as the leading half of a split row, beside a run menu
          // or a workflow's disclosure.
          const splitPrimaryLink = (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS}
                    disabled={node?.missing === true}
                    onClick={() => openThread(threadId)}
                  />
                }
              >
                {relationshipContent}
              </TooltipTrigger>
              <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
            </Tooltip>
          );
          // Run handles render only when the task reported them: a plain
          // subagent has none and should not show dead affordances.
          const runMenu = hasRunHandles ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
                    aria-label={`Workflow run for ${threadTitle}`}
                  />
                }
              >
                <MoreHorizontalIcon className="size-3" />
              </MenuTrigger>
              <MenuPopup align="end" className={THREAD_DETAILS_PANEL_MENU_POPUP_CLASS}>
                {canStop ? (
                  <MenuItem
                    variant="destructive"
                    disabled={stoppingThreadId !== null}
                    onClick={() => void stopSubagent(threadId, subagent)}
                  >
                    <SquareIcon className="size-3.5 fill-current" />
                    Stop subagent
                  </MenuItem>
                ) : null}
                {canStopWorkflow ? (
                  <MenuItem
                    variant="destructive"
                    disabled={stoppingThreadId !== null}
                    onClick={() => void stopWorkflow(threadId, workflow.coordinator)}
                  >
                    <SquareIcon className="size-3.5 fill-current" />
                    Stop entire workflow
                  </MenuItem>
                ) : null}
                {runScriptPath !== undefined ? (
                  <MenuItem onClick={() => setScriptPath(runScriptPath)}>
                    <FileCode2Icon className="size-3.5" />
                    View workflow script
                  </MenuItem>
                ) : null}
                {runSessionUrl !== undefined ? (
                  <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(runSessionUrl)}>
                    <ExternalLinkIcon className="size-3.5" />
                    Open run session
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null;
          if (workflow) {
            return (
              <ThreadLineageWorkflowRow
                key={threadId}
                label={threadTitle}
                group={workflow.group}
                coordinatorId={workflow.coordinator.id}
                header={splitPrimaryLink}
                menu={runMenu}
                provider={{
                  driver: providerEntry?.driverKind ?? workflow.coordinator.driver,
                  providerDisplayName: providerEntry?.displayName,
                  providerAccentColor: providerEntry?.accentColor,
                  showInstanceBadge:
                    providerEntry !== null &&
                    shouldShowInstanceBadge(providerEntry, providerEntryByInstanceId.values()),
                }}
                onOpenThread={openThread}
                // A member's chat opens only once its thread exists in this environment.
                isThreadAvailable={(memberThreadId) =>
                  graph.nodes.get(memberThreadId)?.missing === false
                }
                onStop={
                  hoverStop ? () => void stopWorkflow(threadId, workflow.coordinator) : undefined
                }
                stopping={stopping}
                stopDisabled={stoppingThreadId !== null}
              />
            );
          }
          return (
            <li
              key={threadId}
              className={cn(
                "group relative flex h-8 items-center rounded-lg",
                hoverStop && THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
              )}
            >
              {isMergeTarget ? (
                <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          className={THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS}
                          disabled={node?.missing === true}
                          onClick={() => openThread(threadId)}
                        />
                      }
                    >
                      {relationshipContent}
                    </TooltipTrigger>
                    <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
                  </Tooltip>
                  <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
                          aria-label={
                            parentTitle
                              ? `Merge back to ${parentTitle}`
                              : "Merge back to source conversation"
                          }
                          disabled={!canMerge || busyAction !== null}
                          onClick={() => void merge()}
                        >
                          {busyAction === "merge" ? (
                            <LoaderCircleIcon className="size-3 animate-spin" />
                          ) : (
                            <GitMergeIcon className="size-3" />
                          )}
                        </Button>
                      }
                    />
                    <TooltipPopup side="left">
                      {latestMergeBackRun === null
                        ? "Complete a run in this fork before merging it back"
                        : parentTitle
                          ? `Merge this conversation back into ${parentTitle}`
                          : "Merge this conversation back into its source"}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              ) : runMenu ? (
                <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
                  {splitPrimaryLink}
                  <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
                  {runMenu}
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={node?.missing === true}
                        onClick={() => openThread(threadId)}
                        className={cn(
                          THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
                          // The row's group tints the whole row, Stop included.
                          hoverStop && "hover:!bg-transparent dark:hover:!bg-transparent",
                        )}
                      />
                    }
                  >
                    {relationshipContent}
                  </TooltipTrigger>
                  <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
                </Tooltip>
              )}
              {hoverStop ? (
                <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className={cn(
                            THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
                            "text-destructive hover:text-destructive",
                          )}
                          aria-label={`Stop subagent ${threadTitle}`}
                          disabled={stoppingThreadId !== null}
                          onClick={() => void stopSubagent(threadId, subagent)}
                        >
                          {stopping ? (
                            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                          ) : (
                            <SquareIcon aria-hidden className="size-3 fill-current" />
                          )}
                        </Button>
                      }
                    />
                    <TooltipPopup side="left">Stop subagent</TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
            </li>
          );
        };
        const summaryOrbRows = [...activeSubagentRows, ...doneSubagentRows].slice(0, 4);
        const workingCount = workingSubagentRows.length;
        const failedCount = failedSubagentRows.length;
        const doneCount = doneSubagentRows.length;
        const primaryLabel =
          workingCount > 0 || failedCount === 0
            ? `${workingCount} working`
            : `${failedCount} failed`;
        const showDoneInSummary = doneCount > 0 && (workingCount > 0 || failedCount > 0);
        const summaryOnlyDone = workingCount === 0 && failedCount === 0;
        return (
          <>
            {lineageRows.length > 0 ? (
              <ul className="m-0 list-none p-0">{lineageRows.map(renderRelationshipRow)}</ul>
            ) : null}
            {subagentRows.length > 0 ? (
              <div className={lineageRows.length > 0 ? "mt-1" : undefined}>
                {lineageRows.length > 0 ? (
                  <h4 className="mb-0.5 px-2 text-[11px] font-medium text-muted-foreground">
                    Subagents
                  </h4>
                ) : null}
                <button
                  type="button"
                  aria-expanded={subagentsExpanded}
                  data-thread-relationships-subagents-toggle
                  onClick={() => setSubagentsExpanded((value) => !value)}
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="flex shrink-0 items-center -space-x-1">
                    {summaryOrbRows.map(({ threadId, edge }) => (
                      <AgentOrb
                        key={threadId}
                        seed={threadId}
                        size={16}
                        state={relationshipOrbState(edge.status)}
                        className="ring-1 ring-card"
                      />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-4">
                    <span
                      className={cn(
                        summaryOnlyDone && doneCount > 0
                          ? "text-muted-foreground"
                          : "font-medium text-foreground/85",
                      )}
                    >
                      {summaryOnlyDone && doneCount > 0 ? `${doneCount} done` : primaryLabel}
                    </span>
                    {workingCount > 0 && failedCount > 0 ? (
                      <span className="text-destructive"> · {failedCount} failed</span>
                    ) : null}
                  </span>
                  {showDoneInSummary ? (
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      {doneCount} done
                    </span>
                  ) : null}
                  <ChevronDownIcon
                    className={cn(
                      "size-3 shrink-0 text-muted-foreground transition-transform",
                      !subagentsExpanded && "rotate-180",
                    )}
                  />
                </button>
                {subagentsExpanded ? (
                  <>
                    {activeSubagentRows.length > 0 ? (
                      <ul className="m-0 list-none p-0">
                        {activeSubagentRows.map(renderRelationshipRow)}
                      </ul>
                    ) : null}
                    {doneSubagentRows.length > 0 ? (
                      <div className="mt-0.5">
                        {summaryOnlyDone ? (
                          <ul className="m-0 list-none p-0">
                            {doneSubagentRows.map(renderRelationshipRow)}
                          </ul>
                        ) : (
                          <>
                            <button
                              type="button"
                              aria-expanded={showDone}
                              data-thread-relationships-archived-toggle
                              onClick={() => setShowDone((value) => !value)}
                              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                            >
                              <span className="grid size-4 shrink-0 place-items-center">
                                <CheckIcon className="size-3.5" />
                              </span>
                              <span className="min-w-0 flex-1 truncate">Done · {doneCount}</span>
                              <ChevronDownIcon
                                className={cn(
                                  "size-3 shrink-0 transition-transform",
                                  showDone && "rotate-180",
                                )}
                              />
                            </button>
                            {showDone ? (
                              <ul className="m-0 list-none p-0">
                                {doneSubagentRows.map(renderRelationshipRow)}
                              </ul>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        );
      })()}
      <WorkflowScriptDialog
        threadRef={ref}
        scriptPath={scriptPath}
        onClose={() => setScriptPath(null)}
      />
    </section>
  );
}
