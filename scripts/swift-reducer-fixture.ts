// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Codegen tooling runs from plain node before an Effect runtime exists.
/**
 * Shared cases for the SwiftUI client's live thread reducer.
 *
 * The Swift client ports `applyOrchestrationV2ProjectionEvent` by hand. Each
 * case here is a starting projection and a run of stream items, folded by the
 * real TypeScript reducer the way `applyItems` in threads.ts folds them, so
 * the Swift test asserts it lands on the same projection and resume cursor.
 * Written by generate-swift-contract-fixtures.ts, which CI runs with --check.
 */
import {
  OrchestrationV2ApprovalCapabilities,
  OrchestrationV2CheckpointCapabilities,
  OrchestrationV2ContextCapabilities,
  OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  OrchestrationV2IdentityCapabilities,
  OrchestrationV2PlanningCapabilities,
  OrchestrationV2SessionCapabilities,
  OrchestrationV2StreamingCapabilities,
  OrchestrationV2SubagentCapabilities,
  OrchestrationV2ThreadCapabilities,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadProjectionJson,
  OrchestrationV2ToolCapabilities,
  OrchestrationV2TurnCapabilities,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { applyOrchestrationV2ProjectionEvent } from "../packages/client-runtime/src/state/orchestrationV2Projection.ts";

type Json = Record<string, unknown>;

const threadId = "thread-reducer";
const runId = "run-1";
const at = (minute: number) => `2026-06-20T00:${String(minute).padStart(2, "0")}:00.000Z`;

const thread = (overrides: Json = {}): Json => ({
  id: threadId,
  projectId: "project-reducer",
  title: "Reducer",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

const run = (id: string, status: string, overrides: Json = {}): Json => ({
  id,
  threadId,
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: `message-${id}`,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: at(0),
  startedAt: at(0),
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...overrides,
});

const attempt = (status: string, rootNodeId: string, runRef = runId): Json => ({
  id: `attempt-${runRef}-${rootNodeId}`,
  runId: runRef,
  attemptOrdinal: 1,
  rootNodeId,
  providerInstanceId: "codex",
  providerThreadId: "provider-thread-1",
  providerTurnId: null,
  reason: "initial",
  status,
  startedAt: at(0),
  completedAt: null,
});

const itemBase = (id: string, ordinal: number, overrides: Json = {}): Json => ({
  id,
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: null,
  startedAt: at(0),
  completedAt: at(0),
  updatedAt: at(0),
  ...overrides,
});

const command = (id: string, ordinal: number, output: string, overrides: Json = {}): Json => ({
  ...itemBase(id, ordinal, overrides),
  type: "command_execution",
  input: "pwd",
  output,
  exitCode: 0,
});

const interrupt = (
  id: string,
  ordinal: number,
  type: "run_interrupt_request" | "run_interrupt_result",
): Json => ({
  ...itemBase(id, ordinal, { nodeId: "node-1" }),
  type,
  message: type === "run_interrupt_request" ? "stop" : "stopped",
});

const userMessage = (id: string, ordinal: number, intent: string, runRef: string): Json => ({
  ...itemBase(id, ordinal, { runId: runRef }),
  createdBy: "user",
  creationSource: "web",
  type: "user_message",
  messageId: `message-${id}`,
  inputIntent: intent,
  text: "Queued follow-up",
  attachments: [],
});

const row = (item: Json, position: number, visibility = "local", source = threadId): Json => ({
  position,
  visibility,
  sourceThreadId: source,
  sourceItemId: item.id,
  item,
});

const projection = (overrides: Json = {}): Json => ({
  thread: thread(),
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: at(0),
  ...overrides,
});

/** The driver descriptor is wide and irrelevant here: every flag off. */
const flagsOff = (schema: { readonly fields: object }) =>
  Object.fromEntries(Object.keys(schema.fields).map((key) => [key, false]));
const capabilities: Json = {
  sessions: flagsOff(OrchestrationV2SessionCapabilities),
  threads: flagsOff(OrchestrationV2ThreadCapabilities),
  turns: { ...flagsOff(OrchestrationV2TurnCapabilities), terminalStatusQuality: "strong" },
  streaming: flagsOff(OrchestrationV2StreamingCapabilities),
  tools: flagsOff(OrchestrationV2ToolCapabilities),
  approvals: flagsOff(OrchestrationV2ApprovalCapabilities),
  planning: flagsOff(OrchestrationV2PlanningCapabilities),
  subagents: flagsOff(OrchestrationV2SubagentCapabilities),
  context: { ...flagsOff(OrchestrationV2ContextCapabilities), maxRecommendedHandoffChars: null },
  checkpointing: flagsOff(OrchestrationV2CheckpointCapabilities),
  identity: Object.fromEntries(
    Object.keys(OrchestrationV2IdentityCapabilities.fields).map((key) => [key, "strong"]),
  ),
  runtimePolicy: { enforcement: "native" },
};

const providerTurn = (tokenUsage?: Json): Json => ({
  id: "provider-turn-1",
  providerThreadId: "provider-thread-1",
  nodeId: "node-1",
  runAttemptId: "attempt-run-1-node-1",
  nativeTurnRef: null,
  ordinal: 1,
  status: "running",
  startedAt: at(1),
  completedAt: null,
  ...(tokenUsage === undefined ? {} : { tokenUsage }),
});

const message = (text: string, streaming: boolean): Json => ({
  createdBy: "agent",
  creationSource: "server",
  id: "message-assistant",
  threadId,
  runId,
  nodeId: "node-1",
  role: "assistant",
  text,
  attachments: [],
  streaming,
  createdAt: at(1),
  updatedAt: at(2),
});

const contextTransfer = (status: string): Json => ({
  id: "transfer-1",
  type: "provider_handoff",
  sourceThreadId: threadId,
  targetThreadId: threadId,
  sourcePoint: { threadId },
  basePoint: null,
  sourceProviderInstanceId: "codex",
  targetProviderInstanceId: "claude",
  targetRunId: runId,
  status,
  resolution: null,
  createdBy: "user",
  error: null,
  createdAt: at(3),
  updatedAt: at(3),
  consumedAt: null,
});

interface StreamItem {
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
  readonly minute?: number;
  readonly threadId?: string;
  /** A type this build does not know, or a turn item of one: skipped. */
  readonly unknown?: boolean;
}

const ev = (
  sequence: number,
  type: string,
  payload: unknown,
  extra: Partial<StreamItem> = {},
): StreamItem => ({ sequence, type, payload, ...extra });

interface ReducerCase {
  readonly name: string;
  readonly snapshotSequence: number;
  readonly projection: Json;
  readonly items: ReadonlyArray<StreamItem>;
}

const first = command("item-first", 1, "first");
const second = command("item-second", 2, "second");
const queued = command("item-queued", 300, "queued");
const inherited = command("item-inherited", 1, "inherited");
const local = command("item-local", 2, "local");
const result = interrupt("item-interrupt-result", 2, "run_interrupt_result");
const queuedTurn = userMessage("item-queued-turn", 5, "queued_turn", "run-2");

const cases: ReadonlyArray<ReducerCase> = [
  {
    name: "thread lifecycle and read state",
    snapshotSequence: 1,
    projection: projection(),
    items: [
      ev(2, "thread.archived", thread({ archivedAt: at(5), updatedAt: at(5) }), { minute: 5 }),
      // Visited tracking is read state: it must not bump updatedAt.
      ev(3, "thread.visited", thread({ archivedAt: at(5), lastVisitedAt: at(9) }), {
        minute: 9,
      }),
      // Another thread's event is ignored but still moves the cursor.
      ev(4, "thread.deleted", thread({ id: "thread-other", deletedAt: at(10) }), {
        threadId: "thread-other",
        minute: 10,
      }),
    ],
  },
  {
    name: "title reconciliation applies only newer revisions",
    snapshotSequence: 1,
    projection: projection({ thread: thread({ titleRevision: 2, titleOrigin: "hermes" }) }),
    items: [
      ev(2, "thread.title-reconciled", { title: "Stale", revision: 2, origin: "hermes" }),
      ev(
        3,
        "thread.title-reconciled",
        { title: "Fresh", revision: 3, origin: "hermes" },
        {
          minute: 7,
        },
      ),
    ],
  },
  {
    name: "streaming updates replace their row in place",
    snapshotSequence: 10,
    projection: projection({
      runs: [run(runId, "running")],
      turnItems: [first, second],
      visibleTurnItems: [row(first, 0), row(second, 1)],
    }),
    items: [
      ev(10, "turn-item.updated", command("item-first", 1, "replayed")),
      ev(11, "turn-item.updated", command("item-first", 1, "first a")),
      ev(13, "turn-item.updated", command("item-first", 1, "first ab")),
      // A replay below the cursor after a reconnect must not rewind the row.
      ev(12, "turn-item.updated", command("item-first", 1, "stale")),
      ev(20, "turn-item.updated", command("item-second", 2, "second done")),
    ],
  },
  {
    name: "live items insert by ordinal",
    snapshotSequence: 1,
    projection: projection({
      runs: [run(runId, "running")],
      turnItems: [queued],
      visibleTurnItems: [row(queued, 0)],
    }),
    items: [
      ev(2, "turn-item.updated", command("item-active", 201, "done")),
      ev(3, "turn-item.updated", command("item-tail", 400, "tail")),
      ev(4, "turn-item.updated", command("item-active", 500, "moved")),
    ],
  },
  {
    name: "a rollback hides local rows and keeps inherited ones",
    snapshotSequence: 1,
    projection: projection({
      runs: [run(runId, "completed")],
      turnItems: [local],
      visibleTurnItems: [row(inherited, 0, "inherited", "thread-source"), row(local, 1)],
    }),
    items: [ev(2, "run.updated", run(runId, "rolled_back"))],
  },
  {
    name: "a superseded interrupt hides until its request arrives",
    snapshotSequence: 1,
    projection: projection({
      runs: [run(runId, "running")],
      attempts: [attempt("running", "node-1")],
      turnItems: [first, result],
      visibleTurnItems: [row(first, 0), row(result, 1)],
    }),
    items: [
      ev(2, "run-attempt.updated", attempt("superseded", "node-1")),
      ev(3, "turn-item.updated", interrupt("item-interrupt-request", 3, "run_interrupt_request")),
      ev(4, "turn-item.updated", result),
    ],
  },
  {
    name: "a cancelled queued turn leaves the transcript",
    snapshotSequence: 1,
    projection: projection({
      runs: [run(runId, "running"), run("run-2", "queued", { ordinal: 2 })],
      turnItems: [first, queuedTurn],
      visibleTurnItems: [row(first, 0), row(queuedTurn, 1)],
    }),
    items: [ev(2, "run.updated", run("run-2", "cancelled", { ordinal: 2 }))],
  },
  {
    name: "every table folds and sequence gaps are fine",
    snapshotSequence: 3,
    projection: projection(),
    items: [
      ev(5, "run.created", run(runId, "starting"), { minute: 1 }),
      ev(9, "run-attempt.created", attempt("running", "node-1"), { minute: 1 }),
      ev(
        14,
        "node.updated",
        {
          id: "node-1",
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: "node-1",
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: at(1),
          completedAt: null,
        },
        { minute: 1 },
      ),
      ev(
        15,
        "provider-session.attached",
        {
          id: "session-1",
          driver: "codex",
          providerInstanceId: "codex",
          status: "running",
          cwd: "/repo",
          model: "gpt-5.4",
          capabilities,
          createdAt: at(1),
          updatedAt: at(1),
          lastError: null,
        },
        { minute: 1 },
      ),
      ev(
        16,
        "provider-thread.updated",
        {
          id: "provider-thread-1",
          driver: "codex",
          providerInstanceId: "codex",
          providerSessionId: "session-1",
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: at(1),
          updatedAt: at(1),
        },
        { minute: 1 },
      ),
      ev(
        18,
        "provider-turn.updated",
        providerTurn({ usedTokens: 1200, maxTokens: 200000, updatedAt: at(2) }),
        { minute: 2 },
      ),
      // A later report without usage keeps the last reading.
      ev(19, "provider-turn.updated", providerTurn(), { minute: 2 }),
      ev(20, "message.updated", message("Hel", true), { minute: 2 }),
      ev(21, "message.updated", message("Hello", false), { minute: 2 }),
      ev(
        22,
        "subagent.updated",
        {
          id: "node-sub",
          threadId,
          runId,
          parentNodeId: "node-1",
          origin: "app_owned",
          createdBy: "agent",
          driver: "claudeAgent",
          providerInstanceId: "claude",
          providerThreadId: null,
          childThreadId: "thread-child",
          nativeTaskRef: null,
          prompt: "Audit",
          title: "Audit",
          model: null,
          status: "running",
          progress: "Reading",
          result: null,
          startedAt: at(2),
          completedAt: null,
          updatedAt: at(2),
        },
        { minute: 2 },
      ),
      ev(
        23,
        "runtime-request.updated",
        {
          id: "request-1",
          nodeId: "node-1",
          providerTurnId: "provider-turn-1",
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: "session-1" },
          createdAt: at(2),
          resolvedAt: null,
        },
        { minute: 2 },
      ),
      ev(
        24,
        "plan.updated",
        {
          id: "plan-1",
          threadId,
          runId,
          nodeId: "node-1",
          status: "active",
          kind: "proposed_plan",
          markdown: "# Plan",
        },
        { minute: 3 },
      ),
      ev(
        25,
        "checkpoint-scope.created",
        {
          id: "scope-1",
          threadId,
          runId,
          nodeId: "node-1",
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: at(3),
        },
        { minute: 3 },
      ),
      ev(
        26,
        "checkpoint.captured",
        {
          id: "checkpoint-1",
          threadId,
          scopeId: "scope-1",
          runId,
          nodeId: "node-1",
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: 1,
          ref: "refs/t3/checkpoint-1",
          status: "ready",
          files: [{ path: "src/index.ts", kind: "modified", additions: 2, deletions: 1 }],
          capturedAt: at(3),
        },
        { minute: 3 },
      ),
      ev(
        27,
        "context-handoff.updated",
        {
          id: "handoff-1",
          threadId,
          targetRunId: runId,
          fromProviderThreadIds: ["provider-thread-1"],
          toProviderThreadId: "provider-thread-2",
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: "Summary",
          createdByProviderInstanceId: "codex",
          createdAt: at(3),
          updatedAt: at(3),
        },
        { minute: 3 },
      ),
      ev(28, "context-transfer.created", contextTransfer("pending"), { minute: 3 }),
      ev(29, "context-transfer.updated", contextTransfer("resolved_portable"), { minute: 4 }),
      ev(
        30,
        "checkpoint.rollback-requested",
        { scopeId: "scope-1", checkpointId: "checkpoint-1", requestedAt: at(4) },
        { minute: 4 },
      ),
      ev(
        31,
        "run.background-work-cancelled",
        { runId, restartCancelledBackgroundWork: [] },
        { minute: 5 },
      ),
      ev(
        32,
        "provider-session.detached",
        { providerSessionId: "session-1", detachedAt: at(6) },
        { minute: 6 },
      ),
      ev(40, "quantum.entangled", {}, { minute: 7, unknown: true }),
      ev(
        41,
        "turn-item.updated",
        { ...itemBase("item-future", 9), type: "hologram", frames: 3 },
        { minute: 7, unknown: true },
      ),
    ],
  },
];

const decodeProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson);
const encodeProjection = Schema.encodeSync(OrchestrationV2ThreadProjectionJson);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
const encodeEvent = Schema.encodeSync(OrchestrationV2DomainEventJson);

function wireEvent(item: StreamItem): Json {
  return {
    id: `event-${item.sequence}`,
    type: item.type,
    threadId: item.threadId ?? threadId,
    occurredAt: at(item.minute ?? 0),
    payload: item.payload,
  };
}

function buildCase(reducerCase: ReducerCase) {
  let current: OrchestrationV2ThreadProjection = decodeProjection(reducerCase.projection);
  let cursor = reducerCase.snapshotSequence;
  const items = reducerCase.items.map((item) => {
    const raw = wireEvent(item);
    if (item.unknown === true) {
      // `applyItems` skips these but still advances its cursor.
      if (item.sequence > cursor) cursor = item.sequence;
      return { kind: "event", sequence: item.sequence, event: raw };
    }
    const event: OrchestrationV2DomainEvent = decodeEvent(raw);
    if (item.sequence > cursor) {
      cursor = item.sequence;
      current = applyOrchestrationV2ProjectionEvent(current, event) ?? current;
    }
    return { kind: "event", sequence: item.sequence, event: encodeEvent(event) };
  });
  return {
    name: reducerCase.name,
    snapshotSequence: reducerCase.snapshotSequence,
    projection: encodeProjection(decodeProjection(reducerCase.projection)),
    items,
    expectedSequence: cursor,
    expected: encodeProjection(current),
  };
}

export function writeOrchestrationV2ReducerFixture(directory: string, check: boolean): void {
  const path = NodePath.join(directory, "orchestrationV2Reducer.json");
  const serialized = `${JSON.stringify({ cases: cases.map(buildCase) }, null, 2)}\n`;
  if (check) {
    if (!NodeFS.existsSync(path) || NodeFS.readFileSync(path, "utf8") !== serialized) {
      console.error("[swift-fixtures] orchestrationV2Reducer.json is stale; regenerate fixtures.");
      process.exit(1);
    }
    return;
  }
  NodeFS.writeFileSync(path, serialized);
}
