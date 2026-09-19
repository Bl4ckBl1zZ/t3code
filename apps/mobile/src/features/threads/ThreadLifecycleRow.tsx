import * as Haptics from "expo-haptics";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AgentOrb } from "../../components/AgentOrb";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
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
