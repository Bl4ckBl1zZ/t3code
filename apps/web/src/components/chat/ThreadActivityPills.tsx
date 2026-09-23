import { memo, useCallback, useId, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { ChevronUpIcon, TerminalIcon } from "lucide-react";

import {
  formatBackgroundElapsed,
  summarizeBackgroundProcesses,
  type LiveBackgroundProcess,
} from "@t3tools/shared/backgroundProcess";
import { cn } from "../../lib/utils";
import {
  Popover,
  PopoverCreateHandle,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { AgentOrb } from "./AgentOrb";
import { BackgroundProcessRow, LiveDuration } from "./BackgroundProcessRow";
import { subagentOrbSeed, type SubagentTurnItem } from "./SubagentsStatusBadge.logic";
import { SubagentRow } from "./V2LifecycleRow";

type ActivityPanel = "agents" | "background";

/** Past this many the stack stops being countable at a glance; the label carries the rest. */
const VISIBLE_ORB_LIMIT = 3;

const PILL_CLASS_NAME =
  "chat-status-pill group pointer-events-auto flex cursor-pointer items-center gap-1.5 rounded-full py-1 ps-3 pe-2 text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 data-popup-open:text-foreground";

function PillChevron() {
  return (
    <ChevronUpIcon
      aria-hidden
      className="size-3 shrink-0 opacity-70 transition-transform duration-150 group-data-popup-open:rotate-180"
    />
  );
}

/**
 * The floating pills for work this thread is still waiting on — subagents and
 * background commands — sharing one popover that opens out of whichever pill
 * was clicked. Clicking the other pill while it is open swaps the list in
 * place, so only one list is ever showing.
 *
 * Controlled so the popover closes when its list empties: the pill it grew out
 * of unmounts with the last item, and an uncontrolled popup would float over
 * nothing, then reopen by itself when the next agent starts.
 *
 * The pill orbs are drawn still: a pill stays on screen for as long as any
 * agent runs, and a drift that long is GPU cost for no information.
 */
export const ThreadActivityPills = memo(function ThreadActivityPills(props: {
  readonly subagents: ReadonlyArray<SubagentTurnItem>;
  readonly backgroundProcesses: ReadonlyArray<LiveBackgroundProcess>;
  /** While a turn runs its own indicator already speaks; the background pill dims. */
  readonly turnInProgress: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { subagents, backgroundProcesses, onOpenThread } = props;
  const [handle] = useState(() => PopoverCreateHandle<ActivityPanel>());
  const agentsTriggerId = useId();
  const backgroundTriggerId = useId();
  const [openTriggerId, setOpenTriggerId] = useState<string | null>(null);
  const open =
    (openTriggerId === agentsTriggerId && subagents.length > 0) ||
    (openTriggerId === backgroundTriggerId && backgroundProcesses.length > 0);
  if (openTriggerId !== null && !open) {
    setOpenTriggerId(null);
  }

  const openThread = useCallback(
    (threadId: ThreadId) => {
      setOpenTriggerId(null);
      onOpenThread(threadId);
    },
    [onOpenThread],
  );

  const agentsLabel = `${subagents.length} ${subagents.length === 1 ? "agent" : "agents"} working`;

  return (
    <>
      {subagents.length > 0 ? (
        <PopoverTrigger
          id={agentsTriggerId}
          handle={handle}
          payload="agents"
          className={PILL_CLASS_NAME}
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
          <span className="tabular-nums">{agentsLabel}</span>
          <PillChevron />
        </PopoverTrigger>
      ) : null}
      {backgroundProcesses.length > 0 ? (
        <BackgroundProcessesTrigger
          id={backgroundTriggerId}
          handle={handle}
          processes={backgroundProcesses}
          turnInProgress={props.turnInProgress}
        />
      ) : null}
      <Popover
        handle={handle}
        open={open}
        onOpenChange={(nextOpen, details) =>
          setOpenTriggerId(nextOpen ? (details.trigger?.id ?? null) : null)
        }
      >
        {({ payload }) => (
          <PopoverPopup
            side="top"
            sideOffset={6}
            width="lg"
            viewportClassName="py-1.5 [--viewport-inline-padding:--spacing(1.5)]"
          >
            {payload === "agents" ? (
              <>
                <PanelTitle>Agents working</PanelTitle>
                <div className="max-h-72 overflow-y-auto">
                  {subagents.map((item) => (
                    <SubagentRow key={item.id} item={item} onOpenThread={openThread} />
                  ))}
                </div>
              </>
            ) : payload === "background" ? (
              <>
                <PanelTitle>Running in background</PanelTitle>
                <div className="max-h-72 overflow-y-auto px-1">
                  {backgroundProcesses.map((process) => (
                    <div
                      key={process.item.id}
                      className="border-border/45 border-t first:border-t-0"
                    >
                      <BackgroundProcessRow item={process.item} monitor={process.monitor} />
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </PopoverPopup>
        )}
      </Popover>
    </>
  );
});

function PanelTitle(props: { readonly children: string }) {
  return (
    <PopoverTitle className="px-1.5 pt-1 pb-1.5 font-medium text-[11px] text-muted-foreground">
      {props.children}
    </PopoverTitle>
  );
}

/**
 * Counts the thread's live background commands and how long the oldest has
 * been running. Re-renders only when the set of live commands changes; the
 * clock ticks on its own.
 */
function BackgroundProcessesTrigger(props: {
  readonly id: string;
  readonly handle: ReturnType<typeof PopoverCreateHandle<ActivityPanel>>;
  readonly processes: ReadonlyArray<LiveBackgroundProcess>;
  readonly turnInProgress: boolean;
}) {
  const summary = summarizeBackgroundProcesses(props.processes, Date.now());
  if (summary === null) {
    return null;
  }
  return (
    <PopoverTrigger
      id={props.id}
      handle={props.handle}
      payload="background"
      aria-label={summary.accessibilityLabel}
      className={PILL_CLASS_NAME}
    >
      {/* The in-turn dim rides the contents, never the pill, so its glass
          surface still matches the pills beside it. */}
      <span className={cn("flex items-center gap-1.5", props.turnInProgress && "opacity-70")}>
        <TerminalIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="tabular-nums">{summary.label}</span>
        <LiveDuration
          className="text-muted-foreground/65"
          format={formatBackgroundElapsed}
          startedAtMs={summary.startedAtMs}
          pausedMs={summary.pausedMs}
          paused={summary.paused}
        />
      </span>
      <PillChevron />
    </PopoverTrigger>
  );
}
