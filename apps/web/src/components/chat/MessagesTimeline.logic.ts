import * as Equal from "effect/Equal";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type TurnId } from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const SUBAGENT_PROGRESS_ENTRY_PREFIX = "codex-subagent-progress:";

const AGENT_COLOR_PALETTE = [
  {
    code: "blue",
    accent: "rgb(37 99 235)",
    border: "rgb(37 99 235 / 0.38)",
    text: "rgb(96 165 250)",
  },
  {
    code: "emerald",
    accent: "rgb(5 150 105)",
    border: "rgb(5 150 105 / 0.38)",
    text: "rgb(52 211 153)",
  },
  {
    code: "amber",
    accent: "rgb(217 119 6)",
    border: "rgb(217 119 6 / 0.38)",
    text: "rgb(251 191 36)",
  },
  {
    code: "rose",
    accent: "rgb(225 29 72)",
    border: "rgb(225 29 72 / 0.38)",
    text: "rgb(251 113 133)",
  },
  {
    code: "cyan",
    accent: "rgb(8 145 178)",
    border: "rgb(8 145 178 / 0.38)",
    text: "rgb(34 211 238)",
  },
  {
    code: "violet",
    accent: "rgb(124 58 237)",
    border: "rgb(124 58 237 / 0.38)",
    text: "rgb(167 139 250)",
  },
  {
    code: "lime",
    accent: "rgb(101 163 13)",
    border: "rgb(101 163 13 / 0.38)",
    text: "rgb(163 230 53)",
  },
  {
    code: "fuchsia",
    accent: "rgb(192 38 211)",
    border: "rgb(192 38 211 / 0.38)",
    text: "rgb(232 121 249)",
  },
] as const;

export interface AgentActivityColor {
  code: string;
  accent: string;
  border: string;
  text: string;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      completionSummary: string | null;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function isSubagentProgressEntryId(value: string): boolean {
  return value.startsWith(SUBAGENT_PROGRESS_ENTRY_PREFIX);
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function resolveAgentActivityColor(agentKey: string): AgentActivityColor {
  return (
    AGENT_COLOR_PALETTE[hashString(agentKey) % AGENT_COLOR_PALETTE.length] ??
    AGENT_COLOR_PALETTE[0]!
  );
}

export function resolveCompactWorkEntryText(input: {
  readonly heading: string;
  readonly rawPreview: string | null;
}): {
  readonly preview: string | null;
  readonly visibleText: string;
  readonly contextText: string;
  readonly visibleTextIsPreview: boolean;
} {
  const rawPreview = input.rawPreview?.trim() ? input.rawPreview : null;
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(input.heading).toLowerCase()
      ? null
      : rawPreview;

  if (!preview) {
    return {
      preview: null,
      visibleText: input.heading,
      contextText: input.heading,
      visibleTextIsPreview: false,
    };
  }

  return {
    preview,
    visibleText: preview,
    contextText: `${input.heading} - ${preview}`,
    visibleTextIsPreview: true,
  };
}

function normalizePreviewPath(value: string, workspaceRoot: string | undefined): string {
  return formatWorkspaceRelativePath(value, workspaceRoot)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .toLowerCase();
}

function formatChangedFilesPreview(
  changedFiles: ReadonlyArray<string> | undefined,
  workspaceRoot: string | undefined,
): string | null {
  const [firstPath] = changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  const changedFileCount = changedFiles?.length ?? 0;
  return changedFileCount === 1 ? displayPath : `${displayPath} +${changedFileCount - 1} more`;
}

function detailMatchesChangedFile(input: {
  readonly detail: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly workspaceRoot: string | undefined;
}): boolean {
  const normalizedDetail = normalizePreviewPath(input.detail, input.workspaceRoot);
  return input.changedFiles.some(
    (filePath) => normalizePreviewPath(filePath, input.workspaceRoot) === normalizedDetail,
  );
}

export function resolveWorkEntryPreview(input: {
  readonly command?: string | undefined;
  readonly detail?: string | undefined;
  readonly changedFiles?: ReadonlyArray<string> | undefined;
  readonly workspaceRoot?: string | undefined;
}): {
  readonly rawPreview: string | null;
  readonly showChangedFileChips: boolean;
} {
  const hasChangedFiles = (input.changedFiles?.length ?? 0) > 0;
  if (input.command) {
    return {
      rawPreview: input.command,
      showChangedFileChips: hasChangedFiles,
    };
  }

  const changedFilesPreview = formatChangedFilesPreview(input.changedFiles, input.workspaceRoot);
  const detail = input.detail?.trim();
  if (
    detail &&
    (!input.changedFiles ||
      !detailMatchesChangedFile({
        detail,
        changedFiles: input.changedFiles,
        workspaceRoot: input.workspaceRoot,
      }))
  ) {
    return {
      rawPreview: detail,
      showChangedFileChips: hasChangedFiles,
    };
  }

  return {
    rawPreview: changedFilesPreview,
    showChangedFileChips: false,
  };
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  completionSummary?: string | null;
  isWorking: boolean;
  activeTurnInProgress?: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      input.activeTurnInProgress === true &&
      input.activeTurnId != null &&
      timelineEntry.message.turnId === input.activeTurnId;

    const showCompletionDivider =
      timelineEntry.message.role === "assistant" &&
      input.completionDividerBeforeEntryId === timelineEntry.id;
    const showAssistantTurnDiffSummary =
      timelineEntry.message.role === "assistant" &&
      !timelineEntry.message.streaming &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider,
      completionSummary: showCompletionDivider ? (input.completionSummary ?? null) : null,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary: showAssistantTurnDiffSummary
        ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
        : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showCompletionDivider === bm.showCompletionDivider &&
        a.completionSummary === bm.completionSummary &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
