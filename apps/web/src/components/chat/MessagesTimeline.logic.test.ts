import {
  EnvironmentId,
  MessageId,
  NodeId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import type { WorkLogEntry, TimelineEntry } from "../../session-logic";
import { describe, expect, it } from "vite-plus/test";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  collapseWorkEntriesKeepingLiveBackground,
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  plainThoughtPreviewText,
  resolveLiveWorkEntry,
  resolveHistoricalWorkSummary,
  resolveAssistantMessageCopyState,
  resolveTimelineToolPresentation,
  shouldCollapseUserMessage,
  shouldPreserveAssistantLineBreaks,
  threadReadLabelPrefix,
  threadReadTargetId,
  threadReadTargetTitle,
} from "./MessagesTimeline.logic";

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves Claude insight formatting without changing regular markdown", () => {
    expect(
      shouldPreserveAssistantLineBreaks(
        "★ Insight ─────────────────\\nFirst observation\\nSecond observation\\n─────────────────",
      ),
    ).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("A normal\\nmarkdown paragraph")).toBe(false);
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveTimelineToolPresentation", () => {
  it("pretty prints Claude and Cursor T3 MCP tool names", () => {
    expect(resolveTimelineToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a T3 thread",
      logo: "t3-code",
    });
  });

  it("pretty prints Codex T3 MCP tool names", () => {
    expect(resolveTimelineToolPresentation("t3-code.create_threads")).toEqual({
      displayName: "Create T3 threads",
      logo: "t3-code",
    });
  });

  it("pretty prints bare T3 MCP toolkit names", () => {
    expect(resolveTimelineToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t3-code",
    });
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveTimelineToolPresentation("mcp__github__search_issues")).toBeNull();
  });
});

