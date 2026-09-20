import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { delegatedTaskProgress, makeSubagentChildThread } from "./SubagentProjection.ts";

const parentThreadId = ThreadId.make("thread:subagent-snoozed-parent");
const childThreadId = ThreadId.make("thread:subagent-awake-child");
const parentProviderInstanceId = ProviderInstanceId.make("codex");
const childProviderInstanceId = ProviderInstanceId.make("claude");
const parentModelSelection = {
  instanceId: parentProviderInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const childModelSelection = {
  instanceId: childProviderInstanceId,
  model: "claude-opus-4-1",
} satisfies ModelSelection;
const parentCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const childCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeParentThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: parentThreadId,
    projectId: ProjectId.make("project:subagent-snooze"),
    title: "Snoozed parent",
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:subagent-snoozed-parent"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: parentThreadId,
    },
    forkedFrom: null,
    createdAt: parentCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
    historyOrigin: "v1_import",
  };
}

it("keeps a subagent child awake when its parent thread is snoozed", () => {
  const parentThread = makeParentThread();
  const childProviderThreadId = ProviderThreadId.make("provider-thread:subagent-awake-child");
  const parentNodeId = NodeId.make("node:subagent-parent");
  const childThread = makeSubagentChildThread({
    parentThread,
    childThreadId,
    parentNodeId,
    activeProviderThreadId: childProviderThreadId,
    providerInstanceId: childProviderInstanceId,
    modelSelection: childModelSelection,
    title: "Awake child",
    now: childCreatedAt,
    createdBy: "agent",
    creationSource: "provider",
  });

  assert.isNull(childThread.snoozedUntil);
  assert.isNull(childThread.snoozedAt);
  assert.equal(childThread.projectId, parentThread.projectId);
  assert.equal(childThread.runtimeMode, parentThread.runtimeMode);
  assert.equal(childThread.interactionMode, parentThread.interactionMode);
  assert.equal(childThread.branch, parentThread.branch);
  assert.equal(childThread.worktreePath, parentThread.worktreePath);
  assert.equal(childThread.providerInstanceId, childProviderInstanceId);
  assert.deepEqual(childThread.modelSelection, childModelSelection);
  assert.equal(childThread.activeProviderThreadId, childProviderThreadId);
  assert.isUndefined(childThread.historyOrigin);
  assert.deepEqual(childThread.lineage, {
    parentThreadId,
    relationshipToParent: "subagent",
    rootThreadId: parentThreadId,
  });
  assert.deepEqual(childThread.forkedFrom, {
    type: "node",
    nodeId: parentNodeId,
  });
});

const delegatedRun: OrchestrationV2Run = {
  id: RunId.make("run:delegated"),
  threadId: childThreadId,
  ordinal: 1,
  providerInstanceId: childProviderInstanceId,
  modelSelection: childModelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message:delegated-prompt"),
  rootNodeId: NodeId.make("node:delegated-root"),
  activeAttemptId: RunAttemptId.make("attempt:delegated"),
  status: "completed",
  requestedAt: childCreatedAt,
  startedAt: childCreatedAt,
  completedAt: childCreatedAt,
  checkpointId: null,
  contextHandoffId: null,
};

function progressOf(
  overrides: Partial<Parameters<typeof delegatedTaskProgress>[0]>,
): ReturnType<typeof delegatedTaskProgress>["state"] {
  return delegatedTaskProgress({
    runs: [delegatedRun],
    messages: [],
    subagents: [],
    ...overrides,
  }).state;
}

it("reports a finished delegated turn as still working while it owns live children", () => {
  assert.equal(progressOf({}), "result_available");
  assert.equal(progressOf({ subagents: [{ status: "running" }] }), "waiting_for_children");
  assert.equal(progressOf({ subagents: [{ status: "completed" }] }), "result_available");

  // A published child result still owes the parent a wake until it is consumed.
  for (const state of ["pending", "claimed"] as const) {
    assert.equal(
      progressOf({
        subagents: [{ status: "completed", completionDelivery: { state, observedByRunId: null } }],
      }),
      "waiting_for_children",
    );
  }
  for (const state of ["acknowledged", "delivered", "disposed"] as const) {
    assert.equal(
      progressOf({
        subagents: [{ status: "completed", completionDelivery: { state, observedByRunId: null } }],
      }),
      "result_available",
    );
  }
});

it("ignores monitor wakes when deciding whether a delegated task has a result", () => {
  const queued = {
    ...delegatedRun,
    id: RunId.make("run:followup"),
    ordinal: 2,
    status: "queued" as const,
    startedAt: null,
  };
  assert.equal(progressOf({ runs: [delegatedRun, queued] }), "working");

  // A monitor wake is bookkeeping, not work: its run must not become the result.
  const monitorRun = { ...delegatedRun, id: RunId.make("run:monitor"), ordinal: 3 };
  assert.equal(
    progressOf({
      runs: [delegatedRun, monitorRun],
      messages: [
        {
          runId: monitorRun.id,
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor update",
          },
        },
      ],
    }),
    "result_available",
  );
  assert.equal(
    delegatedTaskProgress({
      runs: [delegatedRun, monitorRun],
      messages: [
        {
          runId: monitorRun.id,
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor update",
          },
        },
      ],
      subagents: [],
    }).resultRun?.id,
    delegatedRun.id,
  );
});
