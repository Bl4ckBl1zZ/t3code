import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { formatOrchestrationV2RollbackDetail } from "@t3tools/shared/orchestrationV2Timeline";

/**
 * Turn items that render as first-class timeline rows (dividers or related-
 * thread rows) instead of work-log activities. Mirrors the web timeline's
 * LIFECYCLE_TYPES; checkpoints intentionally stay in the work log.
 */
const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "checkpoint_rollback",
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
      readonly kind: "divider";
      readonly label: string;
      readonly detail: string | null;
      readonly tone: "neutral" | "danger";
      readonly symbol:
        | "xmark"
        | "minus"
        | "bolt"
        | "arrow.triangle.branch"
        | "stop.fill"
        | "arrow.uturn.backward";
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
      /** The agent's or thread's name. */
      readonly title: string;
      /** Its task, muted after the name. */
      readonly preview: string | null;
      /** Latest progress or result: the one line under the row. */
      readonly detail: string | null;
      /** Muted note for what is not a status, such as "Created". */
      readonly meta: string | null;
      readonly status: RelatedThreadStatus | null;
      readonly threadId: ThreadId | null;
      /** Stable per-agent seed; when present the row leads with an AgentOrb. */
      readonly orbSeed: string | null;
      readonly orbState: "active" | "done" | "failed" | null;
    };

/** A related agent's state as a row's trailing glyph. Done draws nothing. */
export type RelatedThreadStatus = "running" | "failed" | "stopped";

/**
 * Reads turn-item and subagent statuses alike, so the feed row and the lineage
 * sheet agree on what a running, failed or stopped agent looks like.
 */
export function relatedThreadStatus(status: string | null): RelatedThreadStatus | null {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "running";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return null;
  }
}

export type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

/**
 * Subagents this thread has working right now, in timeline order. Reads the
 * same visible items the feed renders, so the pill above the composer and the
 * rows it summarizes cannot disagree about what is running.
 */
export function workingSubagents(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<SubagentTurnItem> {
  const working: SubagentTurnItem[] = [];
  for (const { item } of items) {
    if (item.type === "subagent" && relatedThreadStatus(item.status) === "running") {
      working.push(item);
    }
  }
  return working;
}

/** The orb seed the feed row and the lineage sheet also use. */
export function subagentOrbSeed(item: SubagentTurnItem): string {
  return item.childThreadId ?? item.subagentId;
}

/** Collapses a prompt or streamed result to the single line a row has room for. */
function oneLine(value: string | null | undefined): string | null {
  const compact = value?.replace(/\s+/g, " ").trim();
  return compact ? compact : null;
}

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

/**
 * Pure presentation for a lifecycle turn item. Ports the web V2LifecycleRow
 * semantics: interrupt requests/results, compactions, handoffs and forks are
 * dividers, thread creation and subagents are related-thread rows.
 */
export function resolveLifecyclePresentation(
  item: OrchestrationV2TurnItem,
  runs: ReadonlyArray<LifecycleTimelineRun>,
): LifecyclePresentation | null {
  switch (item.type) {
    case "run_interrupt_request":
      return {
        kind: "divider",
        label: "Interrupt requested",
        detail: item.message ?? null,
        tone: "danger",
        symbol: "stop.fill",
        layout: "inline",
        busy: false,
        actionLabel: null,
        openThreadId: null,
      };
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
    case "checkpoint_rollback":
      return {
        kind: "divider",
        label: "Rolled back",
        detail: formatOrchestrationV2RollbackDetail(item),
        tone: "neutral",
        symbol: "arrow.uturn.backward",
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
        label: "Chat compacted",
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
        preview: `${item.targetProviderInstanceId} · ${item.targetModel}`,
        detail: null,
        meta: "Created",
        status: null,
        threadId: item.targetThreadId,
        orbSeed: null,
        orbState: null,
      };
    case "subagent": {
      const progress = oneLine(item.progress);
      const result = oneLine(item.result);
      return {
        kind: "related-thread",
        symbol: "sparkles",
        title: subagentDisplayTitle(item.title ?? "Subagent"),
        preview: oneLine(item.prompt),
        detail: TERMINAL_SUBAGENT_STATUSES.has(item.status)
          ? (result ?? progress)
          : (progress ?? result),
        meta: null,
        status: relatedThreadStatus(item.status),
        threadId: item.childThreadId ?? null,
        // Child thread id first: the relationships surfaces only know thread
        // ids, so this keeps one agent the same color everywhere.
        orbSeed: subagentOrbSeed(item),
        orbState: subagentOrbState(item.status),
      };
    }
    default:
      return null;
  }
}