describe("thread-read labels", () => {
  it("uses live titles only for active thread shells", () => {
    const shell = { title: " Review auth flow ", archivedAt: null, deletedAt: null };
    expect(threadReadTargetTitle(shell)).toBe("Review auth flow");
    expect(threadReadTargetTitle({ ...shell, title: "Harden session refresh" })).toBe(
      "Harden session refresh",
    );
    expect(threadReadTargetTitle({ ...shell, archivedAt: "2026-10-07T12:00:00Z" })).toBeNull();
    expect(threadReadTargetTitle({ ...shell, deletedAt: "2026-10-07T12:00:00Z" })).toBeNull();
    expect(threadReadTargetTitle({ ...shell, title: "  " })).toBeNull();
    expect(threadReadTargetTitle(null)).toBeNull();
  });

  it.each([
    ["inProgress", "Reading thread"],
    ["completed", "Read thread"],
    ["failed", "Failed to read thread"],
    ["declined", "Declined to read thread"],
    ["stopped", "Stopped reading thread"],
  ] as const)("names the read thread in the %s label", (status, prefix) => {
    const input = { threadId: " thread-child ", view: "activity" };
    const entry = {
      structuredPayload: {
        type: "dynamic_tool",
        toolName: "t3-code.t3_thread_read",
        input,
      } as never,
    };
    expect(threadReadTargetId(entry)).toBe("thread-child");
    const heading = resolveTimelineToolPresentation("t3-code.t3_thread_read", status, input);
    expect(threadReadLabelPrefix(heading?.displayName ?? "")).toBe(prefix);
  });

  it("finds no target for other tools or thread reads without one", () => {
    const payload = (toolName: string, input: unknown) => ({
      structuredPayload: { type: "dynamic_tool", toolName, input } as never,
    });
    expect(threadReadTargetId(payload("t3-code.t3_thread_wait", { threadId: "t" }))).toBeNull();
    expect(threadReadTargetId(payload("t3-code.t3_thread_read", { threadId: "  " }))).toBeNull();
    expect(threadReadTargetId(payload("t3-code.t3_thread_read", null))).toBeNull();
    expect(threadReadLabelPrefix("Read a file")).toBeNull();
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("hides entries at or before the clear boundary and keeps a durable marker", () => {
    const rows = deriveMessagesTimelineRows({
      timelineClearedAt: "2026-01-01T00:00:10Z",
      timelineEntries: [
        {
          id: "old-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "old-user" as never,
            role: "user",
            text: "Old message",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "new-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:11Z",
          message: {
            id: "new-user" as never,
            role: "user",
            text: "New message",
            runId: null,
            createdAt: "2026-01-01T00:00:11Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["chat-cleared", "message"]);
    expect(rows[0]).toEqual({
      kind: "chat-cleared",
      id: "chat-cleared:2026-01-01T00:00:10Z",
      createdAt: "2026-01-01T00:00:10Z",
    });
    expect(rows[1]?.id).toBe("new-user-entry");
  });

  it("collapses consecutive agent-sent messages into one agent-updates group", () => {
    const agentMessageEntry = (index: number) => ({
      id: `agent-entry-${index}`,
      kind: "message" as const,
      createdAt: `2026-01-01T00:00:0${index}Z`,
      message: {
        id: `agent-message-${index}` as never,
        role: "user" as const,
        text: `Delegated task "Drain batch ${index}" completed. Use task_status with taskId node:task-${index} to read the result.`,
        runId: null,
        createdBy: "agent" as const,
        createdAt: `2026-01-01T00:00:0${index}Z`,
        updatedAt: `2026-01-01T00:00:0${index}Z`,
        streaming: false,
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        agentMessageEntry(1),
        agentMessageEntry(2),
        agentMessageEntry(3),
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Looks good, continue.",
            runId: null,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["agent-updates", "message"]);
    const group = rows[0];
    if (group?.kind !== "agent-updates") throw new Error("expected agent-updates row");
    expect(group.id).toBe("agent-updates:agent-entry-1");
    expect(group.updates.map((update) => update.id)).toEqual([
      "agent-entry-1",
      "agent-entry-2",
      "agent-entry-3",
    ]);
  });

  it("keeps a lone agent-sent message as an ordinary message row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "agent-entry-solo",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: "agent-message-solo" as never,
            role: "user",
            text: "Check the deploy before continuing.",
            runId: null,
            createdBy: "agent",
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message"]);
  });

  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      runId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("folds interim assistant messages while keeping resource cards and the terminal response", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:10Z",
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-entry-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it("drops the Worked-for row entirely when activity is always expanded", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      alwaysExpandActivity: true,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual([
      "user-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
  });

  it("keeps persistent cards after the Worked-for row when they arrive before commentary", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Spawn a subagent",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:02Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "subagent-card-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:03Z",
        projectedItem: {
          item: {
            type: "subagent",
            runId: "turn-1",
          },
        } as never,
      },
      {
        id: "assistant-commentary-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-commentary" as never,
          role: "assistant" as const,
          text: "I spawned the subagent.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Subagent says: Hello.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "subagent-card-entry",
      "assistant-final-entry",
    ]);
  });

  it("collapses only output from a superseded V2 attempt within the active logical run", () => {
    const runId = "run-steered" as never;
    const supersededAttemptId = "attempt-1" as never;
    const activeAttemptId = "attempt-2" as never;
    const supersededAttempt = {
      id: supersededAttemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: "node-attempt-1" as never,
      status: "superseded" as const,
    };
    const activeAttempt = {
      id: activeAttemptId,
      runId,
      attemptOrdinal: 2,
      rootNodeId: "node-attempt-2" as never,
      status: "running" as const,
    };
    const timelineEntries = [
      {
        id: "initial-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        message: {
          id: "initial-user" as never,
          role: "user" as const,
          text: "Build it",
          runId,
          inputIntent: "turn_start" as const,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "superseded-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:02Z",
        attempt: supersededAttempt,
        message: {
          id: "superseded-assistant" as never,
          role: "assistant" as const,
          text: "Partial old response",
          runId,
          createdAt: "2026-01-01T00:00:02Z",
          updatedAt: "2026-01-01T00:00:03Z",
          streaming: false,
        },
      },
      {
        id: "superseded-work-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:04Z",
        attempt: supersededAttempt,
        entry: {
          id: "superseded-work",
          createdAt: "2026-01-01T00:00:04Z",
          runId,
          label: "Old command",
          tone: "tool" as const,
        },
      },
      {
        id: "superseded-thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:04.500Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "steer-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        attempt: activeAttempt,
        message: {
          id: "steer-user" as never,
          role: "user" as const,
          text: "Change direction",
          runId,
          inputIntent: "steer" as const,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:05Z",
          streaming: false,
        },
      },
      {
        id: "active-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:06Z",
        attempt: activeAttempt,
        message: {
          id: "active-assistant" as never,
          role: "assistant" as const,
          text: "Current response",
          runId,
          createdAt: "2026-01-01T00:00:06Z",
          updatedAt: "2026-01-01T00:00:07Z",
          streaming: true,
        },
      },
    ];
    const common = {
      timelineEntries,
      latestRun: {
        runId,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };

    const collapsedRows = deriveMessagesTimelineRows(common);
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    expect(collapsedRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      attemptId: supersededAttemptId,
      runId,
      label: "Superseded attempt",
      expanded: false,
    });

    const expandedRows = deriveMessagesTimelineRows({
      ...common,
      expandedAttemptIds: new Set([supersededAttemptId]),
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-assistant-entry",
      "superseded-work-entry",
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    // A steer ends the previous turn early: its only message completes the
    // instant it is created, and trailing work entries land after it. The
    // fold duration must span from the user message that started the turn to
    // the last entry, not message createdAt → message updatedAt (~0ms).
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            runId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    // User message (00:00:00) → trailing work entry (00:00:12).
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        runId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("keeps interruption request, intervening work, and result visible in order", () => {
    const runId = "turn-1" as never;
    const interruptEvent = (type: "run_interrupt_request" | "run_interrupt_result") => ({
      position: type === "run_interrupt_request" ? 0 : 2,
      visibility: "local" as const,
      sourceThreadId: "thread-1" as never,
      sourceItemId: `item-${type}` as never,
      item: {
        id: `item-${type}`,
        threadId: "thread-1",
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: type === "run_interrupt_request" ? 0 : 2,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type,
        message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "interrupt-request",
          kind: "event",
          createdAt: "2026-01-01T00:00:01Z",
          projectedItem: interruptEvent("run_interrupt_request") as never,
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:02Z",
            runId,
            label: "Finishing tool output",
            tone: "tool",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "interrupt-request",
      "work-entry",
      "interrupt-result",
    ]);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
  });

  it("merges consecutive subagent cards into one event group", () => {
    const subagentEvent = (index: number) => ({
      position: index,
      visibility: "local" as const,
      sourceThreadId: "thread-1" as never,
      sourceItemId: `item-subagent-${index}` as never,
      item: {
        id: `item-subagent-${index}`,
        threadId: "thread-1",
        runId: "turn-1" as never,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index,
        status: "running",
        title: `Subagent ${index}`,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type: "subagent",
        subagentId: `subagent-${index}`,
        childThreadId: null,
        prompt: "Map the surface",
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "subagent-1",
          kind: "event",
          createdAt: "2026-01-01T00:00:01Z",
          projectedItem: subagentEvent(0) as never,
        },
        {
          id: "subagent-2",
          kind: "event",
          createdAt: "2026-01-01T00:00:02Z",
          projectedItem: subagentEvent(1) as never,
        },
        {
          id: "subagent-3",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: subagentEvent(2) as never,
        },
      ],
      latestRun: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["event-group"]);
    const group = rows[0];
    if (group?.kind !== "event-group") throw new Error("expected event-group row");
    // Anchored to the first card so the id survives later cards joining it.
    expect(group.id).toBe("event-group:subagent-1");
    expect(group.createdAt).toBe("2026-01-01T00:00:01Z");
    expect(group.events.map((event) => event.id)).toEqual([
      "subagent-1",
      "subagent-2",
      "subagent-3",
    ]);
  });

  it("hides a delegation tool row once its returned task id names a child card", () => {
    const runId = "turn-1" as never;
    const child = (id: string) => ({
      id,
      kind: "event" as const,
      createdAt: "2026-01-01T00:00:01Z",
      projectedItem: {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: "thread-1" as never,
        sourceItemId: `item-${id}` as never,
        item: {
          id: `item-${id}`,
          threadId: "thread-1",
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "running",
          title: `Subagent ${id}`,
          startedAt: null,
          completedAt: null,
          updatedAt: {},
          type: "subagent",
          origin: "app_owned",
          subagentId: id,
          childThreadId: null,
          prompt: id,
        },
      } as never,
    });
    const delegation = (id: string, taskId: string, failed = false) => ({
      id,
      kind: "work" as const,
      createdAt: "2026-01-01T00:00:02Z",
      entry: {
        id,
        createdAt: "2026-01-01T00:00:02Z",
        label: "Delegated a child task",
        tone: failed ? ("error" as const) : ("tool" as const),
        itemType: "dynamic_tool" as const,
        toolLifecycleStatus: failed ? ("failed" as const) : ("completed" as const),
        projectedItem: {
          item: {
            id,
            runId,
            type: "dynamic_tool",
            status: failed ? "failed" : "completed",
            toolName: "t3-code.delegate_task",
            input: { task: taskId },
            output: { content: JSON.stringify({ taskId }), structuredContent: { taskId } },
          },
        } as never,
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        child("a"),
        delegation("delegate-a", "a"),
        delegation("unmatched", "other-child"),
        child("c"),
        delegation("failed", "c", true),
      ],
      latestRun: null,
      isWorking: false,
      alwaysExpandActivity: true,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    const visibleTools = rows.flatMap((row) =>
      row.kind === "work" ? row.groupedEntries.map((entry) => entry.id) : [],
    );
    expect(visibleTools).toContain("unmatched");
    expect(visibleTools).toContain("failed");
    expect(visibleTools).not.toContain("delegate-a");
  });

  it("leaves a lone subagent card as its own event row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "subagent-1",
          kind: "event",
          createdAt: "2026-01-01T00:00:01Z",
          projectedItem: {
            position: 0,
            visibility: "local" as const,
            sourceThreadId: "thread-1" as never,
            sourceItemId: "item-subagent-1" as never,
            item: {
              id: "item-subagent-1",
              threadId: "thread-1",
              runId: "turn-1" as never,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "running",
              title: "Subagent 1",
              startedAt: null,
              completedAt: null,
              updatedAt: {},
              type: "subagent",
              subagentId: "subagent-1",
              childThreadId: null,
              prompt: "Map the surface",
            },
          } as never,
        },
      ],
      latestRun: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["event"]);
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestRun still points at the
    // previous, settled turn — it must stay folded through that window.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
  });

  it("folds every assistant message before the terminal message", () => {
    // A short follow-up must not hide a substantive opening response: both ends
    // of a settled turn stay visible and only the middle folds.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-first-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: "assistant-first" as never,
            role: "assistant",
            text: "The main result is ready.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:02Z",
            streaming: false,
          },
        },
        {
          id: "assistant-middle-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:03Z",
          message: {
            id: "assistant-middle" as never,
            role: "assistant",
            text: "I am checking one more detail.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:03Z",
            updatedAt: "2026-01-01T00:00:04Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Verification finished.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:06Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
  });

  it("does not fold the active in-progress turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:08Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual([
      "assistant-thought-entry",
      "work-entry-1",
      "working-indicator-row",
    ]);
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
  });

  it("groups contiguous work log entries into one timeline row", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "read",
          detail: "Reading package.json",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "edit",
          detail: "Editing MessagesTimeline.tsx",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "work-3",
          createdAt: "2026-01-01T00:00:03Z",
          label: "test",
          detail: "Running tests",
          tone: "tool" as const,
        },
      },
    ];

    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const rows = deriveMessagesTimelineRows(baseInput);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work",
      id: "work-entry-1",
      groupedEntries: [
        expect.objectContaining({ id: "work-1" }),
        expect.objectContaining({ id: "work-2" }),
        expect.objectContaining({ id: "work-3" }),
      ],
    });
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      runId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      runId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});

describe("turn folding with a live background command", () => {
  const userEntry = {
    id: "user-entry",
    kind: "message" as const,
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: "user-1" as never,
      role: "user" as const,
      text: "Run the tests in the background.",
      runId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
  };
  const assistantFinalEntry = {
    id: "assistant-final-entry",
    kind: "message" as const,
    createdAt: "2026-01-01T00:00:20Z",
    message: {
      id: "assistant-final" as never,
      role: "assistant" as const,
      text: "Started them; I will report back.",
      runId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:20Z",
      updatedAt: "2026-01-01T00:00:22Z",
      streaming: false,
    },
  };
  const backgroundWorkEntry = (status: string) => ({
    id: "background-entry",
    kind: "work" as const,
    createdAt: "2026-01-01T00:00:08Z",
    entry: {
      id: "work-background",
      createdAt: "2026-01-01T00:00:08Z",
      runId: "turn-1" as never,
      label: "Ran command",
      tone: "tool" as const,
      projectedItem: {
        item: { type: "command_execution", status, background: true },
      } as never,
    },
  });

  const otherWorkEntry = {
    id: "other-work-entry",
    kind: "work" as const,
    createdAt: "2026-01-01T00:00:05Z",
    entry: {
      id: "work-other",
      createdAt: "2026-01-01T00:00:05Z",
      runId: "turn-1" as never,
      label: "Read a file",
      tone: "tool" as const,
    },
  };

  // The settled turn collapses to "Worked for 22s" plus its final message. A
  // command still running has to survive that, or the row disappears exactly
  // when it becomes the only thing still saying anything.
  it("keeps a running background command outside the collapsed turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry,
        otherWorkEntry,
        backgroundWorkEntry("waiting"),
        assistantFinalEntry,
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(rows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "background-entry",
      "assistant-final-entry",
    ]);
  });

  it("folds the command away once it settles", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry,
        otherWorkEntry,
        backgroundWorkEntry("completed"),
        assistantFinalEntry,
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(rows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);
  });
});

