import {
  orchestrationV2CommandExecutionIsLiveInBackground,
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type PlanId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveOrchestrationV2ItemAttempt } from "@t3tools/shared/orchestrationV2Timeline";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ThreadRunSummary, ThreadRuntimeSummary } from "@t3tools/client-runtime/state/shell";

import type { ChatMessage, ProposedPlan, SessionPhase, TurnDiffSummary } from "./types";
import * as DateTime from "effect/DateTime";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  { value: ProviderDriverKind.make("grok"), label: "Grok", available: true },
  {
    value: ProviderDriverKind.make("hermes"),
    label: "Hermes",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("openclaw"),
    label: "OpenClaw",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export type WorkLogToolLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

export interface WorkLogEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly runId?: RunId | null;
  readonly label: string;
  readonly detail?: string;
  readonly command?: string;
  readonly rawCommand?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: string;
  readonly itemType?: OrchestrationV2TurnItem["type"];
  readonly toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly sourceItemType?: OrchestrationV2TurnItem["type"];
  readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
}

export type PendingApproval = ThreadPendingApproval;
export type PendingUserInput = ThreadPendingUserInput;

export interface ActivePlanState {
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly explanation?: string | null;
  readonly steps: Array<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  readonly id: PlanId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runId: RunId | null;
  readonly planMarkdown: string;
  readonly status: OrchestrationV2PlanArtifact["status"];
}

export type TimelineAttempt = Pick<
  OrchestrationV2RunAttempt,
  "id" | "runId" | "attemptOrdinal" | "rootNodeId" | "status"
>;

export type TimelineEntry = (
  | {
      readonly id: string;
      readonly kind: "message";
      readonly createdAt: string;
      readonly message: ChatMessage;
      readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
    }
  | {
      readonly id: string;
      readonly kind: "proposed-plan";
      readonly createdAt: string;
      readonly proposedPlan: ProposedPlan;
    }
  | {
      readonly id: string;
      readonly kind: "work";
      readonly createdAt: string;
      readonly entry: WorkLogEntry;
    }
  | {
      readonly id: string;
      readonly kind: "event";
      readonly createdAt: string;
      readonly projectedItem: OrchestrationV2ProjectedTurnItem;
    }
) & {
  /** V2 identity resolved from the item's execution node, when locally available. */
  readonly attempt?: TimelineAttempt;
};

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  return (
    entry.tone === "tool" ||
    entry.tone === "thinking" ||
    entry.tone === "error" ||
    entry.command !== undefined ||
    entry.requestKind !== undefined
  );
}

export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  );
}

export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  return workLogEntryIsToolLike(entry) && entry.toolLifecycleStatus === "completed";
}

export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    !workEntryIndicatesToolSuccess(entry)
  );
}

/**
 * Provider-neutral V2 items are committed timeline rows, including while a
 * tool is still running. Legacy work-log entries may use a neutral row as a
 * transient placeholder, so retain the old filtering behavior only for those
 * unprojected entries.
 */
export function workLogEntryIsVisible(entry: WorkLogEntry): boolean {
  return entry.projectedItem !== undefined || !workEntryIndicatesToolNeutralStatus(entry);
}

export { formatDuration, formatElapsed } from "@t3tools/shared/orchestrationTiming";

export function isLatestRunSettled(
  latestRun: Pick<ThreadRunSummary, "runId" | "startedAt" | "completedAt" | "status"> | null,
  runtime: Pick<ThreadRuntimeSummary, "status" | "activeRunId"> | null,
): boolean {
  if (latestRun === null) return false;
  if (
    latestRun.status === "preparing" ||
    latestRun.status === "queued" ||
    latestRun.status === "starting" ||
    latestRun.status === "running" ||
    latestRun.status === "waiting"
  )
    return false;
  return runtime?.activeRunId !== latestRun.runId;
}

