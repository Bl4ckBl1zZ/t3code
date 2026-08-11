import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  deriveThreadFeedPresentation,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  threadFeedRunIsUnsettled,
  togglePendingUserInputOptionSelection,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "./threadActivity";

const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which data should be collected?",
  options: [
    { label: "Orders", description: "Receipts" },
    { label: "Listings", description: "Inventory" },
  ],
  multiSelect: true,
} as const;

describe("pending user input answers", () => {
  it("replaces single-select options and toggles multi-select options", () => {
    expect(
      togglePendingUserInputOptionSelection(
        singleSelectQuestion,
        { selectedOptionLabels: ["Go"] },
        "Node.js",
      ),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Node.js"] });

    const orders = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Orders");
    const ordersAndListings = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      orders,
      "Listings",
    );
    expect(ordersAndListings).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Orders", "Listings"],
    });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, ordersAndListings, "Orders"),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Listings"] });

    const paddedOrders = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      undefined,
      "  Orders  ",
    );
    expect(paddedOrders).toEqual({ customAnswer: "", selectedOptionLabels: ["Orders"] });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, paddedOrders, "  Orders  "),
    ).toEqual({ customAnswer: "" });
  });

  it("builds array answers for multi-select questions", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, multiSelectQuestion], {
        runtime: { selectedOptionLabels: ["Go"] },
        scope: { selectedOptionLabels: ["Orders", "Listings"] },
      }),
    ).toEqual({
      runtime: "Go",
      scope: ["Orders", "Listings"],
    });
  });

  it("clears selected options while a custom answer is active", () => {
    expect(
      setPendingUserInputCustomAnswer(
        { selectedOptionLabels: ["Orders", "Listings"] },
        "Orders first",
      ),
    ).toEqual({ customAnswer: "Orders first" });
  });

  it("matches selected chips against normalized option labels", () => {
    expect(
      isPendingUserInputOptionSelected({ selectedOptionLabels: ["Orders"] }, "  Orders  "),
    ).toBe(true);
    expect(
      isPendingUserInputOptionSelected(
        { selectedOptionLabels: ["Orders"], customAnswer: "Orders first" },
        "  Orders  ",
      ),
    ).toBe(false);
  });
});

const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");

function base(id: string, updatedAt: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(updatedAt);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  position: number,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility,
    sourceThreadId: visibility === "local" ? threadId : sourceThreadId,
    sourceItemId: item.id,
    item,
  };
}

function userMessage(updatedAt = "2026-06-20T00:00:01.000Z") {
  return {
    ...base("item-user", updatedAt, 0),
    type: "user_message" as const,
    messageId: MessageId.make("message-user"),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: "Run checks",
    attachments: [],
  };
}

function agentUserMessage(
  id: string,
  ordinal: number,
  updatedAt = "2026-06-20T00:00:01.000Z",
  text = `Delegated task "Task ${id}" completed. Use task_status with taskId ${id} to read the result.`,
) {
  return {
    ...base(`item-${id}`, updatedAt, ordinal),
    type: "user_message" as const,
    messageId: MessageId.make(id),
    createdBy: "agent" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text,
    attachments: [],
  };
}

function subagent(
  id: string,
  ordinal: number,
  updatedAt = "2026-06-20T00:00:02.000Z",
  status: "running" | "completed" = "running",
) {
  return {
    ...base(`item-${id}`, updatedAt, ordinal),
    status,
    title: `Subagent ${id}`,
    type: "subagent" as const,
    subagentId: NodeId.make(`node-${id}`),
    origin: "app_owned" as const,
    driver: ProviderDriverKind.make("claude"),
    providerInstanceId: ProviderInstanceId.make("instance-1"),
    childThreadId: ThreadId.make(`child-${id}`),
    prompt: `Do ${id}`,
    progress: `Running ${id}`,
    result: null,
  };
}

function command(updatedAt = "2026-06-20T00:00:02.000Z") {
  return {
    ...base("item-command", updatedAt, 1),
    type: "command_execution" as const,
    input: "vp check",
    output: "ok",
    exitCode: 0,
  };
}

function assistantMessage(updatedAt = "2026-06-20T00:00:03.000Z") {
  return {
    ...base("item-assistant", updatedAt, 2),
    type: "assistant_message" as const,
    messageId: MessageId.make("message-assistant"),
    text: "Done",
    streaming: false,
  };
}