describe("collapseWorkEntriesKeepingLiveBackground", () => {
  function entry(id: string, item?: Record<string, unknown>) {
    return {
      id,
      ...(item === undefined ? {} : { projectedItem: { item } as never }),
    };
  }

  it("keeps the last entries when nothing is running in the background", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    expect(collapseWorkEntriesKeepingLiveBackground(entries, 1).map((e) => e.id)).toEqual(["c"]);
  });

  it("pins a running background command that the tail rule would have hidden", () => {
    const entries = [
      entry("bg", { type: "command_execution", status: "waiting", background: true }),
      entry("b"),
      entry("c"),
    ];
    expect(collapseWorkEntriesKeepingLiveBackground(entries, 1).map((e) => e.id)).toEqual([
      "bg",
      "c",
    ]);
  });

  it("leaves nothing hidden when the pinned command is the only extra row", () => {
    // One early background command plus exactly MAX_VISIBLE_WORK_LOG_ENTRIES later
    // entries: everything stays visible, so no "+0 previous tool calls" control
    // should be offered.
    const entries = [
      entry("bg", { type: "command_execution", status: "waiting", background: true }),
      entry("last"),
    ];
    const visible = collapseWorkEntriesKeepingLiveBackground(entries, 1);
    expect(visible.map((e) => e.id)).toEqual(["bg", "last"]);
    expect(entries.length - visible.length).toBe(0);
  });

  it("stops pinning once the command settles", () => {
    const entries = [
      entry("bg", { type: "command_execution", status: "completed", background: true }),
      entry("b"),
      entry("c"),
    ];
    expect(collapseWorkEntriesKeepingLiveBackground(entries, 1).map((e) => e.id)).toEqual(["c"]);
  });
});