export function deriveActiveWorkStartedAt(
  latestRun: Pick<ThreadRunSummary, "runId" | "startedAt" | "completedAt" | "status"> | null,
  runtime: Pick<ThreadRuntimeSummary, "status" | "activeRunId"> | null,
  sendStartedAt: string | null,
  latestUserMessageAt: string | null = null,
): string | null {
  if (runtime?.activeRunId !== null && runtime?.activeRunId !== undefined) {
    return latestRun?.runId === runtime.activeRunId
      ? (latestRun.startedAt ?? sendStartedAt ?? latestUserMessageAt)
      : (sendStartedAt ?? latestUserMessageAt);
  }
  return isLatestRunSettled(latestRun, runtime)
    ? sendStartedAt
    : (latestRun?.startedAt ?? sendStartedAt);
}

export function derivePendingApprovals(
  approvals: ReadonlyArray<ThreadPendingApproval>,
): ThreadPendingApproval[] {
  return [...approvals].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function derivePendingUserInputs(
  inputs: ReadonlyArray<ThreadPendingUserInput>,
): ThreadPendingUserInput[] {
  return [...inputs].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function deriveActivePlanState(
  projection: OrchestrationV2ThreadProjection | null,
  latestRunId: RunId | undefined,
): ActivePlanState | null {
  if (projection === null) return null;
  const plans = projection.plans.filter((plan) => plan.kind === "todo_list");
  const plan =
    [...plans].toReversed().find((candidate) => candidate.runId === latestRunId) ??
    plans.at(-1) ??
    null;
  if (plan === null || plan.steps.length === 0) return null;
  return {
    createdAt: planItemTime(projection, plan.id),
    runId: plan.runId,
    explanation: plan.explanation ?? null,
    steps: plan.steps.map(({ text, status }) => ({
      step: text,
      status: status === "running" ? "inProgress" : status,
    })),
  };
}

function planItemTime(projection: OrchestrationV2ThreadProjection, planId: PlanId): string {
  const item = projection.turnItems.findLast(
    (candidate) =>
      (candidate.type === "proposed_plan" || candidate.type === "todo_list") &&
      candidate.planId === planId,
  );
  return DateTime.formatIso(item?.updatedAt ?? projection.updatedAt);
}

function toLatestProposedPlanState(
  projection: OrchestrationV2ThreadProjection,
  plan: Extract<OrchestrationV2PlanArtifact, { readonly kind: "proposed_plan" }>,
): LatestProposedPlanState {
  const updatedAt = planItemTime(projection, plan.id);
  return {
    id: plan.id,
    createdAt: updatedAt,
    updatedAt,
    runId: plan.runId,
    planMarkdown: plan.markdown,
    status: plan.status,
  };
}

export function findLatestProposedPlan(
  projection: OrchestrationV2ThreadProjection | null,
  latestRunId: RunId | string | null | undefined,
): LatestProposedPlanState | null {
  if (projection === null) return null;
  const plans = projection.plans.filter((plan) => plan.kind === "proposed_plan");
  const candidates = latestRunId ? plans.filter((plan) => plan.runId === latestRunId) : plans;
  const plan = [...(candidates.length > 0 ? candidates : plans)]
    .toSorted(
      (left, right) =>
        planItemTime(projection, left.id).localeCompare(planItemTime(projection, right.id)) ||
        left.id.localeCompare(right.id),
    )
    .at(-1);
  return plan === undefined ? null : toLatestProposedPlanState(projection, plan);
}

export function findSidebarProposedPlan(input: {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projection: OrchestrationV2ThreadProjection;
  }>;
  readonly latestRun: Pick<ThreadRunSummary, "runId" | "sourcePlanRef"> | null;
  readonly latestRunSettled: boolean;
  readonly threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  if (!input.latestRunSettled && input.latestRun?.sourcePlanRef !== undefined) {
    const source = input.latestRun.sourcePlanRef;
    const sourceProjection = input.threads.find(
      (thread) => thread.id === source.threadId,
    )?.projection;
    const plan = sourceProjection?.plans.find(
      (candidate) => candidate.kind === "proposed_plan" && candidate.id === source.planId,
    );
    if (sourceProjection !== undefined && plan?.kind === "proposed_plan") {
      return toLatestProposedPlanState(sourceProjection, plan);
    }
  }
  const activeProjection = input.threads.find((thread) => thread.id === input.threadId)?.projection;
  return findLatestProposedPlan(activeProjection ?? null, input.latestRun?.runId);
}

export function hasActionableProposedPlan(plan: LatestProposedPlanState | null): boolean {
  return plan?.status === "active";
}

const PROVIDER_HYDRATED_MESSAGE_ID_PATTERN = /^message:provider:[^:]+:native-item:/;

const STANDALONE_V2_ITEM_TYPES = new Set<OrchestrationV2ProjectedTurnItem["item"]["type"]>([
  "approval_request",
  "compaction",
  "fork",
  "handoff",
  "run_interrupt_request",
  "run_interrupt_result",
  "subagent",
  "thread_created",
  "user_input_request",
]);

const PERSISTENT_RESOURCE_V2_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "fork",
  "subagent",
  "thread_created",
]);

