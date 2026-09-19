import type { OrchestrationV2CommandExecutionItem } from "@t3tools/contracts";
import {
  backgroundElapsedTickMs,
  formatBackgroundElapsed,
  type BackgroundProcessView,
} from "@t3tools/shared/backgroundProcess";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

export function backgroundProcessStartedAtMs(item: OrchestrationV2CommandExecutionItem): number {
  return item.startedAt === null ? Date.now() : DateTime.toEpochMillis(item.startedAt);
}

/**
 * Self-ticking duration. Nothing else re-renders a running background command's
 * row, so a value rendered once by the parent would sit frozen. Ticks at the
 * precision on screen, so past ten minutes it renders once every 30s.
 *
 * Safe to nest inside another Text; pass a colour, since AppText resets it.
 */
export function LiveDuration(props: {
  readonly className?: string;
  readonly format: (elapsedMs: number) => string;
  readonly paused: boolean;
  readonly pausedMs: number;
  readonly startedAtMs: number;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const elapsedMs = Math.max(0, nowMs - props.startedAtMs - props.pausedMs);
  const tickMs = backgroundElapsedTickMs(elapsedMs);

  useEffect(() => {
    if (props.paused) return;
    const interval = setInterval(() => setNowMs(Date.now()), tickMs);
    return () => clearInterval(interval);
    // Re-arms when the cadence coarsens past the ten-minute mark.
  }, [props.paused, tickMs]);

  return <Text className={cn("tabular-nums", props.className)}>{props.format(elapsedMs)}</Text>;
}

function formatPausedElapsed(elapsedMs: number): string {
  return `Paused · ${formatBackgroundElapsed(elapsedMs)}`;
}

/** Running time: ticking while live, frozen at the final duration once settled. */
export function BackgroundProcessElapsed(props: {
  readonly item: OrchestrationV2CommandExecutionItem;
  readonly view: BackgroundProcessView;
  readonly className: string;
}) {
  if (!props.view.live) {
    return (
      <Text className={cn("tabular-nums", props.className)}>
        {formatBackgroundElapsed(props.view.elapsedMs)}
      </Text>
    );
  }
  return (
    <LiveDuration
      className={props.className}
      format={props.view.paused ? formatPausedElapsed : formatBackgroundElapsed}
      paused={props.view.paused}
      pausedMs={props.item.pausedMs ?? 0}
      startedAtMs={backgroundProcessStartedAtMs(props.item)}
    />
  );
}
