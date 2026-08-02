import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { AutomationRow } from "../settings/automations/AutomationRow";

/**
 * Automations bound to this thread, shown above the transcript. Mirrors the
 * web ThreadAutomationsPanel: hidden when nothing is bound, but a load error
 * must not look like "no automations" — tasks may exist whose controls would
 * silently vanish.
 */
export function ThreadAutomationsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );

  const boundTasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.threadId === props.threadId,
  );
  if (tasksQuery.error === null && boundTasks.length === 0) return null;

  return (
    <View className="mb-3 overflow-hidden rounded-[20px] border-continuous bg-card">
      <Text className="px-4 pb-1 pt-3 text-xs font-t3-semibold uppercase tracking-wide text-foreground-muted">
        Automations
      </Text>
      {tasksQuery.error !== null ? (
        <Text className="px-4 pb-3 text-sm text-red-500">Could not load automations.</Text>
      ) : (
        boundTasks.map((task, index) => (
          <View
            className={index > 0 ? "border-t border-secondary-border" : undefined}
            key={task.id}
          >
            <AutomationRow compact environmentId={props.environmentId} task={task} />
          </View>
        ))
      )}
    </View>
  );
}
