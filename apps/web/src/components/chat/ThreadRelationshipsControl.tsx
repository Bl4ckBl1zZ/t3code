import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  canDetachThreadProviderSession,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  UnplugIcon,
} from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";

import { AgentOrb, type AgentOrbState } from "./AgentOrb";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadProjection, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
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

function isParentRelationship(edge: ThreadRelationshipEdge, currentThreadId: ThreadId): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

function relationshipSortKey(input: {
  readonly edge: ThreadRelationshipEdge;
  readonly threadId: ThreadId;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): number {
  if (isParentRelationship(input.edge, input.currentThreadId)) return 0;
  if (input.threadId === input.mergeTargetThreadId) return 1;
  return 2;
}

function statusDotClass(status: string | null): string {
  if (status === "running" || status === "in_progress") return "bg-info";
  if (status === "failed" || status === "error") return "bg-destructive";
  if (status === "completed") return "bg-success";
  return "bg-muted-foreground/45";
}

function relationshipOrbState(status: string | null): AgentOrbState {
  if (status === "running" || status === "in_progress") return "active";
  if (status === "failed" || status === "error") return "failed";
  if (status === "completed") return "done";
  return "idle";
}

// Completed subagents linger for a grace window (so a just-finished agent can
// still be caught), then collapse into the "Done" group. Failed agents never
// auto-archive. Rows already completed when the panel first renders skip the
// grace window — they'd otherwise resurrect long-settled work on every open.
const RELATIONSHIP_ARCHIVE_GRACE_MS = 60_000;

function useCompletedRelationshipDecay(
  completedIds: ReadonlyArray<ThreadId>,
): ReadonlySet<ThreadId> {
  const expiryRef = useRef<Map<ThreadId, number> | null>(null);
  const isFirstObservation = expiryRef.current === null;
  const expiries = (expiryRef.current ??= new Map());
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  const now = Date.now();
  for (const id of completedIds) {
    if (!expiries.has(id)) {
      expiries.set(id, isFirstObservation ? now : now + RELATIONSHIP_ARCHIVE_GRACE_MS);
    }
  }
  const completedSet = new Set(completedIds);
  for (const id of [...expiries.keys()]) {
    if (!completedSet.has(id)) expiries.delete(id);
  }
  const archived = new Set<ThreadId>();
  let nextExpiry = Infinity;
  for (const id of completedIds) {
    const expiry = expiries.get(id) ?? now;
    if (expiry <= now) archived.add(id);
    else nextExpiry = Math.min(nextExpiry, expiry);
  }
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(forceRender, Math.max(0, nextExpiry - Date.now()) + 25);
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  return archived;
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
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const threadShells = useThreadShells();
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
  const navigate = useNavigate();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = immediateThreadRelationships(graph, props.threadId).toSorted(
    (left, right) =>
      relationshipSortKey({
        edge: left.edge,
        threadId: left.threadId,
        currentThreadId: props.threadId,
        mergeTargetThreadId,
      }) -
      relationshipSortKey({
        edge: right.edge,
        threadId: right.threadId,
        currentThreadId: props.threadId,
        mergeTargetThreadId,
      }),
  );
  const canMerge = mergeTargetThreadId !== null && latestMergeBackRun !== null;
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;
  const completedSubagentIds = relationshipRows
    .filter(
      ({ edge }) =>
        edge.kind === "subagent" &&
        edge.sourceThreadId === props.threadId &&
        edge.status === "completed",
    )
    .map((row) => row.threadId);
  const archivedIds = useCompletedRelationshipDecay(completedSubagentIds);
  const [showArchived, setShowArchived] = useState(false);

  if (relationshipRows.length === 0) {
    return null;
  }

  const visibleRows = relationshipRows.filter((row) => !archivedIds.has(row.threadId));
  const archivedRows = relationshipRows.filter((row) => archivedIds.has(row.threadId));

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
          Lineage
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
          const isParent = isParentRelationship(edge, props.threadId);
          const showOrb = isSubagent && !isParent;
          const RelationshipIcon = isParent ? CornerLeftUpIcon : GitForkIcon;
          const relationship = relationshipLabel(edge, props.threadId);
          const threadTitle = relationshipThreadTitle({
            title: node?.thread?.title ?? threadId,
            isSubagent,
          });
          const relationshipContent = (
            <>
              <span className="relative -mx-0.5 grid size-4 shrink-0 place-items-center">
                {showOrb ? (
                  <AgentOrb seed={threadId} size={16} state={relationshipOrbState(edge.status)} />
                ) : (
                  <>
                    <RelationshipIcon className={THREAD_RELATIONSHIP_ICON_CLASS} />
                    <span
                      className={cn(
                        "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
                        statusDotClass(edge.status),
                      )}
                      aria-hidden="true"
                    />
                  </>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium leading-4 text-foreground/85">
                  {threadTitle}
                </span>
              </span>
              <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </>
          );
          return (
            <li key={threadId} className="group flex h-9 items-center rounded-lg">
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
                    <TooltipPopup side="left">
                      {node?.missing
                        ? "This related thread is unavailable"
                        : `Open ${relationship.toLowerCase()} in this chat`}
                    </TooltipPopup>
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
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={node?.missing === true}
                        onClick={() => openThread(threadId)}
                        className={THREAD_DETAILS_PANEL_LINK_ROW_CLASS}
                      />
                    }
                  >
                    {relationshipContent}
                  </TooltipTrigger>
                  <TooltipPopup side="left">
                    {node?.missing
                      ? "This related thread is unavailable"
                      : `Open ${relationship.toLowerCase()} in this chat`}
                  </TooltipPopup>
                </Tooltip>
              )}
            </li>
          );
        };
        return (
          <>
            {visibleRows.length > 0 ? (
              <ul className="m-0 list-none p-0">{visibleRows.map(renderRelationshipRow)}</ul>
            ) : null}
            {archivedRows.length > 0 ? (
              <div className="mt-0.5">
                <button
                  type="button"
                  aria-expanded={showArchived}
                  data-thread-relationships-archived-toggle
                  onClick={() => setShowArchived((value) => !value)}
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  <span className="grid size-4 shrink-0 place-items-center">
                    <CheckIcon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">Done · {archivedRows.length}</span>
                  <ChevronDownIcon
                    className={cn(
                      "size-3 shrink-0 transition-transform",
                      showArchived && "rotate-180",
                    )}
                  />
                </button>
                {showArchived ? (
                  <ul className="m-0 list-none p-0">{archivedRows.map(renderRelationshipRow)}</ul>
                ) : null}
              </div>
            ) : null}
          </>
        );
      })()}
    </section>
  );
}
