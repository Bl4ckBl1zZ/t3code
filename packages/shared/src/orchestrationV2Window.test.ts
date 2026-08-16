import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  mergeOrchestrationV2FullHistory,
  windowOrchestrationV2ThreadProjection,
} from "./orchestrationV2Window.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-window");

function turnItem(id: string, runId: string, ordinal: number): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make(runId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "pwd",
    output: "done",
    exitCode: 0,
  };
}

function visibleRow(
  item: OrchestrationV2TurnItem,
  position: number,
): OrchestrationV2ProjectedTurnItem {
  return { position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item };
}

function message(id: string, runId: string | null): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId,
    runId: runId === null ? null : RunId.make(runId),
    nodeId: null,
    role: "user",
    text: `text-${id}`,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: "user",
    creationSource: "web",
  };
}

function projectionWith(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-window"),
      title: "Window",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages,
    plans: [],
    turnItems: items,
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: items.map((item, position) => visibleRow(item, position)),
    updatedAt: now,
  } as OrchestrationV2ThreadProjection;
}

describe("windowOrchestrationV2ThreadProjection", () => {
  const items = [
    turnItem("item-1", "run-1", 1),
    turnItem("item-2", "run-1", 2),
    turnItem("item-3", "run-2", 1),
    turnItem("item-4", "run-2", 2),
    turnItem("item-5", "run-3", 1),
  ];
  const messages = [message("m-1", "run-1"), message("m-2", "run-2"), message("m-3", null)];
  const projection = projectionWith(items, messages);

  it("returns the projection unchanged when within the window", () => {
    expect(windowOrchestrationV2ThreadProjection(projection, 5)).toBe(projection);
    expect(windowOrchestrationV2ThreadProjection(projection, 0)).toBe(projection);
  });

  it("normalizes fractional and non-finite windows instead of crashing", () => {
    expect(windowOrchestrationV2ThreadProjection(projection, Number.NaN)).toBe(projection);
    expect(windowOrchestrationV2ThreadProjection(projection, 0.5)).toBe(projection);
    const windowed = windowOrchestrationV2ThreadProjection(projection, 2.7);
    expect(windowed.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "item-3",
      "item-4",
      "item-5",
    ]);
  });

  it("trims to the window, extended back to a run boundary", () => {
    // Window of 2 lands mid run-2 → extends back to include all of run-2.
    const windowed = windowOrchestrationV2ThreadProjection(projection, 2);
    expect(windowed.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "item-3",
      "item-4",
      "item-5",
    ]);
    expect(windowed.visibleTurnItems.map((row) => row.position)).toEqual([0, 1, 2]);
    expect(windowed.turnItems.map((item) => String(item.id))).toEqual([
      "item-3",
      "item-4",
      "item-5",
    ]);
    // run-1 messages drop; run-2 and run-less messages stay.
    expect(windowed.messages.map((entry) => String(entry.id))).toEqual(["m-2", "m-3"]);
    expect(windowed.truncatedVisibleItemCount).toBe(2);
  });

  it("merges the full history back underneath live rows", () => {
    const windowed = windowOrchestrationV2ThreadProjection(projection, 2);
    const merged = mergeOrchestrationV2FullHistory(windowed, projection);
    expect(merged.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "item-5",
    ]);
    expect(merged.visibleTurnItems.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
    expect(merged.turnItems).toHaveLength(5);
    expect(merged.messages.map((entry) => String(entry.id)).sort()).toEqual(["m-1", "m-2", "m-3"]);
    expect(merged.truncatedVisibleItemCount).toBeUndefined();
  });
});
