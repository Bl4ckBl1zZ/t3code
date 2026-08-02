import * as Haptics from "expo-haptics";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

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

type LifecycleEntry = Extract<ThreadFeedEntry, { type: "lifecycle" }>;

const BADGE_TONE_CLASS = {
  neutral: "border-neutral-300/60 bg-neutral-500/10 text-foreground-muted dark:border-white/[0.12]",
  success:
    "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:text-emerald-300",
  danger: "border-red-500/25 bg-red-500/10 text-red-600 dark:border-red-400/25 dark:text-red-400",
} as const;

function RelatedThreadCard(props: {
  readonly presentation: Extract<LifecyclePresentation, { kind: "related-thread" }>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const navigation = useNavigation();
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const [expanded, setExpanded] = useState(false);
  const presentation = props.presentation;
  const canOpen = props.threadId !== null;
  const canExpand = presentation.expandedDetail !== null;

  return (
    <View className="mb-4 overflow-hidden rounded-[16px] border-continuous bg-card">
      <Pressable
        accessibilityLabel={
          canOpen ? `Open ${presentation.title}` : `${presentation.title} details`
        }
        accessibilityRole="button"
        className="flex-row items-center gap-3 px-3.5 py-3"
        disabled={!canOpen && !canExpand}
        onPress={() => {
          if (canExpand && !canOpen) {
            setExpanded((current) => !current);
            return;
          }
          if (props.threadId === null) return;
          void Haptics.selectionAsync();
          navigation.navigate("Thread", {
            environmentId: props.environmentId,
            threadId: props.threadId,
          });
        }}
        onLongPress={canExpand ? () => setExpanded((current) => !current) : undefined}
      >
        <SymbolView name={presentation.symbol} size={16} tintColor={iconSubtle} type="monochrome" />
        <View className="min-w-0 flex-1">
          <Text className="font-t3-medium text-base text-foreground" numberOfLines={1}>
            {presentation.title}
          </Text>
          {presentation.detail ? (
            <Text
              className="mt-0.5 text-sm text-foreground-muted"
              numberOfLines={expanded ? undefined : 2}
            >
              {presentation.detail}
            </Text>
          ) : null}
        </View>
        <View
          className={cn(
            "rounded-full border px-2 py-0.5",
            BADGE_TONE_CLASS[presentation.badgeTone],
          )}
        >
          <Text className="font-t3-medium text-2xs tracking-wide">{presentation.badge}</Text>
        </View>
        {canOpen ? (
          <SymbolView name="chevron.right" size={12} tintColor={iconSubtle} type="monochrome" />
        ) : null}
      </Pressable>
      {expanded && presentation.expandedDetail ? (
        <View className="border-t border-neutral-300/40 px-3.5 py-3 dark:border-white/[0.06]">
          <Text className="text-sm text-foreground-muted">{presentation.expandedDetail}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * First-class timeline row for a V2 lifecycle item: interrupt lines,
 * system dividers (interrupt result, compaction, handoff, fork), and
 * related-thread cards (thread created, subagent). Mobile counterpart to the
 * web timeline's V2LifecycleRow.
 */
export function ThreadLifecycleRow(props: {
  readonly entry: LifecycleEntry;
  readonly environmentId: EnvironmentId;
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

  if (presentation.kind === "interrupt-request") {
    return (
      <View className="mb-3 flex-row items-center justify-end gap-1.5 px-1">
        <SymbolView name="stop.fill" size={9} tintColor="#ef4444" type="monochrome" />
        <Text className="font-t3-medium text-xs text-red-600 dark:text-red-400" numberOfLines={1}>
          Interrupt requested · {presentation.message}
        </Text>
      </View>
    );
  }

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
  return (
    <RelatedThreadCard
      environmentId={props.environmentId}
      presentation={presentation}
      threadId={threadId}
    />
  );
}