describe("buildThreadFeed", () => {
  it("does not treat a queued-only run as live feed activity", () => {
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "queued",
        startedAt: null,
        completedAt: null,
      }),
    ).toBe(false);
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "running",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      }),
    ).toBe(true);
  });

  it("adds queued input only after dispatch creates its turn item", () => {
    const dispatchedRunId = RunId.make("run-dispatched-queued");
    const dispatchedMessageId = MessageId.make("message-dispatched-queued");
    expect(buildThreadFeed([])).toEqual([]);

    const promotedEntries = buildThreadFeed([
      projected(
        {
          ...userMessage(),
          id: TurnItemId.make("item-dispatched-queued"),
          runId: dispatchedRunId,
          messageId: dispatchedMessageId,
          inputIntent: "turn_start",
        },
        0,
      ),
    ]);
    expect(promotedEntries.map((entry) => entry.id)).toEqual([dispatchedMessageId]);
    expect(
      promotedEntries[0]?.type === "message" ? promotedEntries[0].message.inputIntent : undefined,
    ).toBe("turn_start");
  });

  it("preserves authoritative V2 order instead of sorting reconstructed collections", () => {
    const rows = [
      projected(userMessage("2026-06-20T00:00:03.000Z"), 0),
      projected(command("2026-06-20T00:00:01.000Z"), 1),
      projected(assistantMessage("2026-06-20T00:00:02.000Z"), 2),
    ];

    const feed = buildThreadFeed(rows);
    expect(feed.map((entry) => entry.type)).toEqual(["message", "activity-group", "message"]);
    expect(feed.map((entry) => entry.id)).toEqual([
      "message-user",
      "local:thread-1:item-command",
      "message-assistant",
    ]);
    const activity = feed.find((entry) => entry.type === "activity-group")?.activities[0];
    expect(activity?.projectedItem).toBe(rows[1]);
    expect(activity?.getFullDetail()).toContain('"input": "vp check"');
  });

  it("collapses runs of consecutive agent-sent user messages into one agent-updates group", () => {
    const feed = buildThreadFeed([
      projected(agentUserMessage("wake-1", 0), 0),
      projected(agentUserMessage("wake-2", 1, "2026-06-20T00:00:02.000Z"), 1),
      projected(agentUserMessage("wake-3", 2, "2026-06-20T00:00:03.000Z"), 2),
      projected(assistantMessage("2026-06-20T00:00:04.000Z"), 3),
    ]);

    expect(feed.map((entry) => entry.type)).toEqual(["agent-updates", "message"]);
    const group = feed[0];
    if (group?.type !== "agent-updates") throw new Error("expected agent-updates entry");
    // Anchored to the first message id so the group stays stable as updates append.
    expect(group.id).toBe("agent-updates:wake-1");
    expect(group.messages.map((message) => message.id)).toEqual(["wake-1", "wake-2", "wake-3"]);
  });

  it("keeps a single agent-sent message as an ordinary message entry", () => {
    const feed = buildThreadFeed([
      projected(agentUserMessage("wake-1", 0), 0),
      projected(assistantMessage("2026-06-20T00:00:02.000Z"), 1),
    ]);

    expect(feed.map((entry) => entry.type)).toEqual(["message", "message"]);
    expect(feed[0]?.type === "message" ? feed[0].message.createdBy : undefined).toBe("agent");
  });

  it("breaks an agent-update run on an interleaved user-sent message", () => {
    const feed = buildThreadFeed([
      projected(agentUserMessage("wake-1", 0), 0),
      projected(
        {
          ...userMessage("2026-06-20T00:00:02.000Z"),
          id: TurnItemId.make("item-user-mid"),
          messageId: MessageId.make("message-user-mid"),
        },
        1,
      ),
      projected(agentUserMessage("wake-2", 2, "2026-06-20T00:00:03.000Z"), 2),
    ]);

    expect(feed.map((entry) => entry.type)).toEqual(["message", "message", "message"]);
    expect(feed.map((entry) => entry.id)).toEqual(["wake-1", "message-user-mid", "wake-2"]);
  });

  it("collapses adjacent subagent cards into one lifecycle group", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(subagent("a", 1), 1),
      projected(subagent("b", 2, "2026-06-20T00:00:03.000Z"), 2),
      projected(subagent("c", 3, "2026-06-20T00:00:04.000Z"), 3),
      projected(assistantMessage("2026-06-20T00:00:05.000Z"), 4),
    ]);

    expect(feed.map((entry) => entry.type)).toEqual(["message", "lifecycle-group", "message"]);
    const group = feed[1];
    if (group?.type !== "lifecycle-group") throw new Error("expected lifecycle-group entry");
    // Anchored to the first card so the group stays stable as agents join it.
    expect(group.id).toBe("lifecycle-group:lifecycle:thread-1:item-a");
    expect(group.entries.map((entry) => entry.row.sourceItemId)).toEqual([
      "item-a",
      "item-b",
      "item-c",
    ]);
  });

  it("keeps a lone subagent card as an ordinary lifecycle entry", () => {
    const feed = buildThreadFeed([
      projected(subagent("solo", 0), 0),
      projected(assistantMessage("2026-06-20T00:00:03.000Z"), 1),
    ]);

    expect(feed.map((entry) => entry.type)).toEqual(["lifecycle", "message"]);
  });

  it("breaks a subagent run on an interleaved non-card entry", () => {
    const feed = buildThreadFeed([
      projected(subagent("a", 0), 0),
      projected(assistantMessage("2026-06-20T00:00:03.000Z"), 1),
      projected(subagent("b", 2, "2026-06-20T00:00:04.000Z"), 2),
    ]);

    expect(feed.map((entry) => entry.type)).toEqual(["lifecycle", "message", "lifecycle"]);
  });

  it("retains inherited and synthetic rows with their original projected identity", () => {
    const inherited = projected(command(), 0, "inherited");
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:03.000Z",
      2,
    );
    const synthetic = projected(
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId: sourceThreadId, runId },
        targetThreadId: threadId,
      },
      1,
      "synthetic",
    );

    const feed = buildThreadFeed([inherited, synthetic]);
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem)).toEqual([inherited]);
    expect(activities[0]?.projectedItem.visibility).toBe("inherited");
    // Forks are first-class lifecycle rows, keeping the projected row identity.
    const lifecycle = feed.find((entry) => entry.type === "lifecycle");
    expect(lifecycle?.type === "lifecycle" ? lifecycle.row : null).toBe(synthetic);
  });

  it("keeps orchestration relationship cards visible when a completed run is folded", () => {
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:02.500Z",
      2,
    );
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(
        {
          ...forkBase,
          type: "fork",
          source: { type: "run", threadId, runId },
          targetThreadId: sourceThreadId,
        },
        2,
      ),
      projected(assistantMessage(), 3),
    ]);

    const collapsed = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: "2026-06-20T00:00:03.000Z",
      },
      new Set(),
    );

    expect(
      collapsed.some((entry) => entry.type === "lifecycle" && entry.row.item.type === "fork"),
    ).toBe(true);
    expect(
      collapsed.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some(
            (activity) => activity.projectedItem.item.type === "command_execution",
          ),
      ),
    ).toBe(false);
  });

  it("folds settled V2 run work while keeping the terminal assistant message visible", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(assistantMessage(), 2),
    ]);
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    };

    const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual(["message", "run-fold", "message"]);

    const expanded = deriveThreadFeedPresentation(feed, latestRun, new Set([runId]));
    expect(expanded.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "message",
    ]);
  });

  it("drops the run fold entirely when activity is always expanded", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(assistantMessage(), 2),
    ]);
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    };

    const presented = deriveThreadFeedPresentation(feed, latestRun, new Set(), new Set(), null, {
      alwaysExpandActivity: true,
    });

    expect(presented.map((entry) => entry.type)).toEqual(["message", "activity-group", "message"]);
  });

  it("keeps an active run expanded and marks failed tools as failures", () => {
    const failedCommand: OrchestrationV2TurnItem = {
      ...command(),
      status: "failed",
      completedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
    };
    const feed = buildThreadFeed([projected(userMessage(), 0), projected(failedCommand, 1)]);
    const presented = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "running",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      },
      new Set(),
    );

    expect(presented.some((entry) => entry.type === "run-fold")).toBe(false);
    expect(presented.find((entry) => entry.type === "activity-group")?.activities[0]?.status).toBe(
      "failure",
    );
  });

  it("appends active work as a normal timeline row", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const presented = deriveThreadFeedPresentation([], null, new Set(), new Set(), startedAt);

    expect(presented).toEqual([
      {
        type: "working",
        id: "working-indicator-row",
        createdAt: startedAt,
      },
    ]);
    expect(deriveThreadFeedPresentation(presented, null, new Set())).toEqual([]);
  });

  it("models work-log overflow as list rows", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      runId: null,
      summary: `Tool ${id}`,
      detail: null,
      canExpand: false,
      getFullDetail: () => null,
      getCopyText: () => id,
      icon: "command",
      logo: null,
      toolLike: true,
      prominent: false,
      status,
      projectedItem: projected(command(createdAt), 0),
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        runId: null,
        activities: [
          activity("activity-1", "2026-04-01T00:00:01.000Z"),
          activity("activity-neutral", "2026-04-01T00:00:02.000Z", "neutral"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["activity-3", "work-toggle:work-group-1"]);
    expect(collapsed[1]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group-1",
      hiddenCount: 2,
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, null, new Set(), new Set(["work-group-1"]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "work-toggle:work-group-1",
    ]);
    expect(expanded.at(-1)).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
  });

  it("previews native Read tool calls with their file path and a read icon", () => {
    const toolItem: OrchestrationV2TurnItem = {
      ...base("item-read-tool", "2026-06-20T00:00:04.000Z", 3),
      type: "dynamic_tool",
      toolName: "Read",
      input: { file_path: "/repo/apps/web/src/App.tsx" },
    };

    const feed = buildThreadFeed([projected(toolItem, 0)]);
    const activity = feed[0]?.type === "activity-group" ? feed[0].activities[0] : null;

    expect(activity?.summary).toBe("Read");
    expect(activity?.detail).toBe("/repo/apps/web/src/App.tsx");
    expect(activity?.icon).toBe("eye");
  });

  it("pretty prints T3 MCP dynamic tool activities and attaches the product logo", () => {
    const toolItem: OrchestrationV2TurnItem = {
      ...base("item-t3-tool", "2026-06-20T00:00:04.000Z", 3),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_thread_read",
      input: { threadId: "thread-child" },
      output: { messages: [] },
    };

    const feed = buildThreadFeed([projected(toolItem, 0)]);
    const activity = feed[0]?.type === "activity-group" ? feed[0].activities[0] : null;

    expect(activity?.summary).toBe("Read a T3 thread");
    expect(activity?.logo).toBe("t3-code");
    expect(activity?.getCopyText().split("\n")[0]).toBe("Read a T3 thread");
  });
});