export function timelineEntryIsPersistentResourceCard(entry: TimelineEntry): boolean {
  if (entry.kind === "event") {
    return PERSISTENT_RESOURCE_V2_ITEM_TYPES.has(entry.projectedItem.item.type);
  }
  // A settled turn folds down to "Worked for 1m 8s" and its final message. A
  // command still running inside that turn has to survive the fold, or the one
  // row that is still reporting disappears at the exact moment it starts to
  // matter.
  const item = entry.kind === "work" ? entry.entry.projectedItem?.item : undefined;
  return item !== undefined && orchestrationV2CommandExecutionIsLiveInBackground(item);
}

function projectedItemCreatedAt(row: OrchestrationV2ProjectedTurnItem): string {
  return DateTime.formatIso(row.item.startedAt ?? row.item.updatedAt);
}

function projectedWorkEntryStatus(
  item: OrchestrationV2TurnItem,
): NonNullable<WorkLogEntry["toolLifecycleStatus"]> {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function projectedWorkEntryTone(item: OrchestrationV2TurnItem): WorkLogEntry["tone"] {
  if (item.type === "error") return "info";
  if (item.status === "failed") return "error";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
      return "tool";
    default:
      return "info";
  }
}

export function providerErrorPresentation(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "error" }>,
): { readonly label: string; readonly detail: string } {
  if (item.retry === undefined) {
    return {
      label: item.title?.trim() || "Provider error",
      detail: item.failure.message,
    };
  }
  const progress =
    item.retry.maxAttempts === null
      ? `${item.retry.attempt}`
      : `${item.retry.attempt}/${item.retry.maxAttempts}`;
  const label =
    item.status === "running"
      ? `Retrying provider (${progress})`
      : item.status === "completed"
        ? `Provider recovered (${progress} retries)`
        : item.status === "failed"
          ? `Provider error after ${progress} retries`
          : `Provider retry stopped (${progress})`;
  const retryDelay =
    item.status === "running" && item.retry.retryDelayMs !== null && item.retry.retryDelayMs > 0
      ? item.retry.retryDelayMs < 1_000
        ? ` Retrying in ${item.retry.retryDelayMs}ms.`
        : ` Retrying in ${(item.retry.retryDelayMs / 1_000).toFixed(1).replace(/\.0$/u, "")}s.`
      : "";
  return {
    label,
    detail: `${item.failure.message}${retryDelay}`,
  };
}

