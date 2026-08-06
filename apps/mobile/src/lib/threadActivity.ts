import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  resolveT3McpToolPresentation,
  type T3McpToolLogo,
  type T3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";
import type {
  ChatAttachment,
  MessageId,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2RunAttempt,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { orchestrationV2TurnItemStatusIsTerminal } from "@t3tools/contracts";
import { presentProviderError } from "@t3tools/client-runtime/errors";
import { dynamicToolInputPreview } from "@t3tools/shared/dynamicToolPreview";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  formatOrchestrationV2RollbackDetail,
  orchestrationV2TimelineDayKey,
  resolveOrchestrationV2ItemAttempt,
} from "@t3tools/shared/orchestrationV2Timeline";
import * as DateTime from "effect/DateTime";

import { isV2LifecycleTimelineItem } from "./threadLifecycle";

export type PendingApproval = ThreadPendingApproval;
export type PendingUserInput = ThreadPendingUserInput;

const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionLabel?: string;
  readonly customAnswer?: string;
}

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
  readonly icon:
    | "agent"
    | "alert"
    | "check"
    | "command"
    | "edit"
    | "eye"
    | "globe"
    | "hammer"
    | "message"
    | "warning"
    | "wrench"
    | "zap";
  readonly logo: T3McpToolLogo | null;
  readonly toolLike: boolean;
  readonly prominent: boolean;
  readonly status: "success" | "failure" | "neutral" | null;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}

export interface ThreadFeedMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly runId: RunId | null;
  readonly streaming: boolean;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}

export type ThreadFeedAttempt = Pick<
  OrchestrationV2RunAttempt,
  "id" | "runId" | "attemptOrdinal" | "rootNodeId" | "status"
>;

type RawThreadFeedEntryVariant =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: ThreadFeedMessage;
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activity: ThreadFeedActivity;
    }
  | {
      readonly type: "lifecycle";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly row: OrchestrationV2ProjectedTurnItem;
    };

interface ThreadFeedAttemptMetadata {
  /** Resolved from the item's execution node, when the nodes are local. */
  readonly attempt?: ThreadFeedAttempt;
}

// Distributive so that narrowing on `type` still picks a single member; a plain
// `Union & Metadata` intersection would collapse into one unnarrowable type.
type WithAttemptMetadata<T> = T extends unknown ? T & ThreadFeedAttemptMetadata : never;

type RawThreadFeedEntry = WithAttemptMetadata<RawThreadFeedEntryVariant>;

type ThreadFeedEntryVariant =
  | Extract<RawThreadFeedEntryVariant, { type: "message" }>
  | Extract<RawThreadFeedEntryVariant, { type: "lifecycle" }>
  | {
      readonly type: "working";
      readonly id: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    }
  | {
      readonly type: "agent-updates";
      readonly id: string;
      readonly createdAt: string;
      readonly messages: ReadonlyArray<ThreadFeedMessage>;
    }
  | {
      readonly type: "lifecycle-group";
      readonly id: string;
      readonly createdAt: string;
      readonly entries: ReadonlyArray<Extract<RawThreadFeedEntryVariant, { type: "lifecycle" }>>;
    }
  | {
      readonly type: "work-toggle";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly groupId: string;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly onlyToolActivities: boolean;
      readonly hiddenAdditions: number;
      readonly hiddenDeletions: number;
    }
  | {
      readonly type: "run-fold";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId;
      readonly label: string;
      readonly expanded: boolean;
    }
  | {
      readonly type: "attempt-fold";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId;
      readonly attemptId: RunAttemptId;
      readonly label: string;
      readonly expanded: boolean;
    }
  | {
      readonly type: "chat-cleared";
      readonly id: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "day-divider";
      readonly id: string;
      readonly createdAt: string;
    };

export type ThreadFeedEntry = WithAttemptMetadata<ThreadFeedEntryVariant>;

