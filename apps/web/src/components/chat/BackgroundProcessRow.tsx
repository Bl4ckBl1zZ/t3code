import { memo, useEffect, useRef } from "react";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2CommandExecutionItem } from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";

import {
  backgroundElapsedTickMs,
  formatBackgroundElapsed,
  formatBackgroundSinceOutput,
  resolveBackgroundProcessView,
  type BackgroundProcessView,
} from "@t3tools/shared/backgroundProcess";
import { cn } from "../../lib/utils";

/**
 * A command that outlived its turn, drawn as an ordinary tool row.
 *
 * What a background command adds to that row is a clock and one line underneath
 * that keeps saying something while the turn around it is settled: the last
 * line of output and how long since it moved. What it deliberately does not
 * carry is a fabricated percentage: a progress bar appears only where a
 * deadline was actually declared.
 *
 * The tail is plain text, because shimmering monospace under a row that can run
 * for an hour reads as a fault rather than as progress.
 */

/**
 * Self-ticking so a running command never re-renders the timeline. Writes
 * `textContent` directly, and slows to a 30s cadence once the label stops
 * showing seconds.
 */
export function LiveDuration({
  className,
  format,
  startedAtMs,
  pausedMs,
  paused,
}: {
  readonly className?: string;
  readonly format: (elapsedMs: number) => string;
  readonly startedAtMs: number;
  readonly pausedMs: number;
  readonly paused: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const initial = format(Math.max(0, Date.now() - startedAtMs - pausedMs));

  useEffect(() => {
    if (paused) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const elapsedMs = Math.max(0, Date.now() - startedAtMs - pausedMs);
      if (ref.current) {
        ref.current.textContent = format(elapsedMs);
      }
      timeout = setTimeout(tick, backgroundElapsedTickMs(elapsedMs));
    };
    tick();
    return () => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    };
  }, [format, startedAtMs, pausedMs, paused]);

  return (
    <span ref={ref} aria-hidden="true" className={cn("tabular-nums", className)}>
      {initial}
    </span>
  );
}

/**
 * Determinate progress against a declared deadline, driven by one CSS
 * transition rather than a timer.
 *
 * A ticking bar would be wrong here anyway: the case with a deadline is a
 * foreground command, which emits nothing at all while it runs, so a bar redrawn
 * on re-render would simply never move. Scales a transform instead of animating
 * width, so the browser has no layout work to do per frame.
 */
function DeadlineBar({
  fraction,
  remainingMs,
  live,
}: {
  readonly fraction: number;
  readonly remainingMs: number;
  readonly live: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null || !live || remainingMs <= 0) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      element.style.transition = `transform ${remainingMs}ms linear`;
      element.style.transform = "scaleX(1)";
    });
    return () => cancelAnimationFrame(frame);
  }, [live, remainingMs]);

  return (
    <span
      aria-hidden="true"
      className="h-0.5 w-24 shrink-0 overflow-hidden rounded-full bg-border/60"
    >
      <span
        ref={ref}
        className="block h-full origin-left rounded-full bg-muted-foreground/45"
        style={{ width: "100%", transform: `scaleX(${Math.min(1, Math.max(0, fraction))})` }}
      />
    </span>
  );
}

function startedAtMsOf(item: OrchestrationV2CommandExecutionItem, nowMs: number): number {
  return item.startedAt === null ? nowMs : DateTime.toEpochMillis(item.startedAt);
}

export function backgroundProcessHeading(view: BackgroundProcessView): string {
  return view.variant === "monitor" ? "Waiting for a condition" : "Background command";
}

/** Running time: ticking while live, frozen at the final duration once settled. */
export function BackgroundProcessElapsed({
  item,
  view,
  className,
}: {
  readonly item: OrchestrationV2CommandExecutionItem;
  readonly view: BackgroundProcessView;
  readonly className?: string;
}) {
  if (!view.live) {
    return (
      <span className={cn("tabular-nums", className)}>
        {formatBackgroundElapsed(view.elapsedMs)}
      </span>
    );
  }
  return (
    <span className={className}>
      {view.paused ? "Paused · " : null}
      <LiveDuration
        format={formatBackgroundElapsed}
        startedAtMs={startedAtMsOf(item, Date.now())}
        pausedMs={item.pausedMs ?? 0}
        paused={view.paused}
      />
    </span>
  );
}

const DETAIL_LINE_CLASS = "min-w-0 truncate text-[11px] leading-4 text-muted-foreground/55";

/**
 * The line under a background command's row. While it runs, this is what it is
 * doing right now. Once settled, it is only an ending worth explaining — a clean
 * exit says nothing, like every other finished tool call.
 */