describe("thread feed system dividers", () => {
  it("hides entries at or before the clear marker and says so", () => {
    const feed = buildThreadFeed([
      projected(userMessage("2026-06-20T00:00:01.000Z"), 0),
      projected(
        { ...assistantMessage("2026-06-20T00:00:09.000Z"), id: TurnItemId.make("item-after") },
        1,
      ),
    ]);

    const presented = deriveThreadFeedPresentation(feed, null, new Set(), new Set(), null, {
      timelineClearedAt: "2026-06-20T00:00:05.000Z",
    });

    expect(presented.map((entry) => entry.type)).toEqual(["chat-cleared", "message"]);
    expect(presented[0]).toMatchObject({ id: "chat-cleared:2026-06-20T00:00:05.000Z" });
  });

  it("separates calendar days and leaves the first day unmarked", () => {
    // Local-anchored so the two entries land on different calendar days in any
    // timezone; day keys are local, not UTC.
    const localIso = (day: number) => new Date(2026, 5, day, 9, 0, 0).toISOString();
    const feed = buildThreadFeed([
      projected(userMessage(localIso(20)), 0),
      projected({ ...assistantMessage(localIso(22)), id: TurnItemId.make("item-later") }, 1),
    ]);

    const presented = deriveThreadFeedPresentation(feed, null, new Set());
    const dividers = presented.filter((entry) => entry.type === "day-divider");

    expect(dividers.length).toBe(1);
    expect(presented.indexOf(dividers[0]!)).toBe(1);
  });

  it("folds a superseded attempt behind one boundary row", () => {
    const rootNodeId = NodeId.make("node-root");
    const attempts = [
      {
        id: "attempt-1",
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        status: "superseded" as const,
      },
    ];
    const nodes = [{ id: rootNodeId, rootNodeId, parentNodeId: null }];
    const feed = buildThreadFeed(
      [
        projected(userMessage(), 0),
        projected({ ...command(), nodeId: rootNodeId }, 1),
        projected(assistantMessage(), 2),
      ],
      { attempts: attempts as never, nodes: nodes as never },
    );

    // Unsettled run: turn folding is off, so the attempt fold is what collapses
    // the abandoned work rather than being pre-empted by the run fold.
    const latestRun = {
      runId,
      status: "running" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: null,
    };

    const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual(["message", "attempt-fold", "message"]);

    const expanded = deriveThreadFeedPresentation(feed, latestRun, new Set(), new Set(), null, {
      expandedAttemptIds: new Set(["attempt-1" as never]),
    });
    expect(expanded.map((entry) => entry.type)).toEqual([
      "message",
      "attempt-fold",
      "activity-group",
      "message",
    ]);
  });
});