export interface ThreadFeedLatestRun {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  return (
    normalizeDraftAnswer(draft?.customAnswer) ?? normalizeDraftAnswer(draft?.selectedOptionLabel)
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? value : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function memoizeValue<T>(build: () => T): () => T {
  let value: T;
  let initialized = false;
  return () => {
    if (!initialized) {
      value = build();
      initialized = true;
    }
    return value;
  };
}

function itemIsToolLike(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "reasoning" ||
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "file_search" ||
    item.type === "web_search" ||
    item.type === "approval_request" ||
    item.type === "user_input_request" ||
    item.type === "dynamic_tool" ||
    item.type === "subagent" ||
    item.type === "error"
  );
}

function itemIsProminent(item: OrchestrationV2TurnItem): boolean {
  return item.type === "fork" || item.type === "thread_created" || item.type === "subagent";
}

function itemStatus(item: OrchestrationV2TurnItem): ThreadFeedActivity["status"] {
  if (!itemIsToolLike(item)) return null;
  if (item.type === "error" || item.status === "failed") return "failure";
  return item.status === "completed" ? "success" : "neutral";
}

function itemIcon(item: OrchestrationV2TurnItem): ThreadFeedActivity["icon"] {
  switch (item.type) {
    case "reasoning":
      return "agent";
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_search":
      return "eye";
    case "web_search":
      return "globe";
    case "approval_request":
    case "user_input_request":
    case "user_message":
    case "assistant_message":
      return "message";
    case "dynamic_tool":
      // Read-style tool calls (a file/notebook path argument) present as reads.
      return dynamicToolInputPreview(item.input)?.kind === "path" ? "eye" : "wrench";
    case "subagent":
      return "hammer";
    case "run_interrupt_request":
    case "run_interrupt_result":
      return "warning";
    case "error":
      return "alert";
    case "checkpoint":
    case "proposed_plan":
    case "todo_list":
      return "check";
    case "checkpoint_rollback":
    case "compaction":
    case "handoff":
    case "fork":
    case "thread_created":
      return "zap";
  }
}

function itemToolPresentation(item: OrchestrationV2TurnItem): T3McpToolPresentation | null {
  if (item.type !== "dynamic_tool") {
    return null;
  }
  return resolveT3McpToolPresentation(item.toolName) ?? resolveT3McpToolPresentation(item.title);
}

function itemSummary(
  item: OrchestrationV2TurnItem,
  toolPresentation: T3McpToolPresentation | null = null,
): string {
  const title = item.title?.trim();
  if (title) return toolPresentation?.displayName ?? capitalizePhrase(title);
  switch (item.type) {
    case "reasoning":
      return "Thinking";
    case "command_execution":
      // A command that outlives its turn needs to say so: on a phone the turn
      // footer is often the only thing on screen, and "Command" next to a
      // finished turn reads as finished.
      return item.background === true
        ? item.waitKind === "monitor"
          ? "Waiting for a condition"
          : "Background command"
        : "Command";
    case "file_change":
      return `Changed ${item.fileName}`;
    case "file_search":
      return "Searched files";
    case "web_search":
      return "Searched the web";
    case "approval_request":
      return "Approval requested";
    case "user_input_request":
      return "Input requested";
    case "checkpoint":
      return "Checkpoint captured";
    case "checkpoint_rollback":
      return "Rolled back";
    case "run_interrupt_request":
      return "Interrupt requested";
    case "run_interrupt_result":
      return "Run interrupted";
    case "error":
      return "Provider error";
    case "compaction":
      return "Chat compacted";
    case "handoff":
      return "Context handed off";
    case "fork":
      return "Thread forked";
    case "thread_created":
      return "Thread created";
    case "subagent":
      return "Subagent";
    case "dynamic_tool":
      return toolPresentation?.displayName ?? item.toolName ?? "Tool call";
    case "proposed_plan":
      return "Proposed plan";
    case "todo_list":
      return "Plan updated";
    case "user_message":
      return "User message";
    case "assistant_message":
      return "Assistant message";
  }
}

/** Last line a background command printed, which is its only live signal. */
function backgroundCommandTail(output: string | undefined): string | null {
  if (output === undefined) return null;
  const lines = output.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length > 0) return line;
  }
  return null;
}

