import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useMemo } from "react";

import {
  formatBackgroundElapsed,
  liveBackgroundProcesses,
  resolveBackgroundProcessView,
  type LiveBackgroundProcess,
} from "@t3tools/shared/backgroundProcess";
import { cn } from "../../lib/utils";
import { useThreadVisibleTurnItems } from "../../state/entities";
import { LiveDuration } from "./BackgroundProcessCard";

/**
 * Same ceiling as the ports section: past a handful of rows the panel stops
 * being glanceable, and the timeline is the place to read them all anyway.
 */
const VISIBLE_TASK_LIMIT = 4;

/**
 * Thread details panel section listing commands that outlived the tool call
 * which launched them — `Bash` with `run_in_background`, and the monitors that
 * wait on them.
 *
 * The composer strip already says this while you are reading the thread. This
 * section exists for the reader who is looking at a diff, a file, or another
 * thread's worth of context: the panel stays put, so "something is still
 * running" stays visible. Renders nothing when nothing is running, so the
 * heading never sits there dead.
 */
export function ThreadBackgroundTasksPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  // The same projection the timeline renders, so this section and the rows in
  // the thread cannot disagree about what is running.
  const items = useThreadVisibleTurnItems({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const processes = useMemo(() => liveBackgroundProcesses(items), [items]);

  if (processes.length === 0) return null;

  return (
    <section
      aria-labelledby="thread-details-background-tasks-heading"
      className="border-t border-border/65 px-2 pb-2.5 pt-2"
      data-thread-background-tasks-panel
    >
      <div className="mb-1 flex min-h-8 items-center px-2">
        <h3
          id="thread-details-background-tasks-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Background Tasks
        </h3>
      </div>

      <ul className="m-0 list-none p-0">
        {processes.slice(0, VISIBLE_TASK_LIMIT).map((process) => (
          <BackgroundTaskRow key={process.item.id} process={process} />
        ))}
      </ul>

      {processes.length > VISIBLE_TASK_LIMIT ? (
        <p className="px-2.5 pt-1 text-[11px] text-muted-foreground">
          {`+${processes.length - VISIBLE_TASK_LIMIT} more`}
        </p>
      ) : null}
    </section>
  );
}

function BackgroundTaskRow(props: { readonly process: LiveBackgroundProcess }) {
  const item = props.process.item;
  const nowMs = Date.now();
  const view = resolveBackgroundProcessView(item, nowMs);
  const startedAtMs = item.startedAt === null ? nowMs : DateTime.toEpochMillis(item.startedAt);
  const isMonitorRow = view.variant === "monitor";
  const monitor = props.process.monitor;

  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          // `bg-info` rather than the ports section's emerald: this is the same
          // "a command is running" state the timeline card and the composer
          // strip already paint, and one thing should have one colour.
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-info",
            view.paused ? "opacity-50" : "animate-pulse",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/80">
          {isMonitorRow ? "Waiting on a condition" : view.command}
        </span>
        <RowDeadline
          item={item}
          view={view}
          startedAtMs={startedAtMs}
          isMonitorRow={isMonitorRow}
        />
      </div>

      <p className="min-w-0 truncate pl-4 text-[10.5px] text-muted-foreground/55">
        {isMonitorRow ? (
          "the agent is asleep until this passes"
        ) : (
          <>
            {view.tail ?? "no output yet"}
            {view.outputTruncated ? " · output capped" : ""}
            {monitor === null ? "" : " · the agent is waiting on it"}
          </>
        )}
      </p>
    </li>
  );
}

/**
 * A monitor's deadline is the only number it makes claims about, so it wins the
 * slot; everything else reports how long it has been going.
 */
function RowDeadline(props: {
  readonly item: LiveBackgroundProcess["item"];
  readonly view: ReturnType<typeof resolveBackgroundProcessView>;
  readonly startedAtMs: number;
  readonly isMonitorRow: boolean;
}) {
  const timeoutMs = props.item.timeoutMs;
  const className = "shrink-0 text-[10.5px] text-muted-foreground/60";
  if (props.isMonitorRow && timeoutMs !== undefined) {
    return (
      <LiveDuration
        className={className}
        format={(elapsedMs) =>
          `${formatBackgroundElapsed(Math.max(0, timeoutMs - elapsedMs))} left`
        }
        startedAtMs={props.startedAtMs}
        pausedMs={0}
        paused={false}
      />
    );
  }
  // Self-ticking: the live set does not change while a command runs, so this
  // component does not re-render and a value rendered once would sit frozen.
  return (
    <LiveDuration
      className={className}
      format={formatBackgroundElapsed}
      startedAtMs={props.startedAtMs}
      pausedMs={props.item.pausedMs ?? 0}
      paused={props.view.paused}
    />
  );
}
