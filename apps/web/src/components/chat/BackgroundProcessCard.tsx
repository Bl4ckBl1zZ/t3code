import { memo, useEffect, useRef } from "react";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2CommandExecutionItem } from "@t3tools/contracts";

import {
  backgroundElapsedTickMs,
  formatBackgroundElapsed,
  formatBackgroundSinceOutput,
  resolveBackgroundProcessView,
  type BackgroundProcessView,
} from "../../backgroundProcess";
import { cn } from "../../lib/utils";

/**
 * A command that outlived its turn.
 *
 * The whole point is that this row keeps saying something while the turn around
 * it is settled, so it carries an elapsed timer, the last line of output, and
 * how long since that line moved. What it deliberately does not carry is a
 * fabricated percentage: a progress bar appears only where a deadline was
 * actually declared.
 *
 * Motion budget is one animated element per row — the status dot. The tail is
 * plain text, because two rows of shimmering monospace in a timeline reads as a
 * fault rather than as progress.
 */

/**
 * Self-ticking so a running command never re-renders the timeline. Writes
 * `textContent` directly, and slows to a 30s cadence once the label stops
 * showing seconds.
 */
function LiveDuration({
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

const OUTCOME_TONE_CLASS = {
  success: "text-success",
  danger: "text-destructive",
  warning: "text-warning",
  neutral: "text-muted-foreground",
} as const;

function StatusDot({ view }: { readonly view: BackgroundProcessView }) {
  if (!view.live) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          view.outcome?.tone === "danger"
            ? "bg-destructive"
            : view.outcome?.tone === "warning"
              ? "bg-warning"
              : "bg-success",
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-info",
        view.paused ? "opacity-50" : "animate-pulse",
      )}
    />
  );
}

/**
 * Long commands are mostly flags. Keeping the head and the tail beats keeping a
 * prefix, because the distinguishing part of `coderabbit review --base <sha>` is
 * at both ends and never in the middle.
 */
function middleTruncate(command: string, max = 96): string {
  if (command.length <= max) {
    return command;
  }
  const head = Math.ceil((max - 1) / 2);
  return `${command.slice(0, head)}…${command.slice(command.length - (max - head - 1))}`;
}

export const BackgroundProcessCard = memo(function BackgroundProcessCard({
  item,
  monitor,
  onStop,
}: {
  readonly item: OrchestrationV2CommandExecutionItem;
  /** Monitor watching this command, folded in as a child line. */
  readonly monitor?: OrchestrationV2CommandExecutionItem | null;
  readonly onStop?: (item: OrchestrationV2CommandExecutionItem) => void;
}) {
  const nowMs = Date.now();
  const view = resolveBackgroundProcessView(item, nowMs);
  const monitorView =
    monitor === null || monitor === undefined ? null : resolveBackgroundProcessView(monitor, nowMs);
  const startedAtMs = item.startedAt === null ? nowMs : DateTime.toEpochMillis(item.startedAt);
  const isMonitorRow = view.variant === "monitor";

  return (
    <div
      data-background-process-variant={view.variant}
      data-background-process-live={view.live}
      className="group/bg-process flex min-w-0 flex-col gap-1.5 rounded-xl border border-border/60 bg-card/30 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot view={view} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/82">
          {isMonitorRow ? "Waiting for a condition" : middleTruncate(view.command)}
        </span>
        {view.live ? (
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-info">
            {view.paused ? "paused" : "running"}
          </span>
        ) : view.outcome ? (
          <span
            className={cn(
              "shrink-0 text-[10px] font-medium",
              OUTCOME_TONE_CLASS[view.outcome.tone],
            )}
          >
            {view.outcome.label}
          </span>
        ) : null}
        {view.live ? (
          <LiveDuration
            className="shrink-0 text-[10.5px] text-muted-foreground/60"
            format={formatBackgroundElapsed}
            startedAtMs={startedAtMs}
            pausedMs={item.pausedMs ?? 0}
            paused={view.paused}
          />
        ) : (
          <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/60">
            {formatBackgroundElapsed(view.elapsedMs)}
          </span>
        )}
        {view.live && view.taskId !== null && onStop ? (
          <button
            type="button"
            onClick={() => onStop(item)}
            className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-destructive opacity-0 transition-opacity group-hover/bg-process:opacity-100 focus-visible:opacity-100"
          >
            Stop
          </button>
        ) : null}
      </div>

      {isMonitorRow ? (
        <MonitorLine view={view} command={view.command} />
      ) : view.variant === "deadline" ? (
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border/60"
          >
            <span
              className="block h-full rounded-full bg-info/70"
              style={{ width: `${Math.round((view.deadlineFraction ?? 0) * 100)}%` }}
            />
          </span>
          <span className="shrink-0 text-[10.5px] text-muted-foreground/50">
            no output until it exits
          </span>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground/50">
            {view.tail ?? (view.live ? "no output yet" : "no output")}
            {view.outputTruncated ? " · output capped" : ""}
          </span>
          {view.live && view.sinceOutputMs !== null ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">
              {formatBackgroundSinceOutput(view.sinceOutputMs)}
            </span>
          ) : null}
        </div>
      )}

      {monitorView !== null ? (
        <div className="ml-3 min-w-0 border-l border-border/50 pl-2">
          <MonitorLine view={monitorView} command={monitorView.command} folded />
        </div>
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
  view,
  command,
  folded,
}: {
  readonly view: BackgroundProcessView;
  readonly command: string;
  readonly folded?: boolean;
}) {
  const remaining = view.deadlineRemainingMs;
  return (
    <p className="min-w-0 truncate text-[10.5px] text-muted-foreground/50">
      {folded ? "agent is waiting on this" : "the agent is asleep until this passes"}
      {remaining === null ? "" : ` · gives up in ${formatBackgroundElapsed(remaining)}`}
      {folded ? "" : ` · ${command}`}
    </p>
  );
}