function itemPreview(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "reasoning":
      return item.text || null;
    case "command_execution": {
      // While a background command runs, what it is printing beats what it was
      // asked to do — the command text is already in the summary line.
      if (item.background === true && !orchestrationV2TurnItemStatusIsTerminal(item.status)) {
        return backgroundCommandTail(item.output) ?? (item.input || null);
      }
      return item.input || null;
    }
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? null;
    case "web_search":
      return item.patterns?.join(", ") ?? null;
    case "approval_request":
      return item.prompt ?? null;
    case "user_input_request":
      return item.questions.map((question) => question.question).join(" · ") || null;
    case "checkpoint":
      return item.files.length === 1
        ? (item.files[0]?.path ?? null)
        : `${item.files.length} changed files`;
    case "run_interrupt_request":
    case "run_interrupt_result":
      return item.message || null;
    case "error":
      // Provider failures arrive wrapped in adapter names, run ids and
      // provider-thread ids. Present the operational next step instead.
      return presentProviderError(item.failure.message);
    case "checkpoint_rollback":
      return formatOrchestrationV2RollbackDetail(item);
    case "compaction":
    case "handoff":
      return item.summary ?? null;
    case "fork":
    case "thread_created":
      return item.targetThreadId;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      // Surface read-style tool arguments (file path / search pattern) inline —
      // otherwise a Read row is just "Read" with the path hidden in the inspector.
      return dynamicToolInputPreview(item.input)?.value ?? null;
    case "proposed_plan":
      return item.markdown || null;
    case "todo_list":
      return `${item.steps.filter((step) => step.status === "completed").length}/${item.steps.length} completed`;
    case "user_message":
    case "assistant_message":
      return item.text || null;
  }
}

function toFeedActivity(row: OrchestrationV2ProjectedTurnItem): ThreadFeedActivity {
  const item = row.item;
  const toolPresentation = itemToolPresentation(item);
  const summary = itemSummary(item, toolPresentation);
  const detail = itemPreview(item);
  const getFullDetail = memoizeValue(() =>
    JSON.stringify(
      {
        visibility: row.visibility,
        sourceThreadId: row.sourceThreadId,
        sourceItemId: row.sourceItemId,
        item,
      },
      null,
      2,
    ),
  );
  const getCopyText = memoizeValue(() =>
    [summary, detail, getFullDetail()]
      .filter(
        (value, index, values): value is string =>
          Boolean(value) && values.indexOf(value) === index,
      )
      .join("\n"),
  );
  return {
    id: `${row.visibility}:${row.sourceThreadId}:${row.sourceItemId}`,
    createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
    runId: item.runId,
    summary,
    detail,
    canExpand: true,
    getFullDetail,
    getCopyText,
    icon: itemIcon(item),
    logo: toolPresentation?.logo ?? null,
    toolLike: itemIsToolLike(item),
    prominent: itemIsProminent(item),
    status: itemStatus(item),
    projectedItem: row,
  };
}

function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.text.trim().length === 0 &&
    entry.message.attachments.length === 0
  );
}

function groupAdjacentActivities(entries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[] {
  const grouped: ThreadFeedEntry[] = [];
  // Mutable backing array for the trailing group so appending an activity is
  // O(1) instead of re-copying the group (which made this loop quadratic on
  // long tool runs). The array is only mutated while it is the trailing group.
  let openGroupActivities: ThreadFeedActivity[] | null = null;
  let openGroupRunId: string | null = null;
  let openGroupAttemptId: string | null = null;
  let openGroupHasProminent = false;

  for (const entry of entries) {
    if (isEmptyMessage(entry)) continue;
    if (entry.type !== "activity") {
      grouped.push(entry);
      openGroupActivities = null;
      continue;
    }

    if (
      openGroupActivities !== null &&
      openGroupRunId === entry.runId &&
      // A group is the unit that folds, so it must not straddle attempts:
      // merging a superseded attempt's work into the live one would make the
      // fold either hide too much or nothing at all.
      openGroupAttemptId === (entry.attempt?.id ?? null) &&
      !entry.activity.prominent &&
      !openGroupHasProminent
    ) {
      openGroupActivities.push(entry.activity);
      continue;
    }

    openGroupActivities = [entry.activity];
    openGroupRunId = entry.runId;
    openGroupAttemptId = entry.attempt?.id ?? null;
    openGroupHasProminent = entry.activity.prominent === true;
    grouped.push({
      type: "activity-group",
      id: entry.id,
      createdAt: entry.createdAt,
      runId: entry.runId,
      activities: openGroupActivities,
      ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    });
  }
  return grouped;
}

type AgentUpdateMessageEntry = Extract<ThreadFeedEntry, { readonly type: "message" }>;

function isAgentUpdateMessageEntry(entry: ThreadFeedEntry): entry is AgentUpdateMessageEntry {
  return (
    entry.type === "message" && entry.message.role === "user" && entry.message.createdBy === "agent"
  );
}

// Consecutive agent-authored prompts (delegated-task wakes and other injected
// instructions) collapse into one "agent-updates" group — a run of near-
// identical machine callbacks shouldn't occupy a bubble each. Singles keep
// their ordinary message presentation.
export function mergeAgentUpdateRuns(entries: ThreadFeedEntry[]): ThreadFeedEntry[] {
  const result: ThreadFeedEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (!isAgentUpdateMessageEntry(entry)) {
      result.push(entry);
      index += 1;
      continue;
    }
    const run: AgentUpdateMessageEntry[] = [entry];
    while (index + run.length < entries.length) {
      const candidate = entries[index + run.length]!;
      if (!isAgentUpdateMessageEntry(candidate)) break;
      run.push(candidate);
    }
    if (run.length < 2) {
      result.push(entry);
    } else {
      result.push({
        type: "agent-updates",
        // Anchored to the first message so the group id stays stable as later
        // updates append to it.
        id: `agent-updates:${entry.id}`,
        createdAt: entry.createdAt,
        messages: run.map((messageEntry) => messageEntry.message),
      });
    }
    index += run.length;
  }
  return result;
}

