import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";

/**
 * Turn items that render as first-class timeline rows (dividers or related-
 * thread cards) instead of work-log activities. Mirrors the web timeline's
 * LIFECYCLE_TYPES; checkpoints intentionally stay in the work log.
 */
const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleTimelineItem(item: OrchestrationV2TurnItem): boolean {
  return LIFECYCLE_TYPES.has(item.type);
}

// A handoff turn item is broadcast in a non-terminal status while the
// orchestrator is still generating the handoff summary for the target model.
const HANDOFF_IN_FLIGHT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "pending",
  "running",
  "waiting",
]);

// Once a subagent stops, its last streamed result says more than the stale
// progress line; while it runs, live progress comes first.
const TERMINAL_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** The subset of a projection run that handoff rows read to recover models. */
export interface LifecycleTimelineRun {
  readonly id: string;
  readonly ordinal: number;
  readonly providerInstanceId: string;
  readonly model: string;
}

export type LifecyclePresentation =
  | {
      readonly kind: "interrupt-request";
      readonly message: string;
    }
  | {
      readonly kind: "divider";
      readonly label: string;
      readonly detail: string | null;
      readonly tone: "neutral" | "danger";
      readonly symbol: "xmark" | "minus" | "bolt" | "arrow.triangle.branch";
      /** Stacked puts the detail on its own line under the label (handoffs). */
      readonly layout: "inline" | "stacked";
      /** In-flight system work (e.g. handoff summary being generated). */
      readonly busy: boolean;
      readonly actionLabel: string | null;
      readonly openThreadId: ThreadId | null;
    }
  | {
      readonly kind: "related-thread";
      readonly symbol: "message" | "sparkles";
      readonly title: string;
      readonly detail: string | null;
      readonly badge: string;
      readonly badgeTone: "neutral" | "success" | "danger";
      readonly threadId: ThreadId | null;
      /** Stable per-agent seed; when present the card renders an AgentOrb. */
      readonly orbSeed: string | null;
      readonly orbState: "active" | "done" | "failed" | null;
    };

function subagentDisplayTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Subagent";
}

function latestRunModelBefore(
  runs: ReadonlyArray<LifecycleTimelineRun>,
  instanceId: string,
  beforeOrdinal: number | undefined,
): string | undefined {
  let best: LifecycleTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (best === undefined || run.ordinal > best.ordinal) best = run;
  }
  return best?.model;
}

function endpointLabel(instanceId: string, model: string | undefined): string {
  return model !== undefined && model.length > 0 ? model : instanceId;
}

function subagentOrbState(status: OrchestrationV2TurnItem["status"]): "active" | "done" | "failed" {
  if (status === "failed") return "failed";
  return TERMINAL_SUBAGENT_STATUSES.has(status) ? "done" : "active";
}

function subagentBadgeTone(
  status: OrchestrationV2TurnItem["status"],
): "neutral" | "success" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

/**
 * Pure presentation for a lifecycle turn item. Ports the web V2LifecycleRow
 * semantics: interrupt requests are inline destructive lines, interrupt
 * results/compactions/handoffs/forks are dividers, thread creation and
 * subagents are related-thread cards.
 */
export function resolveLifecyclePresentation(
  item: OrchestrationV2TurnItem,
  runs: ReadonlyArray<LifecycleTimelineRun>,
): LifecyclePresentation | null {
  switch (item.type) {
    case "run_interrupt_request":
      return { kind: "interrupt-request", message: item.message };
    case "run_interrupt_result":
      return {
        kind: "divider",
        label: "Run interrupted",
        detail: item.message ?? null,
        tone: "danger",
        symbol: "xmark",
        layout: "inline",
        busy: false,
        actionLabel: null,
        openThreadId: null,
      };
    case "compaction": {
      const tokenDetail =
        item.beforeTokenCount === undefined && item.afterTokenCount === undefined
          ? null
          : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
      return {
        kind: "divider",
        label: "Context compacted",
        detail: item.summary ?? tokenDetail,
        tone: "neutral",
        symbol: "minus",
        layout: "inline",
        busy: false,
        actionLabel: null,
        openThreadId: null,
      };
    }
    case "handoff": {
      // Items persisted before models were stamped only carry instance ids;
      // recover the models from the thread's runs (the handoff's own run is
      // the target, the newest earlier run per source instance is the origin).
      const handoffRun =
        item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
      const toModel =
        item.toModel ??
        (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
          ? handoffRun.model
          : undefined);
      const fromEndpoints =
        item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
          ? item.fromModelSelections.map((selection) =>
              endpointLabel(selection.instanceId, selection.model),
            )
          : item.fromProviderInstanceIds.map((instanceId) =>
              endpointLabel(
                instanceId,
                latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
              ),
            );
      const target = endpointLabel(item.toProviderInstanceId, toModel);
      // The item streams in as `running` while the orchestrator prepares the
      // handoff summary (possibly an AI call), then flips to `completed`.
      const preparing = HANDOFF_IN_FLIGHT_STATUSES.has(item.status);
      return {
        kind: "divider",
        label: preparing
          ? "Preparing context handoff"
          : item.status === "failed"
            ? "Context handoff failed"
            : "Context handoff",
        detail: fromEndpoints.length > 0 ? `${fromEndpoints.join(", ")} → ${target}` : target,
        tone: item.status === "failed" ? "danger" : "neutral",
        symbol: "bolt",
        layout: "stacked",
        busy: preparing,
        actionLabel: null,
        openThreadId: null,
      };
    }
    case "fork": {
      const sourceThreadId = item.source.type === "run" ? item.source.threadId : null;
      return {
        kind: "divider",
        label: sourceThreadId !== null ? "Forked from conversation" : "Conversation fork",
        detail: null,
        tone: "neutral",
        symbol: "arrow.triangle.branch",
        layout: "inline",
        busy: false,
        actionLabel: sourceThreadId !== null ? "Open source conversation" : "Open fork",
        openThreadId: sourceThreadId ?? item.targetThreadId,
      };
    }
    case "thread_created":
      return {
        kind: "related-thread",
        symbol: "message",
        title: item.title ?? "Created thread",
        detail: `${item.targetProviderInstanceId} · ${item.targetModel}`,
        badge: "created",
        badgeTone: "neutral",
        threadId: item.targetThreadId,
        orbSeed: null,
        orbState: null,
      };
    case "subagent": {
      const streamedResult = item.result?.trim() ? item.result : null;
      const detail = TERMINAL_SUBAGENT_STATUSES.has(item.status)
        ? (streamedResult ?? item.progress ?? item.prompt)
        : (item.progress ?? streamedResult ?? item.prompt);
      return {
        kind: "related-thread",
        symbol: "sparkles",
        title: subagentDisplayTitle(item.title ?? "Subagent"),
        detail: detail ?? null,
        badge: item.status,
        badgeTone: subagentBadgeTone(item.status),
        threadId: item.childThreadId ?? null,
        // Child thread id first: the relationships surfaces only know thread
        // ids, so this keeps one agent the same color everywhere.
        orbSeed: item.childThreadId ?? item.subagentId,
        orbState: subagentOrbState(item.status),
      };
    }
    default:
      return null;
  }
}
