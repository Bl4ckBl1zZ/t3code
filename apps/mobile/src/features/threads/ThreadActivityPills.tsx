import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatBackgroundElapsed,
  liveBackgroundProcesses,
  summarizeBackgroundProcesses,
} from "@t3tools/shared/backgroundProcess";
import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AgentOrb } from "../../components/AgentOrb";
import { AppText as Text } from "../../components/AppText";
import { subagentOrbSeed, workingSubagents } from "../../lib/threadLifecycle";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { LiveDuration } from "./BackgroundProcessElapsed";

/** Past this many the stack stops being countable at a glance; the label carries the rest. */
const VISIBLE_ORB_LIMIT = 3;

const PILL_CLASS_NAME =
  "flex-row items-center gap-2 rounded-full border border-neutral-300/60 bg-card px-3 py-1.5 active:opacity-70 dark:border-white/[0.1]";

/**
 * Pills above the composer while this thread has subagents working or
 * background commands running — the phone's counterpart of the desktop pills
 * beside the working-tree status. Tapping either opens thread details, where
 * the lineage and background tasks sections list them; a popover on a phone
 * would fight the keyboard for the same space.
 *
 * Sits in the composer overlay's flow rather than floating over the transcript,
 * so the list's bottom inset grows with it and it never covers the latest line.
 */
export function ThreadActivityPills(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const items = useThreadVisibleTurnItems({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const agents = useMemo(() => workingSubagents(items), [items]);
  const processes = useMemo(() => liveBackgroundProcesses(items), [items]);
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon-subtle");

  const background = summarizeBackgroundProcesses(processes, Date.now());
  if (agents.length === 0 && background === null) return null;

  const openDetails = () => {
    void Haptics.selectionAsync();
    navigation.navigate("ThreadDetails", {
      environmentId: String(props.environmentId),
      threadId: String(props.threadId),
    });
  };
  const agentsLabel = `${agents.length} ${agents.length === 1 ? "agent" : "agents"} working`;

  return (
    <View className="mb-2 flex-row flex-wrap justify-center gap-2">
      {agents.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${agentsLabel}. Show thread details`}
          onPress={openDetails}
          className={PILL_CLASS_NAME}
        >
          <View className="flex-row">
            {agents.slice(0, VISIBLE_ORB_LIMIT).map((item, index) => (
              // The card-coloured rim cuts each orb out of the one behind it.
              <View
                key={item.id}
                className="rounded-full bg-card p-px"
                style={index === 0 ? undefined : { marginLeft: -5 }}
              >
                <AgentOrb seed={subagentOrbSeed(item)} size={16} />
              </View>
            ))}
          </View>
          <Text className="text-xs tabular-nums text-foreground-muted">{agentsLabel}</Text>
        </Pressable>
      ) : null}
      {background !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${background.accessibilityLabel}. Show thread details`}
          onPress={openDetails}
          className={PILL_CLASS_NAME}
        >
          <SymbolView
            name={{ ios: "terminal", android: "terminal" }}
            size={13}
            tintColor={iconColor}
            type="monochrome"
          />
          <Text className="text-xs tabular-nums text-foreground-muted">{background.label}</Text>
          <LiveDuration
            className="text-xs text-foreground-tertiary"
            format={formatBackgroundElapsed}
            paused={background.paused}
            pausedMs={background.pausedMs}
            startedAtMs={background.startedAtMs}
          />
        </Pressable>
      ) : null}
    </View>
  );
}