type LifecycleFeedEntry = Extract<ThreadFeedEntry, { readonly type: "lifecycle" }>;

// The lifecycle items ThreadLifecycleRow renders as a bordered "related thread"
// card — see RelatedThreadCard. Dividers and interrupt lines are not cards and
// never join a group.
const RELATED_THREAD_CARD_ITEM_TYPES = new Set(["subagent", "thread_created"]);

function isRelatedThreadCardEntry(entry: ThreadFeedEntry): entry is LifecycleFeedEntry {
  return entry.type === "lifecycle" && RELATED_THREAD_CARD_ITEM_TYPES.has(entry.row.item.type);
}

// Consecutive related-thread cards (a fan-out of subagents, say) are identically
// shaped boxes stacked with a gap between them. They read as one list, so a run
// collapses into a single card whose entries are separated by dividers. Singles
// keep their ordinary standalone card.
export function mergeRelatedThreadCardRuns(entries: ThreadFeedEntry[]): ThreadFeedEntry[] {
  const result: ThreadFeedEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;
    if (!isRelatedThreadCardEntry(entry)) {
      result.push(entry);
      index += 1;
      continue;
    }
    const run: LifecycleFeedEntry[] = [entry];
    while (index + run.length < entries.length) {
      const candidate = entries[index + run.length]!;
      if (!isRelatedThreadCardEntry(candidate)) break;
      run.push(candidate);
    }
    if (run.length < 2) {
      result.push(entry);
    } else {
      result.push({
        type: "lifecycle-group",
        // Anchored to the first card so the group id stays stable as later
        // cards join it.
        id: `lifecycle-group:${entry.id}`,
        createdAt: entry.createdAt,
        entries: run,
      });
    }
    index += run.length;
  }
  return result;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function maxIsoTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function unsettledRunId(latestRun: ThreadFeedLatestRun | null): RunId | null {
  return threadFeedRunIsUnsettled(latestRun) ? latestRun.runId : null;
}

