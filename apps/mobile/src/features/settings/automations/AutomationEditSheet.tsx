import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  ScheduledTask,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { buildModelOptions } from "../../../lib/modelOptions";
import { useThemeColor } from "../../../lib/useThemeColor";
import { useProjects } from "../../../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { isValidTimeOfDay, parseIntervalMinutes } from "./scheduledTaskLabels";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

type ScheduleMode = "fixed" | "interval";

interface Draft {
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
}

const EMPTY_DRAFT: Draft = {
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
};

function draftFromTask(task: ScheduledTask): Draft {
  const schedule = task.schedule;
  return {
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "interval" ? "interval" : "fixed",
    intervalMinutes:
      schedule.type === "interval"
        ? String(Math.max(1, Math.round(schedule.everyMs / 60_000)))
        : "15",
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays:
      schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
        ? new Set(schedule.weekdays)
        : new Set([0, 1, 2, 3, 4, 5, 6]),
    projectId: task.projectId,
  };
}

function draftSchedule(draft: Draft): ScheduledTaskUpsertSchedule | null {
  if (draft.scheduleMode === "interval") {
    const minutes = parseIntervalMinutes(draft.intervalMinutes);
    return minutes === null ? null : { type: "interval", everyMs: minutes * 60_000 };
  }
  if (!isValidTimeOfDay(draft.timeOfDay)) return null;
  if (draft.weekdays.size === 0) return null;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay.trim(),
    weekdays: draft.weekdays.size === 7 ? undefined : [...draft.weekdays].sort((a, b) => a - b),
  };
}

function FieldLabel(props: { readonly children: string }) {
  return (
    <Text className="px-2 text-sm font-t3-medium text-foreground-muted">{props.children}</Text>
  );
}

/**
 * Create/edit form for a scheduled task, presented as a page sheet. Editing
 * only exposes the fields the form renders; launch settings an agent may have
 * set (workspace strategy, model, runtime/interaction modes) are preserved
 * verbatim so a mobile edit can never strip them.
 */