describe("day dividers", () => {
  const messageEntry = (id: string, createdAt: string) => ({
    id,
    kind: "message" as const,
    createdAt,
    message: {
      id: id as never,
      role: "user" as const,
      text: id,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  });
  const derive = (entries: ReadonlyArray<ReturnType<typeof messageEntry>>) =>
    deriveMessagesTimelineRows({
      timelineEntries: entries as never,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

  // Local-anchored, then zone-qualified: day keys are calendar-local, so bare
  // timestamps would land on different days depending on where this runs.
  const localIso = (year: number, monthIndex: number, day: number, hour: number) =>
    new Date(year, monthIndex, day, hour, 0, 0).toISOString();

  it("separates calendar days and leaves the first day unmarked", () => {
    const rows = derive([
      messageEntry("a", localIso(2026, 2, 17, 9)),
      messageEntry("b", localIso(2026, 2, 17, 18)),
      messageEntry("c", localIso(2026, 2, 19, 8)),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "day-divider", "message"]);
    expect(rows[2]).toMatchObject({ id: "day-divider:2026-03-19" });
  });

  it("adds nothing when every row falls on one day", () => {
    const rows = derive([
      messageEntry("a", localIso(2026, 2, 17, 1)),
      messageEntry("b", localIso(2026, 2, 17, 23)),
    ]);

    expect(rows.some((row) => row.kind === "day-divider")).toBe(false);
  });
});

describe("V2 live work focus", () => {
  const runId = RunId.make("live-run");
  const at = "2026-09-10T00:00:00Z";
  function entry(
    id: string,
    status: WorkLogEntry["toolLifecycleStatus"] = "completed",
    extra: Partial<WorkLogEntry> = {},
  ): WorkLogEntry {
    return {
      id,
      createdAt: at,
      runId,
      label: id,
      tone: "tool",
      toolLifecycleStatus: status,
      projectedItem: {
        item: {
          type: "command_execution",
          status: status === "inProgress" ? "running" : "completed",
        },
      } as never,
      ...extra,
    };
  }
  function rows(entries: TimelineEntry[], isWorking = true) {
    return deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId,
        status: isWorking ? "running" : "completed",
        startedAt: at,
        completedAt: isWorking ? null : at,
      },
      isWorking,
      activeTurnStartedAt: at,
      alwaysExpandActivity: true,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
  }
  function work(item: WorkLogEntry): TimelineEntry {
    return { kind: "work", id: item.id, createdAt: at, entry: item };
  }
  it("keeps imported V1 turns folded once the thread's first V2 run starts", () => {
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const message = (
      id: string,
      role: "user" | "assistant",
      second: number,
      runId: string | null = null,
    ) => ({
      id,
      kind: "message" as const,
      createdAt: at(second),
      message: {
        id: id as never,
        role,
        text: id,
        runId: runId as never,
        createdAt: at(second),
        updatedAt: at(second),
        streaming: false,
      },
    });
    const rows = (tail: ReadonlyArray<ReturnType<typeof message>>) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          message("imported-prompt", "user", 0),
          message("imported-update", "assistant", 4),
          {
            id: "imported-command",
            kind: "work",
            createdAt: at(5),
            entry: {
              id: "imported-command",
              createdAt: at(5),
              runId: null,
              label: "Ran git",
              command: "git status",
              tone: "tool" as const,
              toolLifecycleStatus: "completed" as const,
            },
          },
          message("imported-answer", "assistant", 8),
          ...tail,
        ],
        latestRun: {
          runId: "run-1" as never,
          status: "running",
          startedAt: at(20),
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: at(20),
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      }).map((row) =>
        row.kind === "message" ? `${row.message.role}:${row.message.id}` : row.kind,
      );

    // V2 work starts from a sent prompt, or with no new prompt (a wake or a resume).
    expect(rows([message("new-prompt", "user", 20, "run-1")]).slice(0, 4)).toEqual([
      "user:imported-prompt",
      "turn-fold",
      "assistant:imported-answer",
      "user:new-prompt",
    ]);
    const withoutPrompt = rows([]);
    expect(withoutPrompt).toContain("turn-fold");
    expect(withoutPrompt).not.toContain("assistant:imported-update");
  });

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    // A Claude subagent's child thread, as projected: no runs, one runless
    // root turn, and a user prompt for the launch and for a SendMessage resume.
    const threadId = ThreadId.make("subagent-child");
    const rootNodeId = NodeId.make("task-root");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 8, 25, 22, 51, second)).toISOString());
    const base = (id: string, ordinal: number, second: number, endSecond = second) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(endSecond),
      updatedAt: at(endSecond),
    });
    const prompt = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "user_message" as const,
      messageId: MessageId.make(id),
      text: `Prompt ${id}`,
      attachments: [],
      inputIntent: "turn_start" as const,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
    });
    const answer = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "assistant_message" as const,
      messageId: MessageId.make(id),
      text: `Answer ${id}`,
      streaming: false,
    });
    type ResumeState = "running" | "completed" | "failed";
    const items = (resume: ResumeState) =>
      [
        prompt("launch", 1, 0),
        { ...base("launch-ls", 2, 4), type: "command_execution" as const, input: "ls src" },
        {
          ...base("launch-thinking", 3, 8),
          type: "reasoning" as const,
          title: "Thinking",
          text: "Not there.",
          streaming: false,
        },
        answer("launch-answer", 4, 8),
        prompt("resume", 5, 72),
        {
          ...base("resume-ls", 6, 77),
          type: "command_execution" as const,
          input: "ls src",
          status: resume === "running" ? ("running" as const) : ("completed" as const),
          completedAt: resume === "running" ? null : at(77),
        },
        ...(resume === "failed"
          ? [
              {
                ...base("resume-error", 7, 80),
                type: "error" as const,
                status: "failed" as const,
                failure: {
                  class: "provider_error" as const,
                  message: "Subagent failed",
                  code: null,
                  retryable: null,
                },
              },
            ]
          : []),
        ...(resume === "running" ? [] : [answer("resume-answer", 8, 80)]),
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (input: {
      resume: ResumeState;
      working: boolean;
      expandedRunIds?: ReadonlySet<RunId>;
    }) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(input.resume),
          optimisticMessages: [],
        }),
        latestRun: null,
        isWorking: input.working,
        runlessWorkActive: input.working,
        ...(input.expandedRunIds === undefined ? {} : { expandedRunIds: input.expandedRunIds }),
        activeTurnStartedAt: input.working ? DateTime.formatIso(at(72)) : null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });
    const shape = (timeline: ReturnType<typeof deriveMessagesTimelineRows>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? `fold:${row.label}`
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind,
      );

    // Settled: each run folds its work, keeping its prompt and final answer.
    const settled = rows({ resume: "completed", working: false });
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8.0s",
      "assistant:resume-answer",
    ]);

    // Each fold opens on its own.
    const launchFold = settled.find((row) => row.kind === "turn-fold");
    if (launchFold?.kind !== "turn-fold") throw new Error("Expected the launch fold");
    const expanded = rows({
      resume: "completed",
      working: false,
      expandedRunIds: new Set([launchFold.runId]),
    });
    expect(shape(expanded)).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "work",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8.0s",
      "assistant:resume-answer",
    ]);

    // While the resume runs, only the settled launch folds; the resume's tool
    // reads as live work.
    const running = rows({ resume: "running", working: true });
    expect(shape(running)).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "work",
    ]);
    expect(running.find((row) => row.kind === "work")?.liveEntry).toBeDefined();

    // A failed run stays open, as on a normal thread.
    expect(shape(rows({ resume: "failed", working: false }))).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "work",
      "work",
      "assistant:resume-answer",
    ]);
  });

  it("shows a provider-native subagent's runless tool as live work while it works", () => {
    const runless = (working: boolean, status: WorkLogEntry["toolLifecycleStatus"]) =>
      deriveMessagesTimelineRows({
        timelineEntries: [work(entry("command", status, { runId: null }))],
        latestRun: null,
        isWorking: working,
        runlessWorkActive: working,
        activeTurnStartedAt: working ? at : null,
        alwaysExpandActivity: true,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });
    const running = runless(true, "inProgress");
    expect(running.find((row) => row.kind === "work")?.liveEntry?.id).toBe("command");
    expect(running.some((row) => row.kind === "working")).toBe(false);
    // Once the subagent settles, the same entry reads as finished history.
    const settled = runless(false, "completed");
    expect(settled.find((row) => row.kind === "work")?.liveEntry).toBeUndefined();
    expect(settled.some((row) => row.kind === "working")).toBe(false);
  });
  it("does not treat runless entries as live work on a thread with runs", () => {
    const result = rows([work(entry("runless", "inProgress", { runId: null }))]);
    expect(result.find((row) => row.kind === "work")?.liveEntry).toBeUndefined();
    expect(result.some((row) => row.kind === "working")).toBe(true);
  });
  it("keeps a running tool focused when a later concurrent call completes", () => {
    const running = entry("running", "inProgress");
    expect(resolveLiveWorkEntry([running, entry("done")], runId)).toBe(running);
  });
  it("carries the latest thought on the live row while a later tool runs", () => {
    const thought = (id: string, detail: string) =>
      entry(id, "completed", {
        itemType: "reasoning",
        tone: "thinking",
        detail,
        projectedItem: { item: { type: "reasoning", status: "completed" } } as never,
      });
    const result = rows([
      work(thought("old-thought", "First idea.")),
      work(thought("new-thought", "Found the cause.")),
      work(thought("empty-thought", "  ")),
      work(entry("running-command", "inProgress")),
    ]);
    expect(result.find((row) => row.kind === "work")).toMatchObject({
      liveEntry: { id: "running-command" },
      liveThought: { id: "new-thought" },
    });
  });
  it("carries no thought once the turn settles", () => {
    const result = rows(
      [
        work(
          entry("thought", "completed", {
            itemType: "reasoning",
            tone: "thinking",
            detail: "Found the cause.",
          }),
        ),
        work(entry("done")),
      ],
      false,
    );
    expect(result.find((row) => row.kind === "work")?.liveThought).toBeUndefined();
  });
  it("holds the last successful operation between messages and replaces the extra working row", () => {
    const result = rows([work(entry("done"))]);
    expect(result.find((row) => row.kind === "work")?.liveEntry?.id).toBe("done");
    expect(result.some((row) => row.kind === "working")).toBe(false);
  });
  it("returns to working after a failure and keeps the failure visible", () => {
    const result = rows([work(entry("failed", "failed"))]);
    expect(result.find((row) => row.kind === "work")?.liveEntry).toBeUndefined();
    expect(result.some((row) => row.kind === "working")).toBe(true);
    expect(result.find((row) => row.kind === "work")?.groupedEntries[0]?.id).toBe("failed");
  });
  it("does not make background activity the foreground focus", () => {
    const background = entry("background", "inProgress", {
      projectedItem: {
        item: { type: "command_execution", status: "waiting", background: true },
      } as never,
    });
    expect(resolveLiveWorkEntry([background], runId)).toBeNull();
    const foreground = entry("foreground");
    expect(resolveLiveWorkEntry([foreground, background], runId)).toBe(foreground);
  });
  it("does not revive another run or settled activity", () => {
    expect(
      resolveLiveWorkEntry([entry("old", "completed", { runId: RunId.make("other") })], runId),
    ).toBeNull();
    expect(
      rows([work(entry("done"))], false).find((row) => row.kind === "work")?.liveEntry,
    ).toBeUndefined();
  });
  it("keeps an ordinary failed tool outside a later successful or live group", () => {
    const result = rows([
      work(entry("failed", "failed")),
      work(entry("done")),
      work(entry("running", "inProgress")),
    ]);
    const groups = result.filter((row) => row.kind === "work");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.groupedEntries.map((entry) => entry.id)).toEqual(["failed"]);
    expect(groups[0]?.liveEntry).toBeUndefined();
    expect(groups[1]?.liveEntry?.id).toBe("running");
  });
  it("separates errors and compaction from a later live operation", () => {
    const result = rows([
      work(entry("error", "failed", { tone: "error" })),
      work(entry("compact", "completed", { sourceItemType: "compaction" })),
      work(entry("next", "inProgress")),
    ]);
    expect(result.filter((row) => row.kind === "work")).toHaveLength(3);
    expect(
      result.filter((row) => row.kind === "work").find((row) => row.liveEntry)?.liveEntry?.id,
    ).toBe("next");
  });
});

