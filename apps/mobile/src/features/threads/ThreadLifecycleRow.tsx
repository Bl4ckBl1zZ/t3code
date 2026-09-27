import * as Haptics from "expo-haptics";
import {
  subagentGroupTiming,
  summarizeSubagentStatuses,
} from "@t3tools/client-runtime/state/subagent-display";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AgentOrb } from "../../components/AgentOrb";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  resolveLifecyclePresentation,
  type LifecyclePresentation,
  type LifecycleTimelineRun,
} from "../../lib/threadLifecycle";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadProjection } from "../../state/use-thread-detail";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { WorkRowStatusGlyph } from "./thread-work-log";

type LifecycleEntry = Extract<ThreadFeedEntry, { type: "lifecycle" }>;

/**
 * Spacing around related-thread rows in the feed. A merged run shares one
 * wrapper so its rows stack as tightly as a work log's.
 */
export const RELATED_THREAD_ROWS_CLASS = "-mx-1 mb-3 gap-px px-1";

/**
 * A subagent or created thread, drawn as an ordinary tool row: orb or icon,
 * the agent's name with its task muted after it, the latest progress or result
 * underneath, and a status glyph. Tapping opens the thread.
 */
function RelatedThreadRow(props: {
  readonly presentation: Extract<LifecyclePresentation, { kind: "related-thread" }>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const navigation = useNavigation();
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const pressedBackground = String(useThemeColor("--color-subtle"));
  const presentation = props.presentation;
  const canOpen = props.threadId !== null;
  const description = [
    presentation.title,
    presentation.preview,
    presentation.meta,
    presentation.status,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      accessibilityLabel={canOpen ? `Open ${description}` : description}
      accessibilityRole={canOpen ? "button" : undefined}
      className="rounded-md px-0.5 py-0.5"
      disabled={!canOpen}
      hitSlop={4}
      onPress={() => {
        if (props.threadId === null) return;
        void Haptics.selectionAsync();
        navigation.navigate("Thread", {
          environmentId: props.environmentId,
          threadId: props.threadId,
        });
      }}
      style={({ pressed }) => ({ backgroundColor: pressed ? pressedBackground : "transparent" })}
    >
      <View className="min-h-9 flex-row items-center gap-1.5">
        <View className="h-5 w-5 shrink-0 items-center justify-center">
          {presentation.orbSeed !== null ? (
            <AgentOrb
              seed={presentation.orbSeed}
              size={16}
              state={presentation.orbState ?? "done"}
            />
          ) : (
            <SymbolView
              name={presentation.symbol}
              size={14}
              tintColor={iconSubtle}
              type="monochrome"
              weight="medium"
            />
          )}
        </View>
        <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
          <Text className="font-t3-medium text-foreground">{presentation.title}</Text>
          {presentation.preview ? (
            <Text className="text-foreground-muted opacity-60"> {presentation.preview}</Text>
          ) : null}
        </Text>
        <View className="shrink-0 flex-row items-center gap-px">
          {presentation.meta ? (
            <Text className="pr-1 text-2xs text-foreground-muted">{presentation.meta}</Text>
          ) : null}
          <WorkRowStatusGlyph iconSubtleColor={iconSubtle} status={presentation.status} />
          {canOpen ? (
            <View className="h-4 w-4 items-center justify-center">
              <SymbolView name="chevron.right" size={11} tintColor={iconSubtle} type="monochrome" />
            </View>
          ) : null}
        </View>
      </View>
      {/* Strictly one line: a fan-out of agents is scanned, not read. Plain
          text even while the agent runs, since that can be minutes. */}
      {presentation.detail ? (
        <Text className="-mt-1.5 pb-1 pl-6.5 text-2xs text-foreground-muted" numberOfLines={1}>
          {presentation.detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * First-class timeline row for a V2 lifecycle item: system dividers (interrupt
 * request/result, compaction, handoff, fork) and related-thread rows (thread
 * created, subagent). Mobile counterpart to the web timeline's V2LifecycleRow.
 */
export function ThreadLifecycleRow(props: {
  readonly entry: LifecycleEntry;
  readonly environmentId: EnvironmentId;
  /** Drops the row's own spacing so a merged run can supply it once. */
  readonly grouped?: boolean;
}) {
  const navigation = useNavigation();
  const row = props.entry.row;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
  });
  const scoped = useThreadProjection({
    environmentId: props.environmentId,
    threadId: row.item.threadId,
  });
  const runs = useMemo<ReadonlyArray<LifecycleTimelineRun>>(
    () =>
      (scoped?.projection.runs ?? []).map((run) => ({
        id: run.id,
        ordinal: run.ordinal,
        providerInstanceId: run.providerInstanceId,
        model: run.modelSelection.model,
      })),
    [scoped],
  );

  const presentation = resolveLifecyclePresentation(row.item, runs);
  if (presentation === null) return null;

  if (presentation.kind === "divider") {
    const openThreadId = presentation.openThreadId;
    return (
      <TimelineSystemDivider
        label={presentation.label}
        detail={presentation.detail}
        tone={presentation.tone}
        symbol={presentation.symbol}
        layout={presentation.layout}
        busy={presentation.busy}
        actionLabel={presentation.actionLabel}
        onAction={
          openThreadId === null
            ? undefined
            : () => {
                void Haptics.selectionAsync();
                navigation.navigate("Thread", {
                  environmentId: props.environmentId,
                  threadId: openThreadId,
                });
              }
        }
      />
    );
  }

  // Live projection support beats the item snapshot for the child thread id:
  // provider-native subagents backfill it after the item is first persisted.
  const threadId =
    row.item.type === "subagent"
      ? (support.subagent?.childThreadId ?? presentation.threadId)
      : presentation.threadId;
  const relatedRow = (
    <RelatedThreadRow
      environmentId={props.environmentId}
      presentation={presentation}
      threadId={threadId}
    />
  );
  return props.grouped === true ? (
    relatedRow
  ) : (
    <View className={RELATED_THREAD_ROWS_CLASS}>{relatedRow}</View>
  );
}

type SubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

const SUBAGENT_GROUP_VISIBLE_ORBS = 3;

/** Wall time of a settled group; a live group's header already says it is working. */
function settledGroupDuration(items: ReadonlyArray<SubagentItem>): string | null {
  const timing = subagentGroupTiming(items);
  if (timing.startedAt === null || timing.completedAt === null) return null;
  const duration = Date.parse(timing.completedAt) - Date.parse(timing.startedAt);
  return duration > 0 ? formatDuration(duration) : null;
}

/**
 * A turn's adjacent subagents as one collapsible card: a header that stacks
 * their orbs and counts their states, and the ordinary rows once expanded.
 * Expansion lives in the feed's state so it survives list recycling.
 */
export function SubagentLifecycleGroup(props: {
  readonly entries: ReadonlyArray<LifecycleEntry>;
  readonly items: ReadonlyArray<SubagentItem>;
  readonly environmentId: EnvironmentId;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const label = `${props.items.length} subagents`;
  const summary = summarizeSubagentStatuses(props.items.map((item) => item.status));
  const active = props.items.some((item) => isOrchestrationV2WorkActive(item.status));
  const failed = props.items.some((item) => item.status === "failed");
  const duration = active ? null : settledGroupDuration(props.items);
  return (
    <View className="-mx-1 mb-3 px-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${summary}`}
        accessibilityState={{ expanded: props.expanded }}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        className="min-h-11 flex-row items-center gap-2.5 rounded-md px-0.5 py-1.5 active:bg-subtle"
      >
        <View accessible={false} className="flex-row items-center">
          {props.items.slice(0, SUBAGENT_GROUP_VISIBLE_ORBS).map((item, index) => {
            const presentation = resolveLifecyclePresentation(item, []);
            return (
              <View key={item.id} style={{ marginLeft: index === 0 ? 0 : -4 }}>
                <AgentOrb
                  seed={
                    presentation?.kind === "related-thread" && presentation.orbSeed !== null
                      ? presentation.orbSeed
                      : item.subagentId
                  }
                  size={16}
                  state={
                    (presentation?.kind === "related-thread" ? presentation.orbState : null) ??
                    "done"
                  }
                />
              </View>
            );
          })}
          {props.items.length > SUBAGENT_GROUP_VISIBLE_ORBS ? (
            <Text className="pl-1.5 text-2xs tabular-nums text-foreground-muted">
              +{props.items.length - SUBAGENT_GROUP_VISIBLE_ORBS}
            </Text>
          ) : null}
        </View>
        <Text className="min-w-0 flex-1 text-xs" numberOfLines={1}>
          <Text className="font-t3-medium text-foreground">{label}</Text>
          <Text
            className={cn(
              "text-2xs",
              active
                ? "text-sky-600 dark:text-sky-400"
                : failed
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-foreground-muted",
            )}
          >
            {"  "}
            {summary}
          </Text>
        </Text>
        {duration ? (
          <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">{duration}</Text>
        ) : null}
        <SymbolView
          name={props.expanded ? "chevron.up" : "chevron.down"}
          size={11}
          tintColor={iconSubtle}
          type="monochrome"
        />
      </Pressable>
      {props.expanded ? (
        <View className="mt-1 gap-px rounded-xl border border-neutral-300/50 p-1 dark:border-white/[0.08]">
          {props.entries.map((entry) => (
            <ThreadLifecycleRow
              key={entry.id}
              entry={entry}
              environmentId={props.environmentId}
              grouped
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
