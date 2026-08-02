import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AutomationEditSheet } from "./automations/AutomationEditSheet";
import { AutomationRow } from "./automations/AutomationRow";
import { SettingsSection } from "./components/SettingsSection";

interface EditorTarget {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}

function EnvironmentAutomations(props: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentLabel: boolean;
  readonly onEdit: (target: EditorTarget) => void;
}) {
  const environmentId = props.environment.environmentId;
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const deleteTask = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "automation delete",
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const active = tasks.filter((task) => task.enabled);
  const paused = tasks.filter((task) => !task.enabled);

  const confirmDelete = (task: ScheduledTask) => {
    showConfirmDialog({
      title: "Delete automation?",
      message: `“${task.title}” and its schedule will be removed. Threads it already created stay.`,
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        void deleteTask({ environmentId, input: { id: task.id } }).then((result) => {
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            Alert.alert(
              "Could not delete automation",
              failure instanceof Error ? failure.message : String(failure),
            );
          }
        });
      },
    });
  };

  if (tasksQuery.error !== null) {
    return (
      <Text className="px-2 text-sm text-red-500">
        Could not load automations for {props.environment.label}.
      </Text>
    );
  }
  if (tasks.length === 0) return null;

  const sections: ReadonlyArray<{ title: string; tasks: ReadonlyArray<ScheduledTask> }> = [
    { title: "Active", tasks: active },
    { title: "Paused", tasks: paused },
  ];

  return (
    <>
      {props.showEnvironmentLabel ? (
        <Text className="px-2 text-sm font-t3-semibold text-foreground-muted">
          {props.environment.label}
        </Text>
      ) : null}
      {sections.map((section) =>
        section.tasks.length === 0 ? null : (
          <SettingsSection card key={section.title} title={section.title}>
            {section.tasks.map((task, index) => (
              <View
                className={index > 0 ? "border-t border-secondary-border" : undefined}
                key={task.id}
              >
                <AutomationRow
                  environmentId={environmentId}
                  task={task}
                  onLongPress={() => confirmDelete(task)}
                  onPress={() => props.onEdit({ environmentId, task })}
                />
              </View>
            ))}
          </SettingsSection>
        ),
      )}
    </>
  );
}

export function SettingsAutomationsRouteScreen() {
  const insets = useSafeAreaInsets();
  const accent = useThemeColor("--color-primary");
  const { environments } = useEnvironments();
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  const defaultEnvironmentId = environments[0]?.environmentId ?? null;

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length === 0 ? (
          <EmptyState
            title="No environments"
            detail="Connect an environment to schedule automations on it."
          />
        ) : (
          environments.map((environment) => (
            <EnvironmentAutomations
              environment={environment}
              key={environment.environmentId}
              showEnvironmentLabel={environments.length > 1}
              onEdit={setEditor}
            />
          ))
        )}
        {defaultEnvironmentId !== null ? (
          <Pressable
            accessibilityRole="button"
            className="items-center rounded-[24px] border-continuous bg-card p-4"
            onPress={() => setEditor({ environmentId: defaultEnvironmentId, task: null })}
          >
            <Text className="text-lg font-t3-semibold" style={{ color: accent }}>
              New Automation
            </Text>
          </Pressable>
        ) : null}
        <Text className="px-2 text-sm text-foreground-muted">
          Automations run on their environment’s schedule and post results into their bound thread.
          Long-press a row to delete it.
        </Text>
      </ScrollView>
      {editor !== null ? (
        <AutomationEditSheet
          environmentId={editor.environmentId}
          task={editor.task}
          visible
          onClose={() => setEditor(null)}
        />
      ) : null}
    </View>
  );
}
