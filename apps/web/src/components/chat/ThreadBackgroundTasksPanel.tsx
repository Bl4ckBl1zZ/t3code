import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { liveBackgroundProcesses } from "@t3tools/shared/backgroundProcess";
import { useThreadVisibleTurnItems } from "../../state/entities";
import { BackgroundProcessRow } from "./BackgroundProcessRow";

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
 * The background pill already says this while you are reading the thread. This
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

      <ul className="m-0 list-none px-1.5 py-0">
        {processes.slice(0, VISIBLE_TASK_LIMIT).map((process) => (
          <li key={process.item.id} className="py-0.5">
            <BackgroundProcessRow item={process.item} monitor={process.monitor} />
          </li>
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
