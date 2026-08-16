import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { AutomationRow } from "../../settings/automations/AutomationRow";
import { DetailsDivider, DetailsSection } from "./detailsRows";

/**
 * Scheduled tasks bound to this thread, with the same inline run-now and enable
 * controls the desktop panel offers.
 *
 * Hidden when nothing is bound — but a load error must not look like "no
 * automations": tasks may exist whose controls would silently vanish.
 */
export function ThreadDetailsAutomations(props: {
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
    <DetailsSection title="Automations">
      {tasksQuery.error !== null ? (
        <Text className="px-4 py-3 text-sm text-red-500">Could not load automations.</Text>
      ) : (
        boundTasks.map((task, index) => (
          <View key={task.id}>
            {index > 0 ? <DetailsDivider /> : null}
            <AutomationRow compact environmentId={props.environmentId} task={task} />
          </View>
        ))
      )}
    </DetailsSection>
  );
}