describe("V2 historical tool summaries", () => {
  const entry = (extra: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
    id: "tool",
    createdAt: "2026-09-10T00:00:00Z",
    label: "Tool",
    tone: "tool",
    toolLifecycleStatus: "completed",
    ...extra,
  });
  it("summarizes commands and unique changed files in encounter order", () => {
    expect(
      resolveHistoricalWorkSummary([
        entry({ itemType: "command_execution" }),
        entry({ itemType: "file_change", changedFiles: ["a.ts", "b.ts"] }),
        entry({ itemType: "file_change", changedFiles: ["a.ts"] }),
      ]),
    ).toBe("Ran 1 command and changed 2 files");
  });
  it("preserves pull-request and browser intent in grouped history", () => {
    expect(
      resolveHistoricalWorkSummary([
        entry({ toolTitle: "t3-code.link_pull_request" }),
        entry({ toolTitle: "t3-code.link_pull_request" }),
        entry({ toolTitle: "t3-code.preview_click" }),
      ]),
    ).toBe("Linked 2 pull requests and used browser 1 time");
    expect(
      resolveHistoricalWorkSummary([
        entry({ toolTitle: "unlink_pull_request" }),
        entry({ toolTitle: "list_thread_pull_requests" }),
      ]),
    ).toBe("Unlinked 1 pull request and checked linked pull requests");
  });
  it("deduplicates integration sources without swallowing PR intent", () => {
    const source = { key: "browser-use:chrome", name: "Chrome", kind: "integration" } as const;
    expect(
      resolveHistoricalWorkSummary([
        entry({ toolSource: source }),
        entry({ toolSource: source }),
        entry({ toolSource: source, toolTitle: "link_pull_request" }),
      ]),
    ).toBe("Used Chrome integration and linked 1 pull request");
  });
  it("counts code and web searches separately", () => {
    expect(
      resolveHistoricalWorkSummary([
        entry({ itemType: "file_search" }),
        entry({ itemType: "web_search" }),
        entry(),
      ]),
    ).toBe("Searched code 1 time, searched the web 1 time, and used 1 tool");
  });
  it("keeps individual calls and failed, declined or active tools visible", () => {
    expect(resolveHistoricalWorkSummary([entry()])).toBeNull();
    for (const status of ["failed", "declined", "inProgress"] as const) {
      expect(
        resolveHistoricalWorkSummary([entry(), entry({ toolLifecycleStatus: status })]),
      ).toBeNull();
    }
  });
  it("never folds compaction or background work into a completed summary", () => {
    expect(
      resolveHistoricalWorkSummary([entry(), entry({ sourceItemType: "compaction" })]),
    ).toBeNull();
    const background = {
      item: { type: "command_execution", status: "waiting", background: true },
    } as never;
    expect(
      resolveHistoricalWorkSummary([entry(), entry({ projectedItem: background })]),
    ).toBeNull();
  });
  it("leaves non-tool bookkeeping visible", () => {
    expect(resolveHistoricalWorkSummary([entry(), entry({ tone: "info" })])).toBeNull();
  });
});

