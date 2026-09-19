import type {
  EnvironmentId,
  OrchestrationV2CommandExecutionItem,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatBackgroundElapsed,
  formatBackgroundSinceOutput,
  liveBackgroundProcesses,
  resolveBackgroundProcessView,
  type BackgroundProcessView,
  type LiveBackgroundProcess,
} from "@t3tools/shared/backgroundProcess";
import * as DateTime from "effect/DateTime";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import { useThreadVisibleTurnItems } from "../../../state/use-thread-detail";
import {
  BackgroundProcessElapsed,
  LiveDuration,
  backgroundProcessStartedAtMs,
} from "../BackgroundProcessElapsed";
import { DetailsDivider, DetailsRow, DetailsSection } from "./detailsRows";

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

const LINE_CLASS = "text-xs leading-snug text-foreground-muted";
const DETAIL_CLASS = "shrink-0 text-2xs text-foreground-muted";

/**
 * One live background command, drawn the way the timeline draws a tool row:
 * a muted terminal glyph, the command, and its running time. The line under it
 * says what it is doing right now.
 */
function BackgroundTaskRow(props: { readonly process: LiveBackgroundProcess }) {
  const iconSubtleColor = String(useThemeColor("--color-icon-subtle"));
  const { item, monitor } = props.process;
  const view = resolveBackgroundProcessView(item, Date.now());
  const isMonitorRow = view.variant === "monitor";
  const timeoutMs = item.timeoutMs;

  return (
    <DetailsRow
      icon="terminal"
      iconTint={iconSubtleColor}
      title={isMonitorRow ? "Waiting for a condition" : view.command}
      subtitle={
        <View>
          <Text className={LINE_CLASS} numberOfLines={2}>
            <BackgroundTaskStatusLine item={item} view={view} />
          </Text>
          {monitor === null ? null : (
            <Text className={LINE_CLASS} numberOfLines={1}>
              Agent is waiting on this
              <GivesUpIn monitor={monitor} />
            </Text>
          )}
        </View>
      }
      detail={
        isMonitorRow && timeoutMs !== undefined ? (
          <LiveDuration
            className={DETAIL_CLASS}
            format={(elapsedMs) =>
              `${formatBackgroundElapsed(Math.max(0, timeoutMs - elapsedMs))} left`
            }
            paused={view.paused}
            pausedMs={item.pausedMs ?? 0}
            startedAtMs={backgroundProcessStartedAtMs(item)}
          />
        ) : (
          <BackgroundProcessElapsed className={DETAIL_CLASS} item={item} view={view} />
        )
      }
    />
  );
}

/**
 * What the command is doing right now: its last line of output and how long
 * since that moved, which is the difference between working and wedged.
 */
function BackgroundTaskStatusLine(props: {
  readonly item: OrchestrationV2CommandExecutionItem;
  readonly view: BackgroundProcessView;
}) {
  const { item, view } = props;
  if (view.variant === "monitor") {
    // The countdown is already the row's trailing detail.
    return "Agent is asleep until this passes";
  }
  if (view.variant === "deadline") {
    return "No output until it exits";
  }
  const lastOutputAtMs =
    item.lastOutputAt === undefined ? null : DateTime.toEpochMillis(item.lastOutputAt);
  return (
    <>
      {view.tail === null ? (
        "No output yet"
      ) : (
        <Text className="font-mono text-foreground-muted">{view.tail}</Text>
      )}
      {view.outputTruncated ? " · output capped" : null}
      {lastOutputAtMs === null ? null : (
        <>
          {" · "}
          <LiveDuration
            className="text-foreground-muted"
            format={formatBackgroundSinceOutput}
            paused={false}
            pausedMs={0}
            startedAtMs={lastOutputAtMs}
          />
        </>
      )}
    </>
  );
}

/** The deadline a monitor gives up at, the one number about a wait that is real. */
function GivesUpIn(props: { readonly monitor: OrchestrationV2CommandExecutionItem }) {
  const timeoutMs = props.monitor.timeoutMs;
  if (timeoutMs === undefined) return null;
  return (
    <>
      {" · gives up in "}
      <LiveDuration
        className="text-foreground-muted"
        format={(elapsedMs) => formatBackgroundElapsed(Math.max(0, timeoutMs - elapsedMs))}
        paused={false}
        pausedMs={0}
        startedAtMs={backgroundProcessStartedAtMs(props.monitor)}
      />
    </>
  );
}