function projectedWorkEntry(row: OrchestrationV2ProjectedTurnItem): WorkLogEntry {
  const { item } = row;
  const title = item.title?.trim() || null;
  const common = {
    id: item.id,
    createdAt: projectedItemCreatedAt(row),
    runId: item.runId,
    tone: projectedWorkEntryTone(item),
    itemType: item.type,
    toolLifecycleStatus: projectedWorkEntryStatus(item),
    structuredPayload: item,
    projectedItem: row,
  } as const;

  switch (item.type) {
    case "reasoning":
      return {
        ...common,
        label: title ?? "Thinking",
        ...(item.text ? { detail: item.text } : {}),
      };
    case "command_execution":
      return {
        ...common,
        label: title ?? "Ran command",
        command: item.input,
        rawCommand: item.input,
        ...(item.output ? { detail: item.output } : {}),
        toolTitle: title ?? "Command",
        toolData: item,
      };
    case "file_change": {
      const detail = item.diffStr ?? item.newStr;
      return {
        ...common,
        label: title ?? `Changed ${item.fileName}`,
        changedFiles: [item.fileName],
        ...(detail ? { detail } : {}),
        toolTitle: title ?? "File change",
        toolData: item,
      };
    }
    case "file_search":
      return {
        ...common,
        label: title ?? "Searched files",
        ...(item.pattern ? { detail: item.pattern } : {}),
        toolTitle: title ?? "File search",
        toolData: item,
      };
    case "web_search":
      return {
        ...common,
        label: title ?? "Searched the web",
        ...(item.patterns?.length ? { detail: item.patterns.join(", ") } : {}),
        toolTitle: title ?? "Web search",
        toolData: item,
      };
    case "checkpoint":
      return {
        ...common,
        label: title ?? "Checkpoint captured",
        changedFiles: item.files.map((file) => file.path),
        toolData: item,
      };
    case "error": {
      const presentation = providerErrorPresentation(item);
      return {
        ...common,
        ...presentation,
        toolData: item,
      };
    }
    case "todo_list": {
      const completed = item.steps.filter((step) => step.status === "completed").length;
      return {
        ...common,
        label: title ?? "Updated tasks",
        detail: `${completed}/${item.steps.length} completed`,
        toolData: item,
      };
    }
    case "dynamic_tool":
      return {
        ...common,
        label: title ?? item.toolName ?? "Tool call",
        toolTitle: title ?? item.toolName ?? "Tool",
        toolData: { input: item.input, output: item.output },
      };
    default:
      return {
        ...common,
        label: title ?? item.type.replaceAll("_", " "),
        toolData: item,
      };
  }
}

/**
 * Builds the web timeline in the exact order committed by `visibleTurnItems`.
 * Committed rows are presented directly from their projected item. Queued
 * input is absent by construction until dispatch creates its user turn item.
 * Durable provider messages without turn-item identities are merged
 * chronologically, then optimistic client-owned messages are appended.
 */
