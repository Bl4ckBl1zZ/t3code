import * as Haptics from "expo-haptics";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AgentOrb } from "../../components/AgentOrb";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ShimmerText } from "../../components/ShimmerText";
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
  neutral: "text-foreground-muted",
  success: "text-emerald-700 dark:text-emerald-300",
  danger: "text-red-600 dark:text-red-400",
} as const;

export type RelatedThreadCardChrome = "card" | "bare";

/**
 * Shared by the standalone card and the grouped container so a merged run keeps
 * exactly the radius and fill a single card would have had.
 */
export const RELATED_THREAD_CARD_SURFACE_CLASS =
  "mb-4 overflow-hidden rounded-[16px] border-continuous bg-card";

function RelatedThreadCard(props: {
  readonly presentation: Extract<LifecyclePresentation, { kind: "related-thread" }>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly chrome: RelatedThreadCardChrome;
}) {
  const navigation = useNavigation();
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const presentation = props.presentation;
  const canOpen = props.threadId !== null;

  return (
    <View className={props.chrome === "bare" ? undefined : RELATED_THREAD_CARD_SURFACE_CLASS}>
      <Pressable
        accessibilityLabel={
          canOpen ? `Open ${presentation.title}` : `${presentation.title} details`
        }
        accessibilityRole="button"
        className="flex-row items-center gap-3 px-3.5 py-3"
        disabled={!canOpen}
        onPress={() => {
          if (props.threadId === null) return;
          void Haptics.selectionAsync();
          navigation.navigate("Thread", {
            environmentId: props.environmentId,
            threadId: props.threadId,
          });
        }}
      >
        {presentation.orbSeed !== null ? (
          <AgentOrb seed={presentation.orbSeed} size={26} state={presentation.orbState ?? "done"} />
        ) : (
          <SymbolView
            name={presentation.symbol}
            size={16}
            tintColor={iconSubtle}
            type="monochrome"
          />
        )}
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2">
            <Text
              className="min-w-0 shrink font-t3-medium text-base text-foreground"
              numberOfLines={1}
            >
              {presentation.title}
            </Text>
            <Text
              className={cn(
                "font-t3-bold text-2xs tracking-wide",
                BADGE_TONE_CLASS[presentation.badgeTone],
              )}
            >
              {presentation.badge.toUpperCase()}
            </Text>
          </View>
          {/* Strictly one line: a fan-out of agents is scanned, not read, and a
              card that grows a second line for one agent breaks the column. */}
          {presentation.detail ? (
            presentation.orbState === "active" ? (
              <ShimmerText className="mt-0.5 text-sm text-foreground-muted" numberOfLines={1}>
                {presentation.detail}
              </ShimmerText>
            ) : (
              <Text className="mt-0.5 text-sm text-foreground-muted" numberOfLines={1}>
                {presentation.detail}
              </Text>
            )
          ) : null}
        </View>
        {canOpen ? (
          <SymbolView name="chevron.right" size={12} tintColor={iconSubtle} type="monochrome" />
        ) : null}
      </Pressable>
    </View>
  );
}

/**
 * First-class timeline row for a V2 lifecycle item: system dividers (interrupt
 * request/result, compaction, handoff, fork) and related-thread cards (thread
 * created, subagent). Mobile counterpart to the web timeline's V2LifecycleRow.
 */
export function ThreadLifecycleRow(props: {
  readonly entry: LifecycleEntry;
  readonly environmentId: EnvironmentId;
  /** `bare` drops the card surface so a merged group can supply its own. */
  readonly chrome?: RelatedThreadCardChrome;
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
  return (
    <RelatedThreadCard
      chrome={props.chrome ?? "card"}
      environmentId={props.environmentId}
      presentation={presentation}
      threadId={threadId}
    />
  );
}
