import { memo, useState } from "react";
import * as DateTime from "effect/DateTime";
import { ChevronDownIcon, TerminalIcon } from "lucide-react";

import {
  formatBackgroundElapsed,
  liveBackgroundProcessesFromTimeline,
  resolveBackgroundProcessView,
} from "@t3tools/shared/backgroundProcess";
import type { TimelineEntry } from "../../session-logic";
import { cn } from "../../lib/utils";
import { BackgroundProcessRow, LiveDuration } from "./BackgroundProcessRow";

/**
 * Persistent strip stating that a thread is waiting on work of its own.
 *
 * Sits above the composer rather than inside the timeline, because the moment
 * this matters is the moment the turn looks finished — and a reader who has
 * scrolled away from the last message is exactly the reader most likely to
 * conclude nothing is happening.
 *
 * Rows are self-ticking; this component re-renders only when the set of live
 * commands changes.
 */
export const BackgroundProcessesControl = memo(function BackgroundProcessesControl({
  timelineEntries,
  turnInProgress,
}: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  /** While a turn runs its own indicator already speaks; this would be noise. */
  readonly turnInProgress: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const processes = liveBackgroundProcessesFromTimeline(timelineEntries);
  if (processes.length === 0) {
    return null;
  }

  const nowMs = Date.now();
  // Compared on epoch millis, not on stringified DateTimes: those only sort
  // correctly because Effect happens to render them ISO-prefixed, and an item
  // with no start time would sort ahead of every real one.
  const oldest = processes.reduce((earliest, candidate) => {
    const earliestStartedMs =
      earliest.item.startedAt === null ? nowMs : DateTime.toEpochMillis(earliest.item.startedAt);
    const candidateStartedMs =
      candidate.item.startedAt === null ? nowMs : DateTime.toEpochMillis(candidate.item.startedAt);
    return candidateStartedMs < earliestStartedMs ? candidate : earliest;
  });
  const oldestView = resolveBackgroundProcessView(oldest.item, nowMs);
  const oldestStartedAtMs =
    oldest.item.startedAt === null ? nowMs : DateTime.toEpochMillis(oldest.item.startedAt);
  const label =
    processes.length === 1 && oldestView.variant === "monitor"
      ? "Waiting for a condition"
      : "Running in background";

  return (
    <section
      aria-label={`${processes.length} background ${processes.length === 1 ? "command" : "commands"}`}
      className="chat-composer-queue-strip relative z-0 -mb-4 mx-auto w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] px-2 pt-1.5 pb-5"
    >
      {/* The in-turn dim rides the contents, never the strip: opacity on the
          strip would make it a backdrop root, dropping its glass blur and
          letting the timeline read straight through the tint. */}
      <div className={cn(turnInProgress && "opacity-70")}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-6 w-full items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <TerminalIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
          <span className="rounded-full bg-muted/70 px-1.5 text-[10px] tabular-nums">
            {processes.length}
          </span>
          <span className="ms-auto flex shrink-0 items-center gap-1.5 font-normal text-muted-foreground/65">
            {/* Self-ticking: the live set does not change while a command runs,
              so this component does not re-render and a value rendered once
              would sit frozen for the whole wait. */}
            <LiveDuration
              format={formatBackgroundElapsed}
              startedAtMs={oldestStartedAtMs}
              pausedMs={oldest.item.pausedMs ?? 0}
              paused={oldestView.paused}
            />
            <ChevronDownIcon
              className={cn("size-3 transition-transform duration-200", expanded && "rotate-180")}
              aria-hidden
            />
          </span>
        </button>
        {expanded ? (
          <div className="max-h-40 overflow-y-auto px-1">
            {processes.map((process) => (
              <div key={process.item.id} className="border-border/45 border-t first:border-t-0">
                <BackgroundProcessRow item={process.item} monitor={process.monitor} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
});
