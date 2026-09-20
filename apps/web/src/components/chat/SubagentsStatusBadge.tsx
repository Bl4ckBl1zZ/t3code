import { memo } from "react";

import { AgentOrb } from "./AgentOrb";
import { subagentOrbSeed, type SubagentTurnItem } from "./SubagentsStatusBadge.logic";
import { subagentDisplayTitle } from "./V2LifecycleRow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Past this many the stack stops being countable at a glance; the label carries the rest. */
const VISIBLE_ORB_LIMIT = 3;

/**
 * Floating pill beside the working-tree badge while this thread has subagents
 * working. Hover lists them by name.
 *
 * The orbs are drawn still: this pill stays on screen for as long as any agent
 * runs, and a drift that long is GPU cost for no information — the timeline
 * rows already carry the live progress.
 */
export const SubagentsStatusBadge = memo(function SubagentsStatusBadge(props: {
  readonly subagents: ReadonlyArray<SubagentTurnItem>;
}) {
  const { subagents } = props;
  const label = `${subagents.length} ${subagents.length === 1 ? "agent" : "agents"} working`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="status"
            aria-label={label}
            className="chat-status-pill pointer-events-auto flex items-center gap-1.5 rounded-full px-3 py-1 text-muted-foreground text-xs"
          />
        }
      >
        <span aria-hidden="true" className="flex items-center -space-x-1">
          {subagents.slice(0, VISIBLE_ORB_LIMIT).map((item) => (
            <AgentOrb
              key={item.id}
              seed={subagentOrbSeed(item)}
              size={14}
              state="idle"
              className="ring-1 ring-card"
            />
          ))}
        </span>
        <span className="tabular-nums">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        <ul className="m-0 list-none space-y-1 p-0">
          {subagents.map((item) => (
            <li key={item.id} className="flex min-w-0 items-center gap-1.5">
              <AgentOrb seed={subagentOrbSeed(item)} size={12} state="idle" />
              <span className="truncate">{subagentDisplayTitle(item.title ?? "Subagent")}</span>
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
});