export function deriveTimelineEntriesFromVisibleTurnItems(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  /**
   * Provider-owned history can be materialized as durable messages before the
   * provider has turn-item identities for it. Include those orphan messages
   * without duplicating messages that already have visible turn items.
   */
  readonly projectionMessages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly optimisticMessages: ReadonlyArray<ChatMessage>;
  readonly attachmentUrlById?: ReadonlyMap<string, string>;
  readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly plans?: ReadonlyArray<OrchestrationV2PlanArtifact>;
}): TimelineEntry[] {
  const committedMessageIds = new Set<string>();
  const entries: TimelineEntry[] = [];
  const projectionMessageById = new Map(
    (input.projectionMessages ?? []).map((message) => [message.id, message] as const),
  );
  const attemptByRootNodeId = new Map(
    (input.attempts ?? []).map((attempt) => [attempt.rootNodeId, attempt] as const),
  );
  const nodeById = new Map((input.nodes ?? []).map((node) => [node.id, node] as const));
  const planById = new Map((input.plans ?? []).map((plan) => [plan.id, plan] as const));

  const resolveAttempt = (item: OrchestrationV2TurnItem): TimelineAttempt | undefined =>
    resolveOrchestrationV2ItemAttempt({ item, attemptByRootNodeId, nodeById });

  for (const row of input.visibleTurnItems) {
    const { item } = row;
    const createdAt = projectedItemCreatedAt(row);
    const attempt = resolveAttempt(item);
    const attemptMetadata = attempt === undefined ? {} : { attempt };
    if (item.type === "user_message" || item.type === "assistant_message") {
      // Assistant turn items carry no attachments; provider-produced media
      // (e.g. Hermes MEDIA outputs) lives on the durable projection message.
      const itemAttachments =
        item.type === "user_message"
          ? item.attachments
          : (projectionMessageById.get(item.messageId)?.attachments ?? []);
      const message: ChatMessage = {
        id: item.messageId,
        role: item.type === "user_message" ? "user" : "assistant",
        text: item.text,
        ...(itemAttachments.length > 0
          ? {
              attachments: itemAttachments.map((attachment) => {
                const previewUrl = input.attachmentUrlById?.get(attachment.id);
                return previewUrl ? { ...attachment, previewUrl } : attachment;
              }),
            }
          : {}),
        runId: item.runId,
        streaming: item.type === "assistant_message" && item.streaming,
        ...(item.type === "user_message"
          ? { createdBy: item.createdBy, creationSource: item.creationSource }
          : {}),
        createdAt,
        updatedAt: DateTime.formatIso(item.updatedAt),
        ...(item.type === "user_message" ? { inputIntent: item.inputIntent } : {}),
      };
      committedMessageIds.add(message.id);
      entries.push({
        id: message.id,
        kind: "message",
        createdAt,
        message,
        projectedItem: row,
        ...attemptMetadata,
      });
      continue;
    }

    if (item.type === "proposed_plan") {
      const plan = planById.get(item.planId);
      const proposedPlan = {
        id: item.planId,
        runId: item.runId,
        planMarkdown: item.markdown,
        status: plan?.kind === "proposed_plan" ? plan.status : ("active" as const),
        createdAt,
        updatedAt: DateTime.formatIso(item.updatedAt),
      };
      entries.push({
        id: item.id,
        kind: "proposed-plan",
        createdAt,
        proposedPlan,
        ...attemptMetadata,
      });
      continue;
    }

    if (STANDALONE_V2_ITEM_TYPES.has(item.type)) {
      entries.push({
        id: item.id,
        kind: "event",
        createdAt,
        projectedItem: row,
        ...attemptMetadata,
      });
      continue;
    }

    entries.push({
      id: item.id,
      kind: "work",
      createdAt,
      entry: projectedWorkEntry(row),
      ...attemptMetadata,
    });
  }

  // Provider-hydrated history rows carry digest-derived ids that never
  // match the ids of app-created messages, so the same utterance can exist
  // twice (web row + hydrated `native-item` row). Hydrated rows also carry
  // synthetic timestamps (binding creation plus ordinal), so wall-clock
  // proximity cannot identify echoes. Skip hydrated orphan rows whose role
  // and text match a committed message, consuming one committed occurrence
  // per skipped row so genuinely repeated identical messages still render.
  const committedIndexesByText = new Map<string, Array<number>>();
  entries.forEach((entry, index) => {
    if (entry.kind !== "message") return;
    const key = `${entry.message.role}\n${entry.message.text}`;
    const bucket = committedIndexesByText.get(key) ?? [];
    bucket.push(index);
    committedIndexesByText.set(key, bucket);
  });
  const orphanProjectedMessages: Array<OrchestrationV2ConversationMessage> = [];
  for (const projectedMessage of input.projectionMessages ?? []) {
    if (committedMessageIds.has(projectedMessage.id) || projectedMessage.role === "system") {
      continue;
    }
    if (PROVIDER_HYDRATED_MESSAGE_ID_PATTERN.test(projectedMessage.id)) {
      const key = `${projectedMessage.role}\n${projectedMessage.text}`;
      const committedIndex = committedIndexesByText.get(key)?.shift();
      const committed = committedIndex === undefined ? undefined : entries[committedIndex];
      if (committedIndex !== undefined && committed?.kind === "message") {
        // An attachment-bearing echo still deduplicates; its attachments are
        // merged onto the committed entry when that entry has none.
        if (
          projectedMessage.attachments.length > 0 &&
          (committed.message.attachments === undefined ||
            committed.message.attachments.length === 0)
        ) {
          entries[committedIndex] = {
            ...committed,
            message: {
              ...committed.message,
              attachments: projectedMessage.attachments.map((attachment) => {
                const previewUrl = input.attachmentUrlById?.get(attachment.id);
                return previewUrl ? { ...attachment, previewUrl } : attachment;
              }),
            },
          };
        }
        continue;
      }
    }
    orphanProjectedMessages.push(projectedMessage);
  }
  for (const projectedMessage of orphanProjectedMessages) {
    const message: ChatMessage = {
      id: projectedMessage.id,
      role: projectedMessage.role,
      text: projectedMessage.text,
      ...(projectedMessage.attachments.length > 0
        ? {
            attachments: projectedMessage.attachments.map((attachment) => {
              const previewUrl = input.attachmentUrlById?.get(attachment.id);
              return previewUrl ? { ...attachment, previewUrl } : attachment;
            }),
          }
        : {}),
      runId: projectedMessage.runId,
      streaming: projectedMessage.streaming,
      createdBy: projectedMessage.createdBy,
      creationSource: projectedMessage.creationSource,
      createdAt: DateTime.formatIso(projectedMessage.createdAt),
      updatedAt: DateTime.formatIso(projectedMessage.updatedAt),
    };
    const entry: TimelineEntry = {
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    };
    const insertionIndex = entries.findIndex(
      (candidate) => Date.parse(candidate.createdAt) > Date.parse(entry.createdAt),
    );
    if (insertionIndex === -1) {
      entries.push(entry);
    } else {
      entries.splice(insertionIndex, 0, entry);
    }
    committedMessageIds.add(message.id);
  }

  for (const message of input.optimisticMessages) {
    if (message.inputIntent !== "queued_turn" && !committedMessageIds.has(message.id)) {
      entries.push({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      });
    }
  }

  return entries;
}