export function threadFeedRunIsUnsettled(
  run: ThreadFeedLatestRun | null,
): run is ThreadFeedLatestRun {
  return (
    run !== null &&
    (run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting")
  );
}

interface ThreadFeedRunFold {
  readonly runId: RunId;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

function deriveThreadFeedRunFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
): ReadonlyMap<string, ThreadFeedRunFold> {
  const terminalAssistantMessageIdByRun = new Map<RunId, string>();
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.runId) {
      terminalAssistantMessageIdByRun.set(entry.message.runId, entry.id);
    }
  }

  const groupsByRunId = new Map<
    RunId,
    { entries: ThreadFeedEntry[]; startBoundary: string | null }
  >();
  let pendingUserBoundary: string | null = null;
  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const runId =
      entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.runId
        : entry.type === "activity-group"
          ? entry.runId
          : null;
    if (!runId) continue;
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = { entries: [], startBoundary: pendingUserBoundary };
      pendingUserBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
  }

  const activeRunId = unsettledRunId(latestRun);
  const foldsByAnchorId = new Map<string, ThreadFeedRunFold>();
  for (const [runId, group] of groupsByRunId) {
    if (
      runId === activeRunId ||
      group.entries.some((entry) => entry.type === "message" && entry.message.streaming)
    ) {
      continue;
    }
    const terminalAssistantId = terminalAssistantMessageIdByRun.get(runId);
    const hiddenEntryIds = new Set(
      group.entries
        .filter(
          (entry) =>
            entry.id !== terminalAssistantId &&
            !(
              entry.type === "activity-group" &&
              entry.activities.some((activity) => activity.prominent)
            ),
        )
        .map((entry) => entry.id),
    );
    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (hiddenEntryIds.size === 0 || !firstEntry || !lastEntry) continue;
    const terminalEntry = terminalAssistantId
      ? group.entries.find((entry) => entry.id === terminalAssistantId)
      : null;
    const latestRunMatches = latestRun?.runId === runId;
    const lastEntryEnd =
      lastEntry.type === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      latestRunMatches && latestRun.startedAt && latestRun.completedAt
        ? computeElapsedMs(latestRun.startedAt, latestRun.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(
              terminalEntry?.type === "message" ? terminalEntry.message.updatedAt : null,
              lastEntryEnd,
            ) ?? lastEntryEnd,
          );
    const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
    const interrupted =
      latestRunMatches && (latestRun.status === "interrupted" || latestRun.status === "cancelled");
    foldsByAnchorId.set(firstEntry.id, {
      runId,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label: interrupted
        ? duration
          ? `You stopped after ${duration}`
          : "You stopped this response"
        : duration
          ? `Worked for ${duration}`
          : "Worked",
    });
  }
  return foldsByAnchorId;
}

/**
 * Superseded attempts collapse behind one boundary row, keyed by the first
 * entry each attempt contributed. Ports the web timeline's rule: user messages
 * stay put, everything the discarded attempt produced folds away.
 */
function deriveThreadFeedAttemptFolds(
  entries: ReadonlyArray<ThreadFeedEntry>,
): ReadonlyMap<string, SupersededAttemptFold> {
  const entriesByAttemptId = new Map<RunAttemptId, ThreadFeedEntry[]>();
  for (const entry of entries) {
    if (
      entry.attempt?.status !== "superseded" ||
      (entry.type === "message" && entry.message.role === "user")
    ) {
      continue;
    }
    const bucket = entriesByAttemptId.get(entry.attempt.id) ?? [];
    bucket.push(entry);
    entriesByAttemptId.set(entry.attempt.id, bucket);
  }

  const foldsByAnchorId = new Map<string, SupersededAttemptFold>();
  for (const bucket of entriesByAttemptId.values()) {
    const firstEntry = bucket[0];
    const attempt = firstEntry?.attempt;
    if (firstEntry === undefined || attempt === undefined) continue;
    foldsByAnchorId.set(firstEntry.id, {
      runId: attempt.runId,
      attemptId: attempt.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds: new Set(bucket.map((entry) => entry.id)),
    });
  }
  return foldsByAnchorId;
}

