import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { automationStatusDotClass, automationSubtitle } from "./scheduledTaskLabels";

function reportFailure(title: string, failure: unknown) {
  Alert.alert(title, failure instanceof Error ? failure.message : String(failure));
}

/**
 * One scheduled task: status dot + title + schedule subtitle, with inline
 * run-now and enable controls. Used by both the settings list and the
 * thread-bound section so the two surfaces cannot drift.
 */
export function AutomationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly compact?: boolean;
  readonly onPress?: () => void;
  readonly onLongPress?: () => void;
}) {
  const accent = useThemeColor("--color-primary");
  const [busy, setBusy] = useState(false);

  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "automation toggle",
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "automation run now",
  });

  const toggle = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    // Partial update: only the enabled flag changes, so a toggle can never
    // revert concurrent edits made to the task elsewhere.
    const result = await setEnabled({
      environmentId: props.environmentId,
      input: { id: props.task.id, enabled },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update automation", squashAtomCommandFailure(result));
    }
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    const result = await runNow({
      environmentId: props.environmentId,
      input: { id: props.task.id },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run automation", squashAtomCommandFailure(result));
    }
  };

  const running = props.task.lastRunStatus === "running";

  return (
    <Pressable
      accessibilityRole={props.onPress ? "button" : undefined}
      className={cn("flex-row items-center gap-3", props.compact ? "px-4 py-2.5" : "p-4")}
      disabled={props.onPress === undefined && props.onLongPress === undefined}
      onLongPress={props.onLongPress}
      onPress={props.onPress}
    >
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <View
            className={cn(
              "h-2 w-2 rounded-full",
              automationStatusDotClass(props.task.lastRunStatus),
            )}
          />
          <Text
            className={cn(
              "shrink text-foreground",
              props.compact ? "text-base font-t3-medium" : "text-lg",
            )}
            numberOfLines={1}
          >
            {props.task.title}
          </Text>
        </View>
        <Text className="mt-0.5 text-sm text-foreground-muted" numberOfLines={1}>
          {automationSubtitle(props.task, Date.now())}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={`Run ${props.task.title} now`}
        accessibilityRole="button"
        className={cn("rounded-full bg-subtle px-3.5 py-1.5", (busy || running) && "opacity-40")}
        disabled={busy || running}
        hitSlop={6}
        onPress={() => void run()}
      >
        <Text className="text-sm font-t3-semibold" style={{ color: accent }}>
          Run
        </Text>
      </Pressable>
      <ThemedSwitch
        accessibilityLabel={
          props.task.enabled ? `Pause ${props.task.title}` : `Resume ${props.task.title}`
        }
        disabled={busy}
        value={props.task.enabled}
        onValueChange={(enabled) => void toggle(enabled)}
      />
    </Pressable>
  );
}
