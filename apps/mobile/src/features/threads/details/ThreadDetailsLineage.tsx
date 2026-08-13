import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AgentOrb } from "../../../components/AgentOrb";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  relationshipLabel,
  relationshipSymbol,
  subagentEdgeOrbState,
  threadAvailability,
  useThreadRelationshipRows,
  type ThreadRelationshipRow,
} from "../useThreadRelationshipRows";
import { DetailsDivider, DetailsRow, DetailsSection } from "./detailsRows";

/**
 * The thread's parents, forks, transfers, and subagents, plus the merge-back
 * and detach actions the desktop panel offers on the same rows.
 *
 * Heading follows the desktop panel: "Lineage" when anything other than a
 * subagent child is listed, otherwise "Subagents".
 */
export function ThreadDetailsLineage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onNavigate: () => void;
}) {
  const {
    archivedRows,
    canDetach,
    canMerge,
    graph,
    latestMergeBackRun,
    mergeTargetThreadId,
    rows,
    visibleRows,
  } = useThreadRelationshipRows(props);
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon-subtle");
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, "merge thread back");
  const stopSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  if (rows.length === 0 && !canDetach) return null;

  const openThread = (threadId: ThreadId, archivedThread: boolean) => {
    void Haptics.selectionAsync();
    props.onNavigate();
    if (archivedThread) {
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsArchive" },
      });
      return;
    }
    navigation.navigate("Thread", { environmentId: props.environmentId, threadId });
  };

  const merge = async () => {
    if (!canMerge || mergeTargetThreadId === null || latestMergeBackRun === null) return;
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: mergeTargetThreadId,
        runId: latestMergeBackRun.id,
        creationSource: "mobile",
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") openThread(mergeTargetThreadId, false);
  };

  const detach = async () => {
    if (!canDetach) return;
    setBusyAction("detach");
    await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setBusyAction(null);
  };

  const renderRow = ({ threadId, edge }: ThreadRelationshipRow) => {
    const node = graph.nodes.get(threadId);
    const availability = threadAvailability(node?.thread ?? null, node?.missing ?? true);
    const archivedThread = availability === "Archived";
    const disabled = availability === "Unavailable" || availability === "Deleted";
    return (
      <DetailsRow
        detail={
          availability ? (
            <Text className="text-2xs text-foreground-muted">{availability}</Text>
          ) : undefined
        }
        disabled={disabled}
        icon={relationshipSymbol(edge)}
        leading={
          edge.kind === "subagent" ? (
            <View className="h-9 w-9 items-center justify-center">
              <AgentOrb seed={threadId} size={32} state={subagentEdgeOrbState(edge.status)} />
            </View>
          ) : undefined
        }
        onPress={() => openThread(threadId, archivedThread)}
        showChevron={availability === null}
        subtitle={relationshipLabel(edge, props.threadId)}
        title={node?.thread?.title ?? threadId}
      />
    );
  };

  // "Lineage" only earns its name when something other than this thread's own
  // subagents is listed; otherwise the section is exactly a list of subagents.
  const title = rows.some(({ edge }) => edge.kind !== "subagent") ? "Lineage" : "Subagents";

  return (
    <DetailsSection title={title}>
      {visibleRows.map((row, index) => (
        <View key={`${row.edge.kind}:${row.threadId}`}>
          {index > 0 ? <DetailsDivider /> : null}
          {renderRow(row)}
        </View>
      ))}

      {archivedRows.length > 0 ? (
        <>
          {visibleRows.length > 0 ? <DetailsDivider /> : null}
          <Pressable
            accessibilityLabel={`${archivedRows.length} finished ${archivedRows.length === 1 ? "subagent" : "subagents"}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: showArchived }}
            className="min-h-11 flex-row items-center gap-2 px-3 py-2"
            onPress={() => {
              void Haptics.selectionAsync();
              setShowArchived((value) => !value);
            }}
          >
            <Text className="font-t3-medium text-xs text-foreground-muted">
              Done · {archivedRows.length}
            </Text>
            <View className="flex-1" />
            <SymbolView
              name={showArchived ? "chevron.up" : "chevron.down"}
              size={11}
              tintColor={iconColor}
              type="monochrome"
            />
          </Pressable>
          {showArchived
            ? archivedRows.map((row) => (
                <View key={`${row.edge.kind}:${row.threadId}`}>
                  <DetailsDivider />
                  {renderRow(row)}
                </View>
              ))
            : null}
        </>
      ) : null}

      {canMerge ? (
        <>
          <DetailsDivider />
          <DetailsRow
            disabled={busyAction !== null}
            icon="arrow.triangle.merge"
            onPress={() => void merge()}
            showChevron={false}
            title="Merge back to source"
            trailing={busyAction === "merge" ? <ActivityIndicator /> : undefined}
          />
        </>
      ) : null}

      {canDetach ? (
        <>
          <DetailsDivider />
          <DetailsRow
            disabled={busyAction !== null}
            icon="bolt.slash"
            onPress={() => void detach()}
            showChevron={false}
            title="Disconnect agent session"
            trailing={busyAction === "detach" ? <ActivityIndicator /> : undefined}
          />
        </>
      ) : null}
    </DetailsSection>
  );
}