export function AutomationEditSheet(props: {
  readonly visible: boolean;
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const accent = useThemeColor("--color-primary");
  const activeTrack = String(useThemeColor("--color-switch-active"));
  const track = String(useThemeColor("--color-secondary-border"));

  const projects = useProjects();
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === props.environmentId),
    [projects, props.environmentId],
  );
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!props.visible) return;
    setDraft(props.task ? draftFromTask(props.task) : EMPTY_DRAFT);
  }, [props.visible, props.task]);

  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "automation upsert",
  });

  const patch = (partial: Partial<Draft>) => setDraft((current) => ({ ...current, ...partial }));

  const schedule = draftSchedule(draft);
  const selectedProject =
    environmentProjects.find(
      (project) => project.id === (props.task?.projectId ?? draft.projectId),
    ) ?? null;
  const canSave =
    !saving &&
    draft.title.trim().length > 0 &&
    draft.prompt.trim().length > 0 &&
    schedule !== null &&
    (props.task !== null || selectedProject !== null);

  const resolveNewTaskModel = (): ModelSelection | null => {
    if (selectedProject?.defaultModelSelection) return selectedProject.defaultModelSelection;
    const config = serverConfigs.get(props.environmentId) ?? null;
    const options = buildModelOptions(config, null);
    return (options.find((option) => option.isDefault) ?? options[0])?.selection ?? null;
  };

  const save = async () => {
    if (schedule === null) return;
    const common = {
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
    };
    let input: ScheduledTaskUpsertInput;
    if (props.task !== null) {
      input = {
        ...common,
        id: props.task.id,
        projectId: props.task.projectId,
        threadId: props.task.threadId,
        workspaceStrategy: props.task.workspaceStrategy,
        modelSelection: props.task.modelSelection,
        runtimeMode: props.task.runtimeMode,
        interactionMode: props.task.interactionMode,
      };
    } else {
      if (selectedProject === null) return;
      const modelSelection = resolveNewTaskModel();
      if (modelSelection === null) {
        Alert.alert(
          "No model available",
          "Connect and authenticate a provider on this environment first.",
        );
        return;
      }
      input = {
        ...common,
        projectId: selectedProject.id,
        threadId: null,
        workspaceStrategy: { type: "worktree", baseRef: "main" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mobile",
      };
    }
    setSaving(true);
    const result = await upsertTask({ environmentId: props.environmentId, input });
    setSaving(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      Alert.alert(
        "Could not save automation",
        failure instanceof Error ? failure.message : String(failure),
      );
      return;
    }
    props.onClose();
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={props.visible}
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-sheet">
        <View className="flex-row items-center justify-between px-5 py-4">
          <Pressable accessibilityRole="button" hitSlop={8} onPress={props.onClose}>
            <Text className="text-lg" style={{ color: accent }}>
              Cancel
            </Text>
          </Pressable>
          <Text className="text-lg font-t3-semibold text-foreground">
            {props.task ? "Edit Automation" : "New Automation"}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={!canSave}
            hitSlop={8}
            onPress={() => void save()}
          >
            <Text
              className={cn("text-lg font-t3-bold", !canSave && "opacity-40")}
              style={{ color: accent }}
            >
              Save
            </Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerClassName="gap-5 px-5 pt-1"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-2">
            <FieldLabel>Title</FieldLabel>
            <View className="rounded-[18px] border-continuous bg-card px-4 py-3">
              <TextInput
                className="text-lg text-foreground"
                placeholder="Automation title"
                value={draft.title}
                onChangeText={(title) => patch({ title })}
              />
            </View>
          </View>

          <View className="gap-2">
            <FieldLabel>Prompt</FieldLabel>
            <View className="rounded-[18px] border-continuous bg-card px-4 py-3">
              <TextInput
                className="min-h-[88px] text-base text-foreground"
                multiline
                placeholder="What should run on each fire?"
                value={draft.prompt}
                onChangeText={(prompt) => patch({ prompt })}
              />
            </View>
          </View>

          <View className="gap-2">
            <FieldLabel>Schedule</FieldLabel>
            <View className="flex-row gap-2 rounded-full bg-subtle p-1">
              {(["fixed", "interval"] as const).map((mode) => (
                <Pressable
                  key={mode}
                  accessibilityRole="button"
                  className={cn(
                    "flex-1 items-center rounded-full py-2",
                    draft.scheduleMode === mode && "bg-card",
                  )}
                  onPress={() => patch({ scheduleMode: mode })}
                >
                  <Text
                    className={cn(
                      "text-sm text-foreground",
                      draft.scheduleMode === mode ? "font-t3-semibold" : "text-foreground-muted",
                    )}
                  >
                    {mode === "fixed" ? "Fixed time" : "Interval"}
                  </Text>
                </Pressable>
              ))}
            </View>
            {draft.scheduleMode === "fixed" ? (
              <View className="gap-3 rounded-[18px] border-continuous bg-card p-4">
                <View className="flex-row items-center justify-between">
                  <Text className="text-base text-foreground">Time</Text>
                  <TextInput
                    className={cn(
                      "min-w-[72px] rounded-lg bg-subtle px-3 py-1.5 text-center text-base text-foreground",
                      !isValidTimeOfDay(draft.timeOfDay) && "text-red-500",
                    )}
                    autoCapitalize="none"
                    keyboardType="numbers-and-punctuation"
                    placeholder="09:00"
                    value={draft.timeOfDay}
                    onChangeText={(timeOfDay) => patch({ timeOfDay })}
                  />
                </View>
                <View className="flex-row justify-between">
                  {WEEKDAY_ORDER.map((day) => {
                    const selected = draft.weekdays.has(day);
                    return (
                      <Pressable
                        key={day}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        className={cn(
                          "h-10 w-10 items-center justify-center rounded-full bg-subtle",
                        )}
                        style={selected ? { backgroundColor: accent } : undefined}
                        onPress={() => {
                          const weekdays = new Set(draft.weekdays);
                          if (selected) weekdays.delete(day);
                          else weekdays.add(day);
                          patch({ weekdays });
                        }}
                      >
                        <Text
                          className={cn(
                            "text-sm font-t3-semibold",
                            selected ? "text-primary-foreground" : "text-foreground-muted",
                          )}
                        >
                          {WEEKDAY_SHORT[day]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : (
              <View className="flex-row items-center justify-between rounded-[18px] border-continuous bg-card p-4">
                <Text className="text-base text-foreground">Every</Text>
                <View className="flex-row items-center gap-2">
                  <TextInput
                    className={cn(
                      "min-w-[56px] rounded-lg bg-subtle px-3 py-1.5 text-center text-base text-foreground",
                      parseIntervalMinutes(draft.intervalMinutes) === null && "text-red-500",
                    )}
                    keyboardType="number-pad"
                    value={draft.intervalMinutes}
                    onChangeText={(intervalMinutes) => patch({ intervalMinutes })}
                  />
                  <Text className="text-base text-foreground-muted">minutes</Text>
                </View>
              </View>
            )}
          </View>

          {props.task === null ? (
            <View className="gap-2">
              <FieldLabel>Project</FieldLabel>
              <View className="overflow-hidden rounded-[18px] border-continuous bg-card">
                {environmentProjects.length === 0 ? (
                  <Text className="p-4 text-base text-foreground-muted">
                    No projects on this environment yet.
                  </Text>
                ) : (
                  environmentProjects.map((project, index) => {
                    const selected = draft.projectId === project.id;
                    return (
                      <Pressable
                        key={project.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        className={cn(
                          "flex-row items-center justify-between px-4 py-3",
                          index > 0 && "border-t border-secondary-border",
                        )}
                        onPress={() => patch({ projectId: project.id })}
                      >
                        <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                          {project.title}
                        </Text>
                        {selected ? (
                          <Text className="text-base font-t3-bold" style={{ color: accent }}>
                            ✓
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  })
                )}
              </View>
              <Text className="px-2 text-sm text-foreground-muted">
                Each run starts a fresh thread in a new worktree using the project’s default model.
              </Text>
            </View>
          ) : null}

          <View className="flex-row items-center justify-between rounded-[18px] border-continuous bg-card p-4">
            <Text className="text-base text-foreground">Enabled</Text>
            <Switch
              ios_backgroundColor={track}
              trackColor={{ false: track, true: activeTrack }}
              value={draft.enabled}
              onValueChange={(enabled) => patch({ enabled })}
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
