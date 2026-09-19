import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AgentOrb } from "../../components/AgentOrb";
import { AppText as Text } from "../../components/AppText";
import { subagentOrbSeed, workingSubagents } from "../../lib/threadLifecycle";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";

/** Past this many the stack stops being countable at a glance; the label carries the rest. */
const VISIBLE_ORB_LIMIT = 3;

/**
 * Pill above the composer while this thread has subagents working — the phone's
 * counterpart of the desktop badge beside the working-tree status. Tapping it
 * opens thread details, where the lineage section lists each agent.
 *
 * Sits in the composer overlay's flow rather than floating over the transcript,
 * so the list's bottom inset grows with it and it never covers the latest line.
 */
export function ThreadWorkingAgentsPill(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const items = useThreadVisibleTurnItems({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const working = useMemo(() => workingSubagents(items), [items]);
  const navigation = useNavigation();

  if (working.length === 0) return null;

  const label = `${working.length} ${working.length === 1 ? "agent" : "agents"} working`;

  return (
    <View className="mb-2 items-center">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. Show thread details`}
        onPress={() => {
          void Haptics.selectionAsync();
          navigation.navigate("ThreadDetails", {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
          });
        }}
        className="flex-row items-center gap-2 rounded-full border border-neutral-300/60 bg-card px-3 py-1.5 active:opacity-70 dark:border-white/[0.1]"
      >
        <View className="flex-row">
          {working.slice(0, VISIBLE_ORB_LIMIT).map((item, index) => (
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
        <Text className="text-xs tabular-nums text-foreground-muted">{label}</Text>
      </Pressable>
    </View>
  );
}
