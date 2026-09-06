// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Codegen tooling runs from plain node before an Effect runtime exists.
/**
 * Emits contract-derived JSON fixtures for the native SwiftUI client's tests.
 *
 * The Swift client mirrors `packages/contracts` by hand — there is no codegen —
 * so a contract change is silently non-breaking at Swift compile time and fails
 * at runtime instead. These fixtures close that hole: the payloads are built
 * from the TypeScript types and encoded through the real Effect schema, so if a
 * contract changes shape this script's output changes with it and the Swift
 * decode tests fail in CI rather than on a user's phone.
 *
 * Run after any change to `packages/contracts/src/orchestrationV2.ts`:
 *
 *   node scripts/generate-swift-contract-fixtures.ts
 *   node scripts/generate-swift-contract-fixtures.ts --check   # CI: fail if stale
 */
import {
  ServerProviderUsageLimits,
  CheckpointId,
  CheckpointScopeId,
  ContextHandoffId,
  MessageId,
  NodeId,
  OrchestrationV2ThreadProjection,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const outputPath = NodePath.join(
  repoRoot,
  "apps/swift-ios/Tests/CoreTests/Fixtures/orchestrationV2Projection.json",
);

// `Schema.DateTimeUtc` decodes to a `DateTime.Utc`, so the values handed to the
// encoder must be DateTimes; the encoder is what turns them back into ISO strings.
const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-v2");
const projectId = ProjectId.make("project-v2");
const providerInstanceId = ProviderInstanceId.make("codex");
const runId = RunId.make("run-1");
const nodeId = NodeId.make("node-1");
const providerThreadId = ProviderThreadId.make("provider-thread-1");
const providerTurnId = ProviderTurnId.make("provider-turn-1");

let ordinal = 0;
function base(id: string) {
  ordinal += 1;
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId,
    providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

/**
 * One instance of every turn item type. The Swift test asserts none of these
 * decode into the forward-compatible `unknown` case, which is what catches a
 * newly added or renamed variant.
 */
const turnItems: OrchestrationV2TurnItem[] = [
  // `user_message` is the one variant that also carries the creation fields.
  {
    ...base("item-user"),
    createdBy: "user" as const,
    creationSource: "web" as const,
    type: "user_message",
    messageId: MessageId.make("message-user"),
    inputIntent: "turn_start",
    text: "Hello",
    attachments: [],
  },
  // A scheduler-fired message. The fork identifies these by the message id
  // prefix (see `scheduledTaskMessageBadge.ts`), not by `creationSource`.
  {
    ...base("item-user-scheduled"),
    createdBy: "system" as const,
    creationSource: "server" as const,
    type: "user_message",
    messageId: MessageId.make("scheduled-task-message:fire-1"),
    inputIntent: "queued_turn",
    text: "Scheduled run",
    attachments: [],
  },
  {
    ...base("item-assistant"),
    type: "assistant_message",
    messageId: MessageId.make("message-assistant"),
    text: "Hi",
    streaming: false,
  },
  { ...base("item-reasoning"), type: "reasoning", text: "Thinking", streaming: false },
  {
    ...base("item-plan"),
    type: "proposed_plan",
    planId: PlanId.make("plan-1"),
    markdown: "# Plan",
    streaming: false,
  },
  {
    ...base("item-todo"),
    type: "todo_list",
    planId: PlanId.make("plan-2"),
    steps: [{ id: "step-1", text: "Do it", status: "completed" }],
    explanation: "Because",
  },
  {
    ...base("item-input"),
    type: "user_input_request",
    requestId: RuntimeRequestId.make("request-input"),
    questions: [
      {
        id: "q1",
        header: "Pick",
        question: "Which one?",
        options: [{ label: "A", description: "First" }],
      },
    ],
  },
  {
    ...base("item-file-change"),
    type: "file_change",
    fileName: "src/index.ts",
    additions: 3,
    deletions: 1,
    diffStr: "@@ -1 +1 @@",
    oldStr: "a",
    newStr: "b",
  },
  {
    ...base("item-command"),
    type: "command_execution",
    input: "ls",
    output: "file.txt",
    exitCode: 0,
    background: true,
    taskId: "task-1",
    hasOutputStream: true,
    timeoutMs: 1_000,
    paused: false,
    pausedMs: 0,
    outputTruncated: false,
    exitReason: "exited",
    lastOutputAt: now,
  },
  {
    ...base("item-monitor"),
    type: "command_execution",
    input: "wait",
    waitKind: "monitor",
    waitingOnTaskId: "task-1",
    background: true,
  },
  {
    ...base("item-file-search"),
    type: "file_search",
    pattern: "*.ts",
    results: [{ fileName: "src/index.ts", line: 2, column: 4, preview: "const" }],
  },
  {
    ...base("item-web-search"),
    type: "web_search",
    patterns: ["effect schema"],
    results: [{ title: "Effect", url: "https://effect.website", snippet: "docs" }],
  },
  {
    ...base("item-approval"),
    type: "approval_request",
    requestId: RuntimeRequestId.make("request-approval"),
    requestKind: "command",
    prompt: "Run ls?",
  },
  {
    ...base("item-checkpoint"),
    type: "checkpoint",
    checkpointId: CheckpointId.make("checkpoint-1"),
    scopeId: CheckpointScopeId.make("scope-1"),
    files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
  },
  {
    ...base("item-rollback"),
    type: "checkpoint_rollback",
    checkpointId: CheckpointId.make("checkpoint-1"),
    scopeId: CheckpointScopeId.make("scope-1"),
    restoredFileCount: 1,
    rolledBackRunCount: 1,
  },
  { ...base("item-interrupt-request"), type: "run_interrupt_request", message: "stop" },
  { ...base("item-interrupt-result"), type: "run_interrupt_result", message: "stopped" },
  {
    ...base("item-error"),
    type: "error",
    failure: { class: "provider_error", message: "boom", code: "E_BOOM", retryable: true },
    retry: { attempt: 1, maxAttempts: 3, retryDelayMs: 500 },
  },
  {
    ...base("item-compaction"),
    type: "compaction",
    driver: ProviderDriverKind.make("codex"),
    summary: "compacted",
    beforeTokenCount: 100,
    afterTokenCount: 10,
  },
  {
    ...base("item-handoff"),
    type: "handoff",
    contextHandoffId: ContextHandoffId.make("handoff-1"),
    fromProviderThreadIds: [providerThreadId],
    toProviderThreadId: ProviderThreadId.make("provider-thread-2"),
    fromProviderInstanceIds: [providerInstanceId],
    toProviderInstanceId: providerInstanceId,
    toModel: "gpt-5.4",
    strategy: "full_thread_summary",
    summary: "handed off",
  },
  {
    ...base("item-fork"),
    type: "fork",
    source: { type: "run", threadId, runId },
    targetThreadId: ThreadId.make("thread-fork"),
    providerThreadId,
  },
  {
    ...base("item-thread-created"),
    type: "thread_created",
    targetThreadId: ThreadId.make("thread-child"),
    targetRunId: RunId.make("run-2"),
    targetProviderInstanceId: providerInstanceId,
    targetModel: "gpt-5.4",
  },
  {
    ...base("item-subagent"),
    type: "subagent",
    subagentId: NodeId.make("node-sub"),
    origin: "app_owned",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId,
    childThreadId: ThreadId.make("thread-child"),
    prompt: "Investigate",
    progress: "halfway",
    result: "done",
  },
  {
    ...base("item-dynamic-tool"),
    type: "dynamic_tool",
    toolName: "t3-code__delegate_task",
    input: { task: "go" },
    output: { ok: true },
  },
];

const projection = {
  thread: {
    id: threadId,
    projectId,
    title: "Thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThreadId,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user" as const,
    creationSource: "web" as const,
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
  messages: [],
  plans: [],
  turnItems,
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  // Windowed on purpose: the fork replaced upstream's keyset pagination with
  // this, so the Swift "load earlier" path is exercised by the fixture.
  visibleTurnItems: turnItems.map((item, index) => ({
    position: index,
    visibility: "local" as const,
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  })),
  truncatedVisibleItemCount: 7,
  updatedAt: now,
};

let encoded: unknown;
try {
  encoded = Effect.runSync(
    Schema.encodeEffect(OrchestrationV2ThreadProjection)(
      projection as unknown as OrchestrationV2ThreadProjection,
    ),
  );
} catch (error) {
  // The raw SchemaError dump is a wall of AST internals. `message` carries the
  // failing path and reason, which is what anyone editing this script needs.
  console.error("[swift-fixtures] projection failed to encode against the contract:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const serialized = `${JSON.stringify(encoded, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = NodeFS.existsSync(outputPath) ? NodeFS.readFileSync(outputPath, "utf8") : "";
  if (existing !== serialized) {
    console.error(
      `[swift-fixtures] ${outputPath} is stale.\n` +
        "Run: node scripts/generate-swift-contract-fixtures.ts",
    );
    process.exit(1);
  }
  console.log("[swift-fixtures] up to date");
} else {
  NodeFS.mkdirSync(NodePath.dirname(outputPath), { recursive: true });
  NodeFS.writeFileSync(outputPath, serialized);
  console.log(`[swift-fixtures] wrote ${outputPath} (${turnItems.length} turn items)`);
}

const limitsPath = NodePath.join(NodePath.dirname(outputPath), "providerUsageLimits.json");
const limits = Schema.encodeSync(ServerProviderUsageLimits)({
  checkedAt: "2026-09-06T00:00:00.000Z",
  windows: [
    {
      id: "primary",
      kind: "session",
      label: "Session",
      usedPercent: 42,
      resetsAt: "2026-09-06T05:00:00.000Z",
      windowDurationMins: 300,
    },
  ],
});
const limitsSerialized = `${JSON.stringify(limits, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(limitsPath) ||
    NodeFS.readFileSync(limitsPath, "utf8") !== limitsSerialized
  ) {
    console.error("[swift-fixtures] providerUsageLimits.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else {
  NodeFS.writeFileSync(limitsPath, limitsSerialized);
}