interface SupersededAttemptFold {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

/**
 * A boundary between calendar days, so a thread picked up over a week doesn't
 * read as one sitting. Only between days: the first day carries no divider,
 * because there is nothing above it to separate from.
 */
function insertThreadFeedDayDividers(entries: ThreadFeedEntry[]): ThreadFeedEntry[] {
  const result: ThreadFeedEntry[] = [];
  let previousDayKey: string | null = null;
  for (const entry of entries) {
    const dayKey = orchestrationV2TimelineDayKey(entry.createdAt);
    if (dayKey !== null) {
      if (previousDayKey !== null && dayKey !== previousDayKey) {
        result.push({
          type: "day-divider",
          id: `day-divider:${dayKey}`,
          createdAt: entry.createdAt,
        });
      }
      previousDayKey = dayKey;
    }
    result.push(entry);
  }
  return result;
}

export function deriveThreadFeedPresentation(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
  expandedRunIds: ReadonlySet<RunId>,
  expandedWorkGroupIds: ReadonlySet<string> = new Set(),
  activeWorkStartedAt: string | null = null,
  options?: {
    /** Hermes "clear chat" marker: entries at or before it are dropped. */
    readonly timelineClearedAt?: string | null;
    readonly expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  },
): ThreadFeedEntry[] {
  const expandedAttemptIds = options?.expandedAttemptIds ?? new Set<RunAttemptId>();
  const clearedAt = options?.timelineClearedAt ?? null;
  const clearedAtMs = clearedAt === null ? Number.NaN : Date.parse(clearedAt);
  const chatWasCleared = Number.isFinite(clearedAtMs);
  // Kept as its own narrowing filter: the inferred type predicate is what lets
  // appendPresentedFeedEntry take the reduced union. Mixing in the cleared-at
  // test below would defeat that inference.
  const presentableFeed = feed.filter(
    (entry) =>
      entry.type !== "run-fold" &&
      entry.type !== "work-toggle" &&
      entry.type !== "working" &&
      entry.type !== "day-divider" &&
      entry.type !== "chat-cleared" &&
      entry.type !== "attempt-fold",
  );
  const sourceFeed = chatWasCleared
    ? presentableFeed.filter((entry) => Date.parse(entry.createdAt) > clearedAtMs)
    : presentableFeed;
  const foldsByAnchorId = deriveThreadFeedRunFolds(sourceFeed, latestRun);
  const attemptFoldsByAnchorId = deriveThreadFeedAttemptFolds(sourceFeed);
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorId.values()) {
    if (!expandedRunIds.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId);
    }
  }
  const collapsedAttemptEntryIds = new Set<string>();
  for (const fold of attemptFoldsByAnchorId.values()) {
    if (!expandedAttemptIds.has(fold.attemptId)) {
      for (const entryId of fold.hiddenEntryIds) collapsedAttemptEntryIds.add(entryId);
    }
  }
  const result: ThreadFeedEntry[] = [];
  if (chatWasCleared && clearedAt !== null) {
    result.push({
      type: "chat-cleared",
      id: `chat-cleared:${clearedAt}`,
      createdAt: clearedAt,
    });
  }
  for (const entry of sourceFeed) {
    const fold = foldsByAnchorId.get(entry.id);
    if (fold) {
      result.push({
        type: "run-fold",
        id: `run-fold:${fold.runId}`,
        createdAt: fold.createdAt,
        runId: fold.runId,
        label: fold.label,
        expanded: expandedRunIds.has(fold.runId),
      });
    }
    if (collapsedEntryIds.has(entry.id)) continue;
    const attemptFold = attemptFoldsByAnchorId.get(entry.id);
    if (attemptFold) {
      result.push({
        type: "attempt-fold",
        id: `attempt-fold:${attemptFold.attemptId}`,
        createdAt: attemptFold.createdAt,
        runId: attemptFold.runId,
        attemptId: attemptFold.attemptId,
        label: "Superseded attempt",
        expanded: expandedAttemptIds.has(attemptFold.attemptId),
      });
    }
    if (!collapsedAttemptEntryIds.has(entry.id)) {
      appendPresentedFeedEntry(result, entry, expandedWorkGroupIds);
    }
  }
  if (activeWorkStartedAt !== null) {
    result.push({
      type: "working",
      id: "working-indicator-row",
      createdAt: activeWorkStartedAt,
    });
  }
  return insertThreadFeedDayDividers(result);
}

export function activityFileDiffStats(
  activity: ThreadFeedActivity,
): { readonly additions: number; readonly deletions: number } | null {
  const item = activity.projectedItem.item;
  if (item.type !== "file_change") return null;
  const additions = item.additions ?? 0;
  const deletions = item.deletions ?? 0;
  return additions > 0 || deletions > 0 ? { additions, deletions } : null;
}

export function sumActivityFileDiffStats(activities: ReadonlyArray<ThreadFeedActivity>): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const activity of activities) {
    const stats = activityFileDiffStats(activity);
    if (stats) {
      additions += stats.additions;
      deletions += stats.deletions;
    }
  }
  return { additions, deletions };
}

