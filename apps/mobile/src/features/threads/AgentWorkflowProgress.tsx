/**
 * Compact workflow readout for a subagent row on mobile.
 *
 * Phone rows have room for one line, so this shows the phase counter, the
 * current phase name, and the token rollup -- and nothing when the task is
 * not a workflow, which is the common case. The numbers come from the same
 * shared helpers the web Agents surface uses so the two never disagree.
 */
import type { OrchestrationV2TaskUsage, OrchestrationV2WorkflowProgress } from "@t3tools/contracts";
import { formatTokenCount, workflowPhaseProgress } from "@t3tools/shared/workflowObservability";
import { Text, View } from "react-native";

export function AgentWorkflowProgress(props: {
  readonly workflow: OrchestrationV2WorkflowProgress | undefined;
  readonly usage: OrchestrationV2TaskUsage | undefined;
}) {
  const progress = workflowPhaseProgress(props.workflow);
  const usage = props.usage;
  if (progress === null && usage === undefined) return null;

  return (
    <View className="mt-0.5 flex-row items-center gap-2">
      {progress !== null ? (
        <>
          <Text className="text-3xs tabular-nums text-foreground-muted">
            {progress.current}/{progress.total}
          </Text>
          {/* Phase pips. Sized for touch-distance legibility rather than the
              denser desktop treatment. */}
          <View className="flex-row items-center gap-0.5">
            {props.workflow?.phases.map((phase, index) => (
              <View
                key={`${phase.index}-${phase.title}`}
                className={
                  index < progress.current
                    ? "h-1 w-2.5 rounded-full bg-primary/70"
                    : "h-1 w-2.5 rounded-full bg-neutral-300/70 dark:bg-white/[0.12]"
                }
              />
            ))}
          </View>
        </>
      ) : null}
      {props.workflow?.currentPhase !== undefined ? (
        <Text className="text-3xs text-foreground-muted" numberOfLines={1}>
          {props.workflow.currentPhase}
        </Text>
      ) : null}
      {usage !== undefined ? (
        <Text className="text-3xs tabular-nums text-foreground-muted">
          {formatTokenCount(usage.totalTokens)} tok
        </Text>
      ) : null}
    </View>
  );
}
