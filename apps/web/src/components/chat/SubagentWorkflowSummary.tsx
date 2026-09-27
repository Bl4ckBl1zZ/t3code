import type { OrchestrationV2TaskUsage, OrchestrationV2WorkflowProgress } from "@t3tools/contracts";
import { formatTaskUsage, workflowPhaseProgress } from "@t3tools/shared/workflowObservability";

import { cn } from "../../lib/utils";

/**
 * Workflow phase progress and token usage for one subagent, shown in its
 * lineage hover. Renders nothing for a plain subagent that reported neither,
 * which is the common case. The numbers come from the same shared helpers the
 * mobile lineage rows use, so the two never disagree.
 */
export function SubagentWorkflowSummary(props: {
  readonly workflow: OrchestrationV2WorkflowProgress | undefined;
  readonly usage: OrchestrationV2TaskUsage | undefined;
}) {
  const progress = workflowPhaseProgress(props.workflow);
  const usage = formatTaskUsage(props.usage);
  const currentPhase = props.workflow?.currentPhase;
  if (progress === null && currentPhase === undefined && usage === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-subagent-workflow-summary>
      {progress !== null || currentPhase !== undefined ? (
        <div className="flex min-w-0 items-center gap-1.5">
          {progress !== null ? (
            <>
              <span className="shrink-0 tabular-nums">
                {progress.current}/{progress.total}
              </span>
              {/* Phase pips show shape (how far along, how many) at a glance. */}
              <span aria-hidden className="flex shrink-0 items-center gap-0.5">
                {props.workflow?.phases.map((phase, index) => (
                  <span
                    key={`${phase.index}-${phase.title}`}
                    className={cn(
                      "h-1 w-2.5 rounded-full",
                      index < progress.current ? "bg-primary/70" : "bg-muted-foreground/25",
                    )}
                  />
                ))}
              </span>
            </>
          ) : null}
          {currentPhase !== undefined ? (
            <span className="min-w-0 truncate text-foreground/75">{currentPhase}</span>
          ) : null}
        </div>
      ) : null}
      {usage !== null ? <span className="tabular-nums">{usage}</span> : null}
    </div>
  );
}