function appendPresentedFeedEntry(
  result: ThreadFeedEntry[],
  entry: Exclude<
    ThreadFeedEntry,
    {
      readonly type:
        | "run-fold"
        | "work-toggle"
        | "working"
        | "attempt-fold"
        | "chat-cleared"
        | "day-divider";
    }
  >,
  expandedWorkGroupIds: ReadonlySet<string>,
): void {
  if (entry.type !== "activity-group") {
    result.push(entry);
    return;
  }

  const activities = entry.activities.filter(
    (activity) => !(activity.toolLike && activity.status === "neutral"),
  );
  if (activities.length === 0) {
    return;
  }
  if (activities.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
    result.push({
      ...entry,
      activities,
    });
    return;
  }

  const groupId = entry.id;
  const expanded = expandedWorkGroupIds.has(groupId);
  const hiddenCount = activities.length - MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleActivities = expanded ? activities : activities.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);
  const hiddenStats = sumActivityFileDiffStats(
    activities.slice(0, activities.length - MAX_VISIBLE_WORK_LOG_ENTRIES),
  );

  for (const activity of visibleActivities) {
    result.push({
      type: "activity-group",
      id: activity.id,
      createdAt: activity.createdAt,
      runId: activity.runId,
      activities: [activity],
    });
  }
  result.push({
    type: "work-toggle",
    id: `work-toggle:${groupId}`,
    createdAt: entry.createdAt,
    runId: entry.runId,
    groupId,
    hiddenCount,
    expanded,
    onlyToolActivities: activities.every((activity) => activity.toolLike),
    hiddenAdditions: hiddenStats.additions,
    hiddenDeletions: hiddenStats.deletions,
  });
}
export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabel =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabel;
  return { customAnswer, ...(selectedOptionLabel ? { selectedOptionLabel } : {}) };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id]);
    if (!answer) return null;
    answers[question.id] = answer;
  }
  return answers;
}

/**
 * Projects the server-authored visible sequence into mobile row presentation.
 * It deliberately preserves the incoming order and never rebuilds chat from
 * separate message, plan, or work-entry collections.
 */
export function buildThreadFeed(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  /**
   * Run attempts and execution nodes from the thread projection. Optional
   * because most callers don't need attempt identity; without them the feed is
   * identical minus superseded-attempt folding.
   */
  attemptContext?: {
    readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
    readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
  },
): ThreadFeedEntry[] {
  const attemptByRootNodeId = new Map(
    (attemptContext?.attempts ?? []).map(
      (attempt) => [String(attempt.rootNodeId), attempt] as const,
    ),
  );
  const nodeById = new Map(
    (attemptContext?.nodes ?? []).map((node) => [String(node.id), node] as const),
  );
  const entries: RawThreadFeedEntry[] = [];
  for (const row of visibleTurnItems) {
    const item = row.item;
    const attempt =
      attemptByRootNodeId.size === 0
        ? undefined
        : resolveOrchestrationV2ItemAttempt({ item, attemptByRootNodeId, nodeById });
    const attemptMetadata = attempt === undefined ? {} : { attempt };
    const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
    if (item.type === "user_message" || item.type === "assistant_message") {
      const updatedAt = DateTime.formatIso(item.updatedAt);
      entries.push({
        type: "message",
        id: item.messageId,
        createdAt,
        message: {
          id: item.messageId,
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          attachments: item.type === "user_message" ? item.attachments : [],
          runId: item.runId,
          streaming: item.type === "assistant_message" && item.streaming,
          ...(item.type === "user_message"
            ? {
                inputIntent: item.inputIntent,
                createdBy: item.createdBy,
                creationSource: item.creationSource,
              }
            : {}),
          visibility: row.visibility,
          sourceThreadId: row.sourceThreadId,
          createdAt,
          updatedAt,
          projectedItem: row,
        },
        ...attemptMetadata,
      });
      continue;
    }
    if (isV2LifecycleTimelineItem(item)) {
      entries.push({
        type: "lifecycle",
        id: `lifecycle:${row.sourceThreadId}:${row.sourceItemId}`,
        createdAt,
        runId: item.runId,
        row,
        ...attemptMetadata,
      });
      continue;
    }
    const activity = toFeedActivity(row);
    entries.push({
      type: "activity",
      id: activity.id,
      createdAt,
      runId: item.runId,
      activity,
      ...attemptMetadata,
    });
  }
  return mergeRelatedThreadCardRuns(mergeAgentUpdateRuns(groupAdjacentActivities(entries)));
}