describe("plainThoughtPreviewText", () => {
  it("reads markdown thoughts as one line of prose", () => {
    expect(
      plainThoughtPreviewText(
        "**Planning the fix**\n\n- Check `session-logic.ts`\n- See [the docs](https://example.com) and *retry*",
      ),
    ).toBe("Planning the fix Check session-logic.ts See the docs and retry");
  });
  it("keeps identifiers and arithmetic untouched", () => {
    expect(plainThoughtPreviewText("snake_case_name is 2 * 3 * 4")).toBe(
      "snake_case_name is 2 * 3 * 4",
    );
  });
});

describe("failed turn transcript", () => {
  it.each(["provider_error", "usage_limit"] as const)(
    "keeps historical %s failures and preceding work visible without folds",
    (failureClass) => {
      const runId = RunId.make("failed-run");
      const threadId = ThreadId.make("failed-thread");
      const at = DateTime.makeUnsafe("2026-09-20T12:00:00Z");
      const base = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      };
      const items: OrchestrationV2ProjectedTurnItem[] = [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("user"),
          item: {
            ...base,
            id: TurnItemId.make("user"),
            type: "user_message",
            status: "completed",
            messageId: MessageId.make("user"),
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            text: "Build it",
            attachments: [],
          },
        },
        {
          position: 1,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("command"),
          item: {
            ...base,
            id: TurnItemId.make("command"),
            type: "command_execution",
            status: "completed",
            input: "pwd",
            output: "",
            exitCode: 0,
          },
        },
        {
          position: 2,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("failure"),
          item: {
            ...base,
            id: TurnItemId.make("failure"),
            type: "error",
            status: "failed",
            failure: {
              class: failureClass,
              message: "The provider stopped this turn.\nRetry later.",
              code: null,
              retryable: true,
            },
          },
        },
      ];
      const rows = deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items,
          optimisticMessages: [],
        }).map((entry) => ({
          ...entry,
          attempt: {
            id: RunAttemptId.make("superseded-attempt"),
            runId,
            attemptOrdinal: 1,
            rootNodeId: NodeId.make("superseded-root"),
            status: "superseded" as const,
          },
        })),
        latestRun: {
          runId: RunId.make("newer-run"),
          status: "completed",
          startedAt: DateTime.formatIso(at),
          completedAt: DateTime.formatIso(at),
        },
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });
      expect(rows.some((row) => row.kind === "turn-fold" || row.kind === "attempt-fold")).toBe(
        false,
      );
      const work = rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));
      expect(work.map((entry) => entry.id)).toEqual(["command", "failure"]);
    },
  );
});