export function inferCheckpointTurnCountByRunId(
  summaries: ReadonlyArray<ThreadCheckpointSummary>,
): Record<string, number> {
  return Object.fromEntries(
    summaries.flatMap((summary) =>
      summary.runId === null ? [] : [[summary.runId, summary.checkpointTurnCount] as const],
    ),
  );
}

export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
}): Map<ChatMessage["id"], number> {
  const readyCheckpointByRunId = new Map<RunId, ThreadCheckpointSummary>();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status === "ready") {
      readyCheckpointByRunId.set(checkpoint.runId, checkpoint);
    }
  }
  const byUserMessageId = new Map<ChatMessage["id"], number>();
  for (const entry of input.timelineEntries) {
    if (entry.kind !== "message" || entry.message.role !== "user") continue;
    if (entry.message.inputIntent !== "turn_start" && entry.message.inputIntent !== "queued_turn") {
      continue;
    }
    if (entry.message.runId === null) continue;
    const checkpoint = readyCheckpointByRunId.get(entry.message.runId);
    if (checkpoint === undefined) continue;
    byUserMessageId.set(entry.message.id, Math.max(0, checkpoint.checkpointTurnCount - 1));
  }
  return byUserMessageId;
}

export function derivePhase(runtime: ThreadRuntimeSummary | null): SessionPhase {
  if (runtime === null) return "disconnected";
  if (
    runtime.status === "preparing" ||
    runtime.status === "starting" ||
    runtime.status === "queued"
  )
    return "connecting";
  if (runtime.status === "running" || runtime.status === "waiting") return "running";
  return "ready";
}

export type { TurnDiffSummary };
