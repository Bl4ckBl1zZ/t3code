import { memo, useState } from "react";
import * as DateTime from "effect/DateTime";

import {
  formatBackgroundElapsed,
  liveBackgroundProcessesFromTimeline,
  resolveBackgroundProcessView,
} from "@t3tools/shared/backgroundProcess";
import type { TimelineEntry } from "../../session-logic";
import { cn } from "../../lib/utils";
import { BackgroundProcessCard, LiveDuration } from "./BackgroundProcessCard";

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
    processes.length === 1
      ? oldestView.variant === "monitor"
        ? "Waiting on a condition"
        : "1 background process"
      : `${processes.length} background processes`;

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-1.5">
      <div
        className={cn(
          "rounded-xl border border-info/25 bg-info/6 px-3 py-2",
          turnInProgress && "opacity-70",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-info"
          />
          <span className="min-w-0 flex-1 truncate text-[11.5px]">
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground/70">
              {" · "}
              {/* Self-ticking: the live set does not change while a command runs,
                  so this component does not re-render and a value rendered once
                  would sit frozen for the whole wait. */}
              <LiveDuration
                format={formatBackgroundElapsed}
                startedAtMs={oldestStartedAtMs}
                pausedMs={oldest.item.pausedMs ?? 0}
                paused={oldestView.paused}
              />
            </span>
          </span>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {expanded ? "Hide" : "Show"}
          </button>
        </div>
        {expanded ? (
          <div className="mt-2 space-y-1.5">
            {processes.map((process) => (
              <BackgroundProcessCard
                key={process.item.id}
                item={process.item}
                monitor={process.monitor}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});
