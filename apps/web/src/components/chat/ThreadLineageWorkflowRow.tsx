import { subagentGroupTiming } from "@t3tools/client-runtime/state/subagent-display";
import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ChevronDownIcon, LoaderCircleIcon, SquareIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed, hasAgentElapsed, type AgentElapsedTiming } from "./AgentElapsed";
import { AgentOrb } from "./AgentOrb";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import {
  workflowPhaseStatusLabel,
  type WorkflowGroup,
  type WorkflowMember,
  type WorkflowPhaseGroup,
} from "./ThreadLineageWorkflowRow.logic";
import {
  THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { relationshipOrbState, relationshipStatusLabel } from "./threadRelationshipStatus";

/** Provider identity a member shares with its coordinator in the hover card. */
export type WorkflowMemberProvider = Pick<
  ComponentProps<typeof SubagentTooltipContent>,
  "driver" | "providerDisplayName" | "providerAccentColor" | "showInstanceBadge"
>;

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));

function memberTiming(member: WorkflowMember): AgentElapsedTiming {
  return {
    status: member.status,
    startedAt: iso(member.startedAt),
    completedAt: iso(member.completedAt),
  };
}

function WorkflowMemberRow(props: {
  readonly member: WorkflowMember;
  readonly orbSeed: string;
  readonly provider: WorkflowMemberProvider;
  readonly canOpen: boolean;
  readonly onOpen: () => void;
}) {
  const { member } = props;
  const timing = memberTiming(member);
  const failed = member.status === "failed";
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <Button
              size="sm"
              variant="ghost"
              className={THREAD_DETAILS_PANEL_LINK_ROW_CLASS}
              aria-label={`Open ${member.title} chat`}
              disabled={!props.canOpen}
              onClick={() => props.canOpen && props.onOpen()}
            />
          }
        >
          <span className="grid size-4 shrink-0 place-items-center">
            <AgentOrb seed={props.orbSeed} size={16} state={relationshipOrbState(member.status)} />
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-4 text-foreground/85">
            {member.title}
          </span>
          {/* Same single trailing item as a subagent row: time when known, else status. */}
          {!failed && hasAgentElapsed(timing) ? (
            <>
              <span className="sr-only">{relationshipStatusLabel(member.status)}</span>
              <span className="shrink-0 text-[11px] leading-4 tabular-nums text-muted-foreground">
                <AgentElapsed agent={timing} compact />
              </span>
            </>
          ) : (
            <span
              className={cn(
                "shrink-0 text-[11px] leading-4",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {relationshipStatusLabel(member.status)}
            </span>
          )}
        </TooltipTrigger>
        <ThreadHoverCardPopup side="left">
          <SubagentTooltipContent
            title={member.title}
            modelLabel={member.model}
            {...props.provider}
            elapsed={<AgentElapsed agent={timing} />}
            status={member.status}
            result={member.result}
            progress={member.prompt}
            usage={member.usage}
          />
        </ThreadHoverCardPopup>
      </Tooltip>
    </li>
  );
}

function WorkflowPhaseHeader(props: {
  readonly phase: WorkflowPhaseGroup;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const { phase } = props;
  const status = workflowPhaseStatusLabel(phase);
  const running = phase.state === "running";
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-label={`${props.open ? "Collapse" : "Expand"} ${phase.title} phase, ${status}`}
      onClick={props.onToggle}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md ps-2 pe-2.5 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        running ? "text-foreground/80" : "text-muted-foreground/70",
      )}
    >
      <span className="min-w-0 shrink truncate">{phase.title}</span>
      <span
        aria-hidden
        className={cn("h-px min-w-2 flex-1", running ? "bg-foreground/25" : "bg-border/60")}
      />
      {status === "failed" ? (
        <span className="shrink-0 text-[10px] leading-none text-destructive">Failed</span>
      ) : null}
      <span className="shrink-0 text-[11px] font-normal tabular-nums">
        {phase.settledCount}/{phase.members.length}{" "}
        {phase.members.length === 1 ? "agent" : "agents"}
      </span>
      <span className="shrink-0 text-[11px] font-normal tabular-nums empty:hidden">
        {/* Members run in parallel: first start to last finish is the phase's wall clock. */}
        <AgentElapsed agent={subagentGroupTiming(phase.members)} />
      </span>
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", !props.open && "rotate-180")}
      />
    </button>
  );
}

/**
 * A workflow coordinator's Lineage row. The coordinator stays an ordinary row
 * link; a split chevron unfolds the members it ran, grouped by phase, each
 * opening its own chat. The running phase opens itself until the user picks a
 * side for it, so finished phases stay folded.
 */
export function ThreadLineageWorkflowRow(props: {
  readonly label: string;
  readonly group: WorkflowGroup;
  /** Seeds member orbs that have no thread of their own yet. */
  readonly coordinatorId: string;
  /** The coordinator's row link, rendered as the split row's leading half. */
  readonly header: ReactNode;
  /** The run handles menu, when the workflow reported any. */
  readonly menu?: ReactNode;
  readonly provider: WorkflowMemberProvider;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly isThreadAvailable: (threadId: ThreadId) => boolean;
  /** Hover Stop for the whole run; rows with a run menu offer it there instead. */
  readonly onStop?: (() => void) | undefined;
  readonly stopping: boolean;
  readonly stopDisabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [phaseOpen, setPhaseOpen] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const phases = props.group.phases.filter((phase) => phase.members.length > 0);
  const renderMember = (member: WorkflowMember) => {
    const threadId = member.childThreadId;
    return (
      <WorkflowMemberRow
        key={member.index}
        member={member}
        orbSeed={threadId ?? `${props.coordinatorId}:agent:${member.index}`}
        provider={props.provider}
        canOpen={threadId !== null && props.isThreadAvailable(threadId)}
        onOpen={() => threadId !== null && props.onOpenThread(threadId)}
      />
    );
  };
  return (
    <li data-thread-relationship-workflow>
      <div className={cn("group relative h-8", THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS)}>
        {props.header}
        {props.onStop ? (
          <div className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
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
                    aria-label={`Stop workflow ${props.label}`}
                    disabled={props.stopDisabled}
                    onClick={props.onStop}
                  >
                    {props.stopping ? (
                      <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                    ) : (
                      <SquareIcon aria-hidden className="size-3 fill-current" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="left">Stop entire workflow</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {props.menu ? (
          <>
            <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
            {props.menu}
          </>
        ) : null}
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
        <Button
          size="sm"
          variant="ghost"
          className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${props.label}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </Button>
      </div>
      {expanded ? (
        <ul className="m-0 list-none p-0 ps-6.5">
          {phases.map((phase) => {
            const open = phaseOpen.get(phase.index) ?? phase.state === "running";
            return (
              <li key={phase.index}>
                <WorkflowPhaseHeader
                  phase={phase}
                  open={open}
                  onToggle={() => setPhaseOpen((map) => new Map(map).set(phase.index, !open))}
                />
                {open ? (
                  <ul className="m-0 list-none p-0">{phase.members.map(renderMember)}</ul>
                ) : null}
              </li>
            );
          })}
          {props.group.unphasedMembers.map(renderMember)}
          {phases.length === 0 && props.group.unphasedMembers.length === 0 ? (
            <li className="px-2.5 py-1.5 text-[11px] text-muted-foreground/70">No agents yet</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
