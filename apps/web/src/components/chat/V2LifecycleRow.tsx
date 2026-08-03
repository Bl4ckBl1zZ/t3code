import { Fragment } from "react";
import type {
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  ArrowRightIcon,
  ExternalLinkIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  MinusIcon,
  type LucideIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";

import { getProviderInstanceEntry } from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { AgentOrb, type AgentOrbState } from "./AgentOrb";
import { PROVIDER_ICON_BY_PROVIDER, getTriggerDisplayModelName } from "./providerIconUtils";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleItem(item: OrchestrationV2TurnItem): boolean {
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

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_request") {
    return (
      <div className="flex justify-end px-1 py-1" data-v2-item-type={item.type}>
        <div className="flex max-w-[80%] items-center gap-2 text-xs text-destructive">
          <span aria-hidden="true" className="font-mono">
            ■
          </span>
          <span className="font-medium">Interrupt requested</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-medium">{item.message}</span>
          <span className="text-[10px] text-muted-foreground">
            {formatShortTimestamp(props.createdAt, props.timestampFormat)}
          </span>
        </div>
      </div>
    );
  }
  if (item.type === "run_interrupt_result") {
    return (
      <TimelineSystemDivider
        label="Run interrupted"
        detail={item.message}
        tone="danger"
        icon={XIcon}
      />
    );
  }
  if (item.type === "compaction") {
    const tokenDetail =
      item.beforeTokenCount === undefined && item.afterTokenCount === undefined
        ? null
        : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
    return (
      <TimelineSystemDivider
        label="Context compacted"
        detail={item.summary ?? tokenDetail}
        icon={MinusIcon}
      />
    );
  }
  if (item.type === "handoff") {
    // Items persisted before models were stamped only carry instance ids;
    // recover the models from the thread's runs (the handoff's own run is
    // the target, the newest earlier run per source instance is the origin).
    // HandoffEndpoint falls back to the provider display name when neither
    // source has a model.
    const handoffRun =
      item.runId === null ? undefined : props.runs.find((run) => run.id === item.runId);
    const toModel =
      item.toModel ??
      (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
        ? handoffRun.modelSelection.model
        : undefined);
    const fromEndpoints: ReadonlyArray<{
      readonly instanceId: ProviderInstanceId;
      readonly model?: string | undefined;
    }> =
      item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
        ? item.fromModelSelections
        : item.fromProviderInstanceIds.map((instanceId) => ({
            instanceId,
            model: latestRunModelBefore(props.runs, instanceId, handoffRun?.ordinal),
          }));
    // A handoff item streams in as `running` while the orchestrator prepares
    // the summary (possibly an AI call) and flips to `completed` in place.
    const preparing = HANDOFF_IN_FLIGHT_STATUSES.has(item.status);
    return (
      <TimelineSystemDivider
        label={
          preparing
            ? "Preparing context handoff"
            : item.status === "failed"
              ? "Context handoff failed"
              : "Context handoff"
        }
        icon={preparing ? LoaderCircleIcon : ZapIcon}
        busy={preparing}
        tone={item.status === "failed" ? "danger" : "neutral"}
        detail={
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {fromEndpoints.map((endpoint, index) => (
              <Fragment key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}>
                {index > 0 ? (
                  <span aria-hidden="true" className="-ml-1">
                    ,
                  </span>
                ) : null}
                <HandoffEndpoint
                  providers={props.providerStatuses}
                  instanceId={endpoint.instanceId}
                  model={endpoint.model}
                />
              </Fragment>
            ))}
            {fromEndpoints.length > 0 ? (
              <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
            ) : null}
            <HandoffEndpoint
              providers={props.providerStatuses}
              instanceId={item.toProviderInstanceId}
              model={toModel}
            />
          </span>
        }
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    return (
      <TimelineSystemDivider
        label={item.source.type === "run" ? "Forked from conversation" : "Conversation fork"}
        icon={GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "thread_created") {
    return (
      <RelatedThreadCard
        itemType={item.type}
        icon={MessageSquareIcon}
        title={item.title ?? "Created thread"}
        detail={`${item.targetProviderInstanceId} · ${item.targetModel}`}
        badge="created"
        threadId={item.targetThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  if (item.type === "subagent") {
    const active = !TERMINAL_SUBAGENT_STATUSES.has(item.status);
    const streamedResult = item.result?.trim() ? item.result : null;
    const detail = active
      ? (item.progress ?? streamedResult ?? item.prompt)
      : (streamedResult ?? item.progress ?? item.prompt);
    return (
      <RelatedThreadCard
        itemType={item.type}
        orb={{
          // Seed by child thread id when it exists so the relationships panel
          // (which only knows thread ids) resolves the same color.
          seed: item.childThreadId ?? item.subagentId,
          state: active ? "active" : item.status === "failed" ? "failed" : "done",
        }}
        title={subagentDisplayTitle(item.title ?? "Subagent")}
        detail={detail}
        detailShimmer={active}
        badge={item.status}
        badgeTone={subagentBadgeTone(item.status)}
        threadId={item.childThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

function subagentBadgeTone(status: OrchestrationV2TurnItem["status"]): RelatedThreadBadgeTone {
  if (status === "failed") return "danger";
  if (status === "completed") return "success";
  return TERMINAL_SUBAGENT_STATUSES.has(status) ? "neutral" : "info";
}

type RelatedThreadBadgeTone = "neutral" | "info" | "success" | "danger";

const RELATED_THREAD_BADGE_TONE_CLASS: Record<RelatedThreadBadgeTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  danger: "text-destructive",
};

function RelatedThreadCard(props: {
  readonly itemType: "subagent" | "thread_created";
  readonly icon?: LucideIcon;
  readonly orb?: { readonly seed: string; readonly state: AgentOrbState };
  readonly title: string;
  readonly detail: string;
  readonly detailShimmer?: boolean;
  readonly badge: string;
  readonly badgeTone?: RelatedThreadBadgeTone;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const Icon = props.icon;
  const threadId = props.threadId;
  const content = (
    <>
      {props.orb !== undefined ? (
        <AgentOrb seed={props.orb.seed} state={props.orb.state} size={22} />
      ) : Icon !== undefined ? (
        <span className="flex size-[22px] shrink-0 items-center justify-center">
          <Icon className="size-3.5 text-muted-foreground" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.title}</span>
          <span
            className={cn(
              "shrink-0 text-[10px] font-bold uppercase tracking-wide",
              RELATED_THREAD_BADGE_TONE_CLASS[props.badgeTone ?? "neutral"],
            )}
          >
            {props.badge}
          </span>
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-xs text-muted-foreground",
            props.detailShimmer && "text-shimmer",
          )}
        >
          {props.detail}
        </span>
      </span>
    </>
  );

  return threadId === null ? (
    <div
      data-v2-item-type={props.itemType}
      className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-card/30 px-3 py-2.5"
    >
      {content}
    </div>
  ) : (
    <button
      type="button"
      data-v2-item-type={props.itemType}
      aria-label={`Open ${props.title}`}
      onClick={() => props.onOpenThread(threadId)}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-card/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
    >
      {content}
      <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

function subagentDisplayTitle(title: string): string {
  return title.replace(/^Subagent:\s*/i, "");
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

/**
 * One side of a context handoff: the provider's brand icon plus the model's
 * display name. Falls back to the raw model slug when the instance no longer
 * lists it, and to the instance display name (or id) when no model was
 * recorded on the item.
 */
function HandoffEndpoint(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = getProviderInstanceEntry(props.providers, props.instanceId);
  const Icon = entry === undefined ? null : (PROVIDER_ICON_BY_PROVIDER[entry.driverKind] ?? null);
  const model = props.model?.trim();
  const providerModel =
    model === undefined || model.length === 0
      ? undefined
      : entry?.models.find((candidate) => candidate.slug === model);
  const label =
    providerModel !== undefined
      ? getTriggerDisplayModelName(providerModel)
      : model !== undefined && model.length > 0
        ? model
        : (entry?.displayName ?? props.instanceId);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {Icon === null ? null : <Icon aria-hidden="true" className="size-3 shrink-0" />}
      <span className="max-w-40 truncate">{label}</span>
    </span>
  );
}