describe("MCP apps in the timeline", () => {
  const now = DateTime.makeUnsafe("2026-10-07T00:00:00.000Z");
  const sourceThreadId = ThreadId.make("thread-app-source");
  const forkThreadId = ThreadId.make("thread-app-fork");
  const runId = RunId.make("run-app");
  const app = {
    attachmentId: "thread-app-source-00000000-0000-0000-0000-000000000000-html",
    server: "weather",
    tool: "get_weather",
    resourceUri: "ui://weather/dashboard",
  };
  const itemBase = {
    threadId: sourceThreadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const row = (
    item: OrchestrationV2ProjectedTurnItem["item"],
    position: number,
  ): OrchestrationV2ProjectedTurnItem => ({
    position,
    // Shown in a fork: the app still belongs to its source thread and item.
    visibility: "inherited",
    sourceThreadId,
    sourceItemId: item.id,
    item: { ...item, threadId: forkThreadId },
  });
  const appCall = (
    toolName: string,
    status: "completed" | "running" = "completed",
  ): OrchestrationV2ProjectedTurnItem["item"] => ({
    ...itemBase,
    id: TurnItemId.make("item-app"),
    ordinal: 2,
    status,
    type: "dynamic_tool",
    toolName,
    input: { city: "Oslo" },
    output: { t3McpApp: app },
  });
  const entriesFor = (item: OrchestrationV2ProjectedTurnItem["item"]) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        row(
          {
            ...itemBase,
            id: TurnItemId.make("item-user"),
            ordinal: 0,
            status: "completed",
            type: "user_message",
            messageId: MessageId.make("message-user"),
            text: "Weather?",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
          } as OrchestrationV2ProjectedTurnItem["item"],
          0,
        ),
        row(
          {
            ...itemBase,
            id: TurnItemId.make("item-read"),
            ordinal: 1,
            status: "completed",
            type: "dynamic_tool",
            toolName: "Read",
            input: { file_path: "README.md" },
            output: "notes",
          },
          1,
        ),
        row(item, 2),
        row(
          {
            ...itemBase,
            id: TurnItemId.make("item-answer"),
            ordinal: 3,
            status: "completed",
            type: "assistant_message",
            messageId: MessageId.make("message-answer"),
            text: "Here it is.",
            streaming: false,
          } as OrchestrationV2ProjectedTurnItem["item"],
          3,
        ),
      ],
      optimisticMessages: [],
    });

  it("hosts a captured app in place, owned by its source thread and item", () => {
    const entry = entriesFor(appCall("weather.get_weather")).find(
      (candidate) => candidate.kind === "mcp-app",
    );
    expect(entry).toMatchObject({
      kind: "mcp-app",
      runId,
      sourceThreadId,
      itemId: "item-app",
      mcpApp: app,
    });
  });

  it("ignores an app reference naming another server, and a call still running", () => {
    for (const item of [appCall("evil.lookup"), appCall("weather.get_weather", "running")]) {
      expect(entriesFor(item).some((entry) => entry.kind === "mcp-app")).toBe(false);
    }
  });

  it("keeps the app visible when its settled turn folds", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entriesFor(appCall("weather.get_weather")),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(rows.map((candidate) => candidate.kind)).toEqual([
      "message",
      "turn-fold",
      "mcp-app",
      "message",
    ]);
  });
});

describe("shouldCollapseUserMessage", () => {
  it("measures a quote chip by its label, not its encoded link", () => {
    const quote = "A long assistant paragraph that the user quoted. ".repeat(40);
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: quote,
      comment: "Why does this matter?",
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    });

    expect(shouldCollapseUserMessage(`${citation} Can you expand on this?`)).toBe(false);
    expect(shouldCollapseUserMessage(`${citation} ${"More text. ".repeat(60)}`)).toBe(true);
  });

  it("measures file links and context chips by their label", () => {
    const links = Array.from(
      { length: 8 },
      (_, index) =>
        `[file${index}.ts](/workspace/projects/example/packages/some/deeply/nested/directory/file${index}.ts)`,
    );
    const text = `Compare ${links.join(", ")} with [terminal 1](t3-context://v1/terminal/${"a".repeat(36)}).`;

    expect(text.length).toBeGreaterThan(600);
    expect(shouldCollapseUserMessage(text)).toBe(false);
  });
});