export function BackgroundProcessDetail({
  item,
  view,
  className,
}: {
  readonly item: OrchestrationV2CommandExecutionItem;
  readonly view: BackgroundProcessView;
  readonly className?: string;
}) {
  if (!view.live) {
    const outcome = view.outcome;
    if (outcome === null || outcome.tone === "success") {
      return null;
    }
    return (
      <p
        className={cn(
          DETAIL_LINE_CLASS,
          outcome.tone === "danger" ? "text-destructive/80" : "text-warning/80",
          className,
        )}
      >
        {outcome.label}
      </p>
    );
  }

  if (view.variant === "monitor") {
    return (
      <MonitorLine
        startedAtMs={startedAtMsOf(item, Date.now())}
        timeoutMs={item.timeoutMs}
        className={className}
      />
    );
  }

  if (view.variant === "deadline") {
    return (
      <div className={cn("flex min-w-0 items-center gap-2", className)}>
        <DeadlineBar
          fraction={view.deadlineFraction ?? 0}
          remainingMs={view.deadlineRemainingMs ?? 0}
          live={view.live}
        />
        <span className={DETAIL_LINE_CLASS}>No output until it exits</span>
      </div>
    );
  }

  const lastOutputAtMs =
    item.lastOutputAt === undefined ? null : DateTime.toEpochMillis(item.lastOutputAt);
  return (
    <div className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
      <span className={cn(DETAIL_LINE_CLASS, view.tail !== null && "font-mono text-[10.5px]")}>
        {view.tail ?? "No output yet"}
        {view.outputTruncated ? " · output capped" : ""}
      </span>
      {lastOutputAtMs !== null ? (
        // Counts up on its own. When output stops, no further events arrive
        // for this row, so a value rendered once would freeze at "2s ago" —
        // asserting freshness at the exact moment there is none.
        <LiveDuration
          className="shrink-0 text-[10.5px] text-muted-foreground/40"
          format={formatBackgroundSinceOutput}
          startedAtMs={lastOutputAtMs}
          pausedMs={0}
          paused={false}
        />
      ) : null}
    </div>
  );
}

/**
 * A live background command listed under a heading that already names it — the
 * background pill's popover and the thread details panel. The timeline row minus its
 * "Background command" title, with any monitor watching it folded in underneath.
 */
export const BackgroundProcessRow = memo(function BackgroundProcessRow({
  item,
  monitor,
}: {
  readonly item: OrchestrationV2CommandExecutionItem;
  /** Monitor watching this command, folded in as a child line. */
  readonly monitor?: OrchestrationV2CommandExecutionItem | null;
}) {
  const nowMs = Date.now();
  const view = resolveBackgroundProcessView(item, nowMs);

  return (
    <div
      data-background-process-variant={view.variant}
      data-background-process-live={view.live}
      className="flex min-w-0 flex-col py-0.5"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
          <TerminalIcon className="size-3.5 stroke-[1.8] opacity-80" aria-hidden />
        </span>
        {view.variant === "monitor" ? (
          <span className="min-w-0 shrink truncate font-medium text-foreground/82">
            {backgroundProcessHeading(view)}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            view.variant === "monitor" ? "text-muted-foreground/55" : "text-foreground/82",
          )}
        >
          {view.command}
        </span>
        <BackgroundProcessElapsed
          item={item}
          view={view}
          className="shrink-0 text-[11px] text-muted-foreground/55"
        />
      </div>
      <BackgroundProcessDetail item={item} view={view} className="ps-6.5" />
      {monitor !== null && monitor !== undefined ? (
        <MonitorLine
          startedAtMs={startedAtMsOf(monitor, nowMs)}
          timeoutMs={monitor.timeoutMs}
          className="ps-6.5"
          folded
        />
      ) : null}
    </div>
  );
});

/**
 * A monitor states the agent's own position: asleep until a condition, with a
 * deadline it will give up at. That deadline is the one number here that is
 * real, so it is the one number shown.
 */
function MonitorLine({
  startedAtMs,
  timeoutMs,
  className,
  folded,
}: {
  readonly startedAtMs: number;
  readonly timeoutMs: number | undefined;
  readonly className?: string | undefined;
  readonly folded?: boolean;
}) {
  return (
    <p className={cn(DETAIL_LINE_CLASS, className)}>
      {folded ? "Agent is waiting on this" : "Agent is asleep until this passes"}
      {timeoutMs === undefined ? null : (
        <>
          {" · gives up in "}
          {/* Counts down on its own. Nothing else re-renders this row, so a
              value computed once would sit frozen for the whole wait. */}
          <LiveDuration
            format={(elapsedMs) => formatBackgroundElapsed(Math.max(0, timeoutMs - elapsedMs))}
            startedAtMs={startedAtMs}
            pausedMs={0}
            paused={false}
          />
        </>
      )}
    </p>
  );
}
