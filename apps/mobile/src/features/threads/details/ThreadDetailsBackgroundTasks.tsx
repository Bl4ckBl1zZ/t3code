import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  backgroundElapsedTickMs,
  formatBackgroundElapsed,
  liveBackgroundProcesses,
  resolveBackgroundProcessView,
  type LiveBackgroundProcess,
} from "@t3tools/shared/backgroundProcess";
import * as DateTime from "effect/DateTime";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useThreadVisibleTurnItems } from "../../../state/use-thread-detail";
import { DetailsDivider, DetailsRow, DetailsSection, DetailsStatusDot } from "./detailsRows";

/** Same ceiling as the ports section, for the same reason. */
const VISIBLE_TASK_LIMIT = 4;

/**
 * Commands that outlived the tool call which launched them — `Bash` with
 * `run_in_background`, and the monitors that wait on them.
 *
 * Mirrors the desktop panel's Background Tasks section: it exists for the
 * reader who has scrolled away from the transcript, so "something is still
 * running" stays reachable. Renders nothing when nothing is running.
 */
export function ThreadDetailsBackgroundTasks(props: {
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

  const visible = processes.slice(0, VISIBLE_TASK_LIMIT);

  return (
    <DetailsSection
      title="Background Tasks"
      footer={
        processes.length > VISIBLE_TASK_LIMIT
          ? `+${processes.length - VISIBLE_TASK_LIMIT} more`
          : null
      }
    >
      {visible.map((process, index) => (
        <View key={process.item.id}>
          {index > 0 ? <DetailsDivider /> : null}
          <BackgroundTaskRow process={process} />
        </View>
      ))}
    </DetailsSection>
  );
}

function BackgroundTaskRow(props: { readonly process: LiveBackgroundProcess }) {
  const item = props.process.item;
  const nowMs = Date.now();
  const view = resolveBackgroundProcessView(item, nowMs);
  const startedAtMs = item.startedAt === null ? nowMs : DateTime.toEpochMillis(item.startedAt);
  const isMonitorRow = view.variant === "monitor";
  const monitor = props.process.monitor;
  const subtitle = isMonitorRow
    ? "the agent is asleep until this passes"
    : [
        view.tail ?? "no output yet",
        view.outputTruncated ? "output capped" : null,
        monitor === null ? null : "the agent is waiting on it",
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <DetailsRow
      leading={
        <View className="h-9 w-9 items-center justify-center">
          {/* `bg-info` on the web; here the same "a command is running" blue the
              composer strip paints, dimmed while paused. */}
          <DetailsStatusDot className={view.paused ? "bg-sky-500 opacity-50" : "bg-sky-500"} />
        </View>
      }
      title={isMonitorRow ? "Waiting on a condition" : view.command}
      titleMono={!isMonitorRow}
      subtitle={subtitle}
      detail={
        <LiveDuration
          format={
            isMonitorRow && item.timeoutMs !== undefined
              ? (elapsedMs) =>
                  `${formatBackgroundElapsed(Math.max(0, (item.timeoutMs ?? 0) - elapsedMs))} left`
              : formatBackgroundElapsed
          }
          paused={view.paused}
          pausedMs={item.pausedMs ?? 0}
          startedAtMs={startedAtMs}
        />
      }
    />
  );
}

/**
 * Self-ticking elapsed time. The live set does not change while a command runs,
 * so a value rendered once by the parent would sit frozen.
 */
function LiveDuration(props: {
  readonly format: (elapsedMs: number) => string;
  readonly paused: boolean;
  readonly pausedMs: number;
  readonly startedAtMs: number;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const elapsedMs = Math.max(0, nowMs - props.startedAtMs - props.pausedMs);
  // Tick cadence matched to the precision on screen — no wasted renders.
  const tickMs = backgroundElapsedTickMs(elapsedMs);

  useEffect(() => {
    if (props.paused) return;
    const interval = setInterval(() => setNowMs(Date.now()), tickMs);
    return () => clearInterval(interval);
    // Re-arms when the cadence coarsens past the ten-minute mark.
  }, [props.paused, tickMs]);

  return (
    <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">
      {props.format(elapsedMs)}
    </Text>
  );
}
