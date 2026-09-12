import { TerminalSummary, TerminalWriteInput } from "../packages/contracts/src/terminal.ts";
import {
  AgentSessionScanResult,
  AgentSessionImportResult,
} from "../packages/contracts/src/agentSessions.ts";
import { formatAssistantCitationHref } from "../packages/shared/src/assistantCitations.ts";
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
  HostResourcesSnapshot,
  ServerSettings,
  ServerSettingsPatch,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  AssistantCitation,
  CustomModelSetting,
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentCapabilities,
  AssetResource,
  AssetCreateUrlResult,
  EnvironmentId,
  ServerProviderUsageLimits,
  UsageLimitSourceId,
  UsageLimitSourceSnapshot,
  UsageLimitSourceConfig,
  ServerProvider,
  PullRequestStack,
  PullRequestLabelCandidateList,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsResult,
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestSubmitReviewInput,
  PullRequestThreadCommentsResult,
  PullRequestDetail,
  PullRequestActionInput,
  PullRequestUpdateInput,
  PullRequestReaction,
  PullRequestReactionInput,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  UsageModelPriceOverride,
  UsageSummary,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  CheckpointId,
  CheckpointScopeId,
  ContextHandoffId,
  MessageId,
  NodeId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2Run,
  OrchestrationV2ConversationMessage,
  PlanId,
  ProjectId,
  ProjectIconOverride,
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
        multiSelect: false,
        allowCustomAnswer: false,
        options: [{ label: "A", description: "First", value: " choice: opaque " }],
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
    options: [
      { decision: "accept", label: "Allow once" },
      { decision: "acceptForSession", label: "Allow this session" },
      { decision: "decline", label: "Decline" },
    ],
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
    toolSurface: "browser",
    toolIcon: {
      _tag: "website",
      pageUrl: "https://github.com/org/repo",
      faviconUrlDark: "https://github.githubassets.com/favicons/favicon-dark.svg",
    },
    toolSource: {
      key: "browser-use:chrome",
      name: "Chrome",
      kind: "integration",
      icon: { _tag: "native-app", app: { _tag: "display-name", displayName: "Google Chrome" } },
    },
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
    pullRequests: [41, 42, 43].map((number) => ({
      projectId,
      host: "github.com",
      repository: "example/repo",
      number,
      url: `https://github.com/example/repo/pull/${number}`,
      source:
        number === 43
          ? ("stack-dismissed" as const)
          : number === 42
            ? ("stack" as const)
            : ("agent" as const),
      linkedAt: DateTime.formatIso(now),
      snapshot: {
        state: "open" as const,
        title: `Change ${number}`,
        headBranch: `feature/${number}`,
        baseBranch: number === 41 ? "main" : `feature/${number - 1}`,
        isDraft: number === 42,
        updatedAt: DateTime.formatIso(now),
        syncedAt: DateTime.formatIso(now),
        author: { login: "octocat", name: null, avatarUrl: null },
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        reviewDecision: "approved" as const,
        checksState: "passing" as const,
        mergeability: "mergeable" as const,
      },
      stack: {
        kind: "native" as const,
        id: "stack-9",
        number: 9,
        url: "https://github.com/example/repo/stack/9",
        base: "main",
        layers: [41, 42, 43].map((n) => ({
          number: n,
          headBranch: `feature/${n}`,
          state: "open" as const,
        })),
      },
    })),
    branchPullRequest: {
      projectId,
      repository: "example/repo",
      number: 42,
      url: "https://github.com/example/repo/pull/42",
    },
    linkedPullRequests: [41, 42].map((number) => ({
      projectId,
      repository: "example/repo",
      number,
      url: `https://github.com/example/repo/pull/${number}`,
    })),
    linkedPullRequest: {
      projectId,
      repository: "example/repo",
      number: 41,
      url: "https://github.com/example/repo/pull/41",
    },
    activeProviderThreadId: providerThreadId,
    activeOrderKey: "n",
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
  runtimeRequests: [
    {
      id: RuntimeRequestId.make("request-input"),
      nodeId: NodeId.make("node-input"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseMode: "message",
      responseCapability: { type: "not_resumable", reason: "Historical callback session" },
      createdAt: now,
      resolvedAt: null,
    },
  ],
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
  resetCredits: { availableCount: 2, nextExpiresAt: "2026-09-28T00:00:00.000Z" },
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

const stackPath = NodePath.join(NodePath.dirname(outputPath), "pullRequestStack.json");
const stackSerialized = `${JSON.stringify(
  Schema.encodeSync(PullRequestStack)({
    id: "stack-1",
    number: 1,
    url: "https://github.com/o/r/stack/1",
    base: "main",
    layers: [
      { number: 1, headBranch: "one", state: "merged" },
      {
        number: 2,
        headBranch: "two",
        title: "Second layer",
        isDraft: false,
        state: "open",
        headSha: "abc",
      },
      { number: 3, headBranch: "three", state: "open", headSha: "def" },
    ],
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (!NodeFS.existsSync(stackPath) || NodeFS.readFileSync(stackPath, "utf8") !== stackSerialized) {
    console.error("[swift-fixtures] pullRequestStack.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else {
  NodeFS.writeFileSync(stackPath, stackSerialized);
}

const labelsPath = NodePath.join(NodePath.dirname(outputPath), "pullRequestLabels.json");
const labelsSerialized = `${JSON.stringify(
  Schema.encodeSync(PullRequestLabelCandidateList)({
    candidates: [
      { name: "bug", color: "d73a4a", description: "Something is broken", isApplied: true },
      { name: "legacy", color: null, description: null, isApplied: false },
    ],
    truncated: true,
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(labelsPath) ||
    NodeFS.readFileSync(labelsPath, "utf8") !== labelsSerialized
  ) {
    console.error("[swift-fixtures] pullRequestLabels.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else {
  NodeFS.writeFileSync(labelsPath, labelsSerialized);
}

const pricePath = NodePath.join(NodePath.dirname(outputPath), "usageModelPrice.json");
const priceSerialized = `${JSON.stringify(
  Schema.encodeSync(UsageModelPriceOverride)({
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 8,
    cacheReadCostPerMillionTokens: 0,
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (!NodeFS.existsSync(pricePath) || NodeFS.readFileSync(pricePath, "utf8") !== priceSerialized) {
    console.error("[swift-fixtures] usageModelPrice.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pricePath, priceSerialized);

const machinePath = NodePath.join(NodePath.dirname(outputPath), "environmentMachine.json");
const machineSerialized = `${JSON.stringify(
  Schema.encodeSync(ExecutionEnvironmentDescriptor)({
    environmentId: EnvironmentId.make("machine-environment"),
    label: "Studio",
    platform: { os: "darwin", arch: "arm64", machine: "mac-studio" },
    serverVersion: "0.0.38",
    capabilities: {
      repositoryIdentity: true,
      environmentIcon: true,
      customModelDefinitions: true,
      projectIcons: true,
      assistantCitations: true,
    },
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(machinePath) ||
    NodeFS.readFileSync(machinePath, "utf8") !== machineSerialized
  ) {
    console.error("[swift-fixtures] environmentMachine.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(machinePath, machineSerialized);

const customModelsPath = NodePath.join(NodePath.dirname(outputPath), "customModels.json");
const customModelsSerialized = `${JSON.stringify(
  Schema.encodeSync(Schema.Array(CustomModelSetting))([
    "legacy-model",
    {
      slug: "private/model",
      name: "Private model",
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High", isDefault: true }],
            currentValue: "high",
          },
          { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
        ],
      },
    },
  ]),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(customModelsPath) ||
    NodeFS.readFileSync(customModelsPath, "utf8") !== customModelsSerialized
  ) {
    console.error("[swift-fixtures] customModels.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(customModelsPath, customModelsSerialized);

const citationPath = NodePath.join(NodePath.dirname(outputPath), "assistantCitation.json");
const citationFixture = Schema.encodeSync(AssistantCitation)({
  version: 1,
  environmentId: EnvironmentId.make("environment/remote"),
  threadId: ThreadId.make("thread:one"),
  messageId: MessageId.make("assistant?one"),
  text: "Use `cache[key]` 🚀",
  comment: "Why?",
  start: 0,
  end: 19,
  prefix: "",
  suffix: "",
});
const citationSerialized = `${JSON.stringify({ citation: citationFixture, href: formatAssistantCitationHref(Schema.decodeUnknownSync(AssistantCitation)(citationFixture)) }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(citationPath) ||
    NodeFS.readFileSync(citationPath, "utf8") !== citationSerialized
  ) {
    console.error("[swift-fixtures] assistantCitation.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(citationPath, citationSerialized);

const projectIconsPath = NodePath.join(NodePath.dirname(outputPath), "projectIcons.json");
const projectIconsSerialized = `${JSON.stringify(
  Schema.encodeSync(Schema.Array(Schema.NullOr(ProjectIconOverride)))([
    { kind: "lucide", name: "folder-code", color: "violet" },
    { kind: "emoji", emoji: "👩🏽‍💻" },
    null,
  ]),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(projectIconsPath) ||
    NodeFS.readFileSync(projectIconsPath, "utf8") !== projectIconsSerialized
  ) {
    console.error("[swift-fixtures] projectIcons.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(projectIconsPath, projectIconsSerialized);

const pullRequestWorkspacePath = NodePath.join(
  NodePath.dirname(outputPath),
  "pullRequestWorkspace.json",
);
const pullRequestWorkspaceSerialized = `${JSON.stringify(
  Schema.encodeSync(
    Schema.Struct({
      input: PullRequestListInput,
      result: PullRequestListResult,
      stats: PullRequestListStatsResult,
    }),
  )({
    input: {
      state: "open",
      involvement: "authored",
      projectIds: [ProjectId.make("project-pr")],
      host: "github.com",
      limit: 50,
      query: "compiler",
      filters: {
        draft: "hide",
        checks: "passing",
        labels: [["bug", "docs"]],
        excludedLabels: ["wontfix"],
        author: "me",
      },
      cursors: { "github.com owner/repo": "opaque-next" },
    },
    result: {
      viewers: { "github.com": "me" },
      providers: [
        {
          host: "github.com",
          kind: "github",
          searchesOnHost: true,
          projectCount: 1,
          configured: true,
          detail: null,
        },
      ],
      entries: ["github.com", "enterprise.example"].map((host) => ({
        provider: "github",
        host,
        projectId: ProjectId.make("project-pr"),
        projectTitle: "Compiler",
        repository: "owner/repo",
        number: 42,
        title: "Fix compiler",
        url: `https://${host}/owner/repo/pull/42`,
        author: { login: "me", name: null, avatarUrl: null },
        headBranch: "fix-compiler",
        baseBranch: "main",
        state: "open",
        isDraft: false,
        mergeability: "mergeable",
        additions: 0,
        deletions: 0,
        createdAt: "2026-09-10T12:00:00.000Z",
        updatedAt: "2026-09-10T12:01:00.000Z",
        viewerReviewRequested: false,
        labels: [{ name: "bug", color: "ff0000" }],
        reviewDecision: "approved",
        checksState: "passing",
      })),
      errors: [
        {
          projectId: ProjectId.make("unavailable"),
          projectTitle: "Offline project",
          message: "Host unavailable",
        },
      ],
      truncated: true,
      nextCursors: { "github.com owner/repo": "opaque-next" },
    },
    stats: {
      stats: [
        {
          projectId: ProjectId.make("project-pr"),
          repository: "owner/repo",
          number: 42,
          additions: 0,
          deletions: 0,
        },
      ],
    },
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(pullRequestWorkspacePath) ||
    NodeFS.readFileSync(pullRequestWorkspacePath, "utf8") !== pullRequestWorkspaceSerialized
  ) {
    console.error("[swift-fixtures] pullRequestWorkspace.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pullRequestWorkspacePath, pullRequestWorkspaceSerialized);

const pullRequestDiffPath = NodePath.join(NodePath.dirname(outputPath), "pullRequestDiff.json");
const pullRequestDiffSerialized = `${JSON.stringify(
  Schema.encodeSync(
    Schema.Struct({
      input: PullRequestDiffInput,
      result: PullRequestDiffResult,
      fileInput: PullRequestDiffFileContentsInput,
      fileContents: PullRequestDiffFileContentsResult,
    }),
  )({
    input: {
      projectId,
      repository: "owner/repo",
      number: 42,
      cursor: "opaque/next",
      commit: "abc123",
    },
    fileInput: {
      projectId,
      repository: "owner/repo",
      number: 42,
      commit: "abc123",
      changeType: "rename-changed",
      oldPath: "old.swift",
      newPath: "new.swift",
    },
    fileContents: { oldContents: "old\n", newContents: "new\n" },
    result: {
      patch: "",
      truncated: true,
      nextCursor: "opaque/last",
      omittedFileStats: [{ path: "large.txt", additions: 1200, deletions: 87 }],
    },
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(pullRequestDiffPath) ||
    NodeFS.readFileSync(pullRequestDiffPath, "utf8") !== pullRequestDiffSerialized
  ) {
    console.error("[swift-fixtures] pullRequestDiff.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pullRequestDiffPath, pullRequestDiffSerialized);

const pullRequestReviewPath = NodePath.join(NodePath.dirname(outputPath), "pullRequestReview.json");
const pullRequestReviewSerialized = `${JSON.stringify(
  Schema.encodeSync(PullRequestSubmitReviewInput)({
    projectId,
    repository: "owner/repo",
    number: 42,
    verdict: "comment",
    body: "  Markdown  ",
    comments: [
      {
        path: "new.swift",
        oldPath: "old.swift",
        position: { kind: "added", newLine: 4 },
        body: "addition",
      },
      { path: "old.swift", position: { kind: "deleted", oldLine: 9 }, body: "deletion" },
      {
        path: "file.swift",
        position: { kind: "context", oldLine: 8, newLine: 10, side: "right" },
        body: "context",
      },
    ],
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(pullRequestReviewPath) ||
    NodeFS.readFileSync(pullRequestReviewPath, "utf8") !== pullRequestReviewSerialized
  ) {
    console.error("[swift-fixtures] pullRequestReview.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pullRequestReviewPath, pullRequestReviewSerialized);

const pullRequestThreadPath = NodePath.join(NodePath.dirname(outputPath), "pullRequestThread.json");
const pullRequestThreadSerialized = `${JSON.stringify(
  Schema.encodeSync(PullRequestThreadCommentsResult)({
    comments: [
      {
        id: "comment-2",
        author: null,
        body: "  Markdown reply  ",
        createdAt: "2026-09-10T00:00:00Z",
        url: null,
      },
    ],
    nextCursor: "opaque/thread/page3",
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(pullRequestThreadPath) ||
    NodeFS.readFileSync(pullRequestThreadPath, "utf8") !== pullRequestThreadSerialized
  ) {
    console.error("[swift-fixtures] pullRequestThread.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pullRequestThreadPath, pullRequestThreadSerialized);

const pullRequestActionsPath = NodePath.join(
  NodePath.dirname(outputPath),
  "pullRequestActions.json",
);
const pullRequestActionsSerialized = `${JSON.stringify(
  Schema.encodeSync(
    Schema.Struct({
      detail: PullRequestDetail,
      input: PullRequestActionInput,
      titleUpdate: PullRequestUpdateInput,
      clearDescription: PullRequestUpdateInput,
    }),
  )({
    detail: {
      provider: "github",
      projectId,
      projectTitle: "Project",
      workspaceRoot: "/workspace",
      repository: "owner/repo",
      number: 42,
      title: "Update the UI",
      body: "Description",
      url: "https://github.com/owner/repo/pull/42",
      author: { login: "octocat", name: null, avatarUrl: null },
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 3,
      deletions: 1,
      changedFiles: 1,
      headBranch: "feature",
      baseBranch: "main",
      createdAt: "2026-09-10T00:00:00Z",
      updatedAt: "2026-09-10T01:00:00Z",
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      labels: [],
      checks: [],
      mergeCapabilities: { merge: false, squash: true, rebase: false },
      viewer: "octocat",
      baseComparison: "behind",
      behindBy: 3,
      autoMergeEnabled: false,
      capabilities: {
        edit: { changeRequest: true, comment: true },
        diff: true,
        comment: true,
        actions: [
          "merge",
          "ready",
          "draft",
          "close",
          "reopen",
          "update-branch",
          "enable-auto-merge",
          "disable-auto-merge",
        ],
        mergeMethods: ["merge", "squash", "rebase"],
        updateMethods: ["merge", "rebase"],
        search: true,
        review: {
          inlineComment: true,
          reply: true,
          resolve: true,
          verdicts: ["comment", "approve", "request-changes"],
        },
        reviewers: { request: true, listCandidates: true },
      },
      viewerPermissions: {
        actions: [
          "merge",
          "ready",
          "draft",
          "close",
          "reopen",
          "update-branch",
          "enable-auto-merge",
          "disable-auto-merge",
        ],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve"],
        requestReviewers: true,
        updateMethods: ["merge"],
      },
    },
    titleUpdate: { projectId, repository: "owner/repo", number: 42, title: "New title" },
    clearDescription: { projectId, repository: "owner/repo", number: 42, body: "" },
    input: {
      projectId,
      repository: "owner/repo",
      number: 42,
      action: "update-branch",
      updateMethod: "merge",
    },
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(pullRequestActionsPath) ||
    NodeFS.readFileSync(pullRequestActionsPath, "utf8") !== pullRequestActionsSerialized
  ) {
    console.error("[swift-fixtures] pullRequestActions.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pullRequestActionsPath, pullRequestActionsSerialized);

const pullRequestReactionsPath = NodePath.join(
  NodePath.dirname(outputPath),
  "pullRequestReactions.json",
);
const pullRequestReactionsSerialized = `${JSON.stringify(
  Schema.encodeSync(
    Schema.Struct({
      reactions: Schema.Array(PullRequestReaction),
      input: PullRequestReactionInput,
    }),
  )({
    reactions: [{ content: "heart", count: 3, actors: ["a", "b"], viewerHasReacted: true }],
    input: { projectId, repository: "owner/repo", number: 42, content: "heart", reacted: false },
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(pullRequestReactionsPath) ||
    NodeFS.readFileSync(pullRequestReactionsPath, "utf8") !== pullRequestReactionsSerialized
  ) {
    console.error("[swift-fixtures] pullRequestReactions.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pullRequestReactionsPath, pullRequestReactionsSerialized);

const pullRequestReviewersPath = NodePath.join(
  NodePath.dirname(outputPath),
  "pullRequestReviewers.json",
);
const pullRequestReviewersSerialized = `${JSON.stringify(
  Schema.encodeSync(
    Schema.Struct({
      list: PullRequestReviewerCandidateList,
      input: PullRequestReviewerRequestInput,
    }),
  )({
    list: {
      candidates: [
        {
          id: "17",
          kind: "user",
          login: "octocat",
          name: "Octo",
          avatarUrl: null,
          isRequested: false,
        },
        {
          id: "17",
          kind: "team",
          login: "mobile-team",
          name: "Mobile",
          avatarUrl: null,
          isRequested: true,
        },
      ],
      truncated: true,
    },
    input: {
      projectId,
      repository: "owner/repo",
      number: 42,
      reviewers: [{ id: "17", kind: "team" }],
      requested: false,
    },
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(pullRequestReviewersPath) ||
    NodeFS.readFileSync(pullRequestReviewersPath, "utf8") !== pullRequestReviewersSerialized
  ) {
    console.error("[swift-fixtures] pullRequestReviewers.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pullRequestReviewersPath, pullRequestReviewersSerialized);

const pullRequestCheckoutPath = NodePath.join(
  NodePath.dirname(outputPath),
  "pullRequestCheckout.json",
);
const pullRequestCheckoutSerialized = `${JSON.stringify(
  Schema.encodeSync(
    Schema.Struct({
      input: GitPreparePullRequestThreadInput,
      result: GitPreparePullRequestThreadResult,
    }),
  )({
    input: {
      cwd: "/repo",
      reference: "https://github.com/acme/app/pull/3",
      mode: "worktree",
      threadId: ThreadId.make("checkout-thread"),
    },
    result: {
      pullRequest: {
        number: 3,
        title: "Review checkout",
        url: "https://github.com/acme/app/pull/3",
        headBranch: "topic",
        baseBranch: "main",
        state: "open",
      },
      branch: "topic",
      worktreePath: "/repo.worktrees/pr-3",
      isOnPullRequestHead: false,
    },
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(pullRequestCheckoutPath) ||
    NodeFS.readFileSync(pullRequestCheckoutPath, "utf8") !== pullRequestCheckoutSerialized
  ) {
    console.error("[swift-fixtures] pullRequestCheckout.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(pullRequestCheckoutPath, pullRequestCheckoutSerialized);

const providerContextReportingPath = NodePath.join(
  NodePath.dirname(outputPath),
  "providerContextReporting.json",
);
const providerContextReportingSerialized = `${JSON.stringify(Schema.encodeSync(ServerProvider)({ instanceId: ProviderInstanceId.make("codex-work"), driver: ProviderDriverKind.make("codex"), reportsContextWindow: true, enabled: true, installed: true, version: null, status: "ready", auth: { status: "authenticated" }, checkedAt: "2026-09-10T00:00:00Z", models: [{ slug: "test-model", name: "Test model", isCustom: false, capabilities: null, aliases: ["test"], badge: "new" }], slashCommands: [], skills: [] }), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(providerContextReportingPath) ||
    NodeFS.readFileSync(providerContextReportingPath, "utf8") !== providerContextReportingSerialized
  ) {
    console.error("[swift-fixtures] providerContextReporting.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(providerContextReportingPath, providerContextReportingSerialized);

const agentSessionFixturePath = NodePath.join(NodePath.dirname(outputPath), "agentSessions.json");
const agentSessionFixture = `${JSON.stringify(
  {
    scan: Schema.encodeSync(AgentSessionScanResult)({
      candidates: [
        {
          path: "/work/app",
          title: "app",
          sources: ["codex", "claudeAgent"],
          threadCount: 4,
          lastActiveAt: "2026-09-10T12:00:00.000Z",
          alreadyImported: false,
          git: { remoteKey: "github.com/team/app", repository: "team/app" },
        },
        {
          path: "/work/notes",
          title: "notes",
          projectId: ProjectId.make("project-notes"),
          sources: ["codex"],
          threadCount: 5,
          lastActiveAt: "2026-09-10T12:00:00Z",
          alreadyImported: true,
          git: null,
        },
        {
          path: "/work/legacy",
          title: "legacy",
          sources: ["claudeAgent"],
          threadCount: 3,
          lastActiveAt: "2026-09-10T12:00:00Z",
          alreadyImported: false,
        },
      ],
      scannedAt: "2026-09-10T13:00:00Z",
      truncated: true,
    }),
    imported: Schema.encodeSync(AgentSessionImportResult)({ importedCount: 3, skippedCount: 1 }),
    capabilities: Schema.encodeSync(ExecutionEnvironmentCapabilities)({
      repositoryIdentity: true,
      agentSessionImport: true,
      providerTerminalEnvironment: true,
    }),
  },
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(agentSessionFixturePath) ||
    NodeFS.readFileSync(agentSessionFixturePath, "utf8") !== agentSessionFixture
  ) {
    console.error("[swift-fixtures] agentSessions.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else {
  NodeFS.writeFileSync(agentSessionFixturePath, agentSessionFixture);
}

const filePreviewFixturePath = NodePath.join(NodePath.dirname(outputPath), "filePreviews.json");
const filePreviewFixture = `${JSON.stringify(
  {
    host: Schema.encodeSync(AssetResource)({
      _tag: "media-file",
      threadId: ThreadId.make("thread-1"),
      path: "/tmp/report.html",
    }),
    attachment: Schema.encodeSync(AssetResource)({
      _tag: "attachment",
      attachmentId: "upload-pdf",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      disposition: "inline",
    }),
    capabilities: Schema.encodeSync(ExecutionEnvironmentCapabilities)({
      repositoryIdentity: true,
      fileDocumentPreviews: true,
    }),
  },
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(filePreviewFixturePath) ||
    NodeFS.readFileSync(filePreviewFixturePath, "utf8") !== filePreviewFixture
  ) {
    console.error("[swift-fixtures] filePreviews.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(filePreviewFixturePath, filePreviewFixture);

const autoPullFixturePath = NodePath.join(NodePath.dirname(outputPath), "projectAutoPull.json");
const autoPullFixture = `${JSON.stringify(
  {
    patch: Schema.encodeSync(ServerSettingsPatch)({
      defaultAutoPull: true,
      projectAutoPullOverrides: { [ProjectId.make("off")]: false, [ProjectId.make("reset")]: null },
    }),
    settings: Schema.encodeSync(ServerSettings)(
      Schema.decodeSync(ServerSettings)({
        defaultAutoPull: true,
        projectAutoPullOverrides: { off: false },
      }),
    ),
    capabilities: Schema.encodeSync(ExecutionEnvironmentCapabilities)({
      repositoryIdentity: true,
      projectAutoPull: true,
    }),
  },
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(autoPullFixturePath) ||
    NodeFS.readFileSync(autoPullFixturePath, "utf8") !== autoPullFixture
  ) {
    console.error("[swift-fixtures] projectAutoPull.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else {
  NodeFS.writeFileSync(autoPullFixturePath, autoPullFixture);
}

const browserAccessFixturePath = NodePath.join(
  NodePath.dirname(outputPath),
  "projectBrowserAccess.json",
);
const browserAccessFixture = `${JSON.stringify(
  {
    patch: Schema.encodeSync(ServerSettingsPatch)({
      enableAgentBrowserAccess: false,
      projectAgentBrowserAccessOverrides: {
        [ProjectId.make("off")]: false,
        [ProjectId.make("reset")]: null,
      },
    }),
    settings: Schema.encodeSync(ServerSettings)(
      Schema.decodeSync(ServerSettings)({
        enableAgentBrowserAccess: true,
        projectAgentBrowserAccessOverrides: { off: false },
      }),
    ),
    capabilities: Schema.encodeSync(ExecutionEnvironmentCapabilities)({
      repositoryIdentity: true,
      projectBrowserAccess: true,
    }),
  },
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(browserAccessFixturePath) ||
    NodeFS.readFileSync(browserAccessFixturePath, "utf8") !== browserAccessFixture
  ) {
    console.error("[swift-fixtures] projectBrowserAccess.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else {
  NodeFS.writeFileSync(browserAccessFixturePath, browserAccessFixture);
}

const projectDefaultsFixturePath = NodePath.join(
  NodePath.dirname(outputPath),
  "projectDefaults.json",
);
const projectDefaultsFixture = `${JSON.stringify(
  {
    patch: Schema.encodeSync(ServerSettingsPatch)({
      defaultModelSelection: null,
      defaultThreadEnvMode: "worktree",
    }),
    settings: Schema.encodeSync(ServerSettings)(
      Schema.decodeSync(ServerSettings)({
        defaultModelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        defaultThreadEnvMode: "worktree",
      }),
    ),
    capabilities: Schema.encodeSync(ExecutionEnvironmentCapabilities)({
      repositoryIdentity: true,
      projectDefaults: true,
    }),
  },
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(projectDefaultsFixturePath) ||
    NodeFS.readFileSync(projectDefaultsFixturePath, "utf8") !== projectDefaultsFixture
  ) {
    console.error("[swift-fixtures] projectDefaults.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(projectDefaultsFixturePath, projectDefaultsFixture);

const projectActionsFixturePath = NodePath.join(
  NodePath.dirname(outputPath),
  "projectActions.json",
);
const actionDefaults = [
  {
    id: "setup",
    name: "Setup",
    command: "echo setup",
    icon: "configure",
    runOnWorktreeCreate: true,
    runOnWorktreeDelete: true,
    singleRun: true,
  },
] as const;
const projectActionsFixture = `${JSON.stringify(
  {
    patch: Schema.encodeSync(ServerSettingsPatch)({
      defaultProjectScripts: actionDefaults,
      projectScriptOverrides: { [ProjectId.make("reset")]: null, [ProjectId.make("empty")]: [] },
    }),
    settings: Schema.encodeSync(ServerSettings)(
      Schema.decodeSync(ServerSettings)({
        defaultProjectScripts: actionDefaults,
        projectScriptOverrides: { reset: null, empty: [] },
      }),
    ),
    capabilities: Schema.encodeSync(ExecutionEnvironmentCapabilities)({
      repositoryIdentity: true,
      projectActionDefaults: true,
    }),
  },
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(projectActionsFixturePath) ||
    NodeFS.readFileSync(projectActionsFixturePath, "utf8") !== projectActionsFixture
  ) {
    console.error("[swift-fixtures] projectActions.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(projectActionsFixturePath, projectActionsFixture);

const assetImageDimensionsPath = NodePath.join(
  NodePath.dirname(outputPath),
  "assetImageDimensions.json",
);
const assetImageDimensionsSerialized = `${JSON.stringify(Schema.encodeSync(AssetCreateUrlResult)({ relativeUrl: "/api/assets/signed/image.png", expiresAt: 1785466800000, imageDimensions: { width: 1600, height: 900 } }), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(assetImageDimensionsPath) ||
    NodeFS.readFileSync(assetImageDimensionsPath, "utf8") !== assetImageDimensionsSerialized
  ) {
    console.error("[swift-fixtures] assetImageDimensions.json is stale; regenerate fixtures.");
    process.exitCode = 1;
  }
} else NodeFS.writeFileSync(assetImageDimensionsPath, assetImageDimensionsSerialized);

const restartFixturePath = NodePath.join(NodePath.dirname(outputPath), "restartContinuation.json");
const restartMessageId = MessageId.make("restart-message");
const restartFixture =
  JSON.stringify(
    {
      run: Effect.runSync(
        Schema.encodeEffect(OrchestrationV2Run)({
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          providerThreadId,
          userMessageId: MessageId.make("original-message"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "cancelled",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
          restartContinuation: {
            messageId: restartMessageId,
            reason: "restart",
            status: "pending",
          },
        }),
      ),
      message: Effect.runSync(
        Schema.encodeEffect(OrchestrationV2ConversationMessage)({
          id: restartMessageId,
          threadId,
          runId,
          nodeId: null,
          role: "user",
          text: "Continue after restart",
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "server",
          createdAt: now,
          updatedAt: now,
          restartContinuation: true,
        }),
      ),
      capabilities: Schema.decodeSync(ExecutionEnvironmentCapabilities)({
        threadRestartContinuation: true,
      }),
    },
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(restartFixturePath) ||
    NodeFS.readFileSync(restartFixturePath, "utf8") !== restartFixture
  ) {
    console.error("[swift-fixtures] restartContinuation.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(restartFixturePath, restartFixture);

const hostResourcesPath = NodePath.join(NodePath.dirname(outputPath), "hostResources.json");
const hostResourcesFixture =
  JSON.stringify(
    {
      samples: [
        {
          sampledAt: 100000,
          cpuUtilization: 0.2,
          cpuCount: 8,
          availableMemoryBytes: 8000,
          totalMemoryBytes: 16000,
        },
        {
          sampledAt: 100000,
          cpuUtilization: null,
          cpuCount: 0,
          availableMemoryBytes: 0,
          totalMemoryBytes: 16000,
        },
      ].map((sample) => Effect.runSync(Schema.encodeEffect(HostResourcesSnapshot)(sample))),
    },
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(hostResourcesPath) ||
    NodeFS.readFileSync(hostResourcesPath, "utf8") !== hostResourcesFixture
  ) {
    console.error("[swift-fixtures] hostResources.json is stale; regenerate fixtures.");
    process.exitCode = 1;
  }
} else NodeFS.writeFileSync(hostResourcesPath, hostResourcesFixture);

const usageHistoryPath = NodePath.join(NodePath.dirname(outputPath), "usageHistory.json");
const usageHistorySerialized = `${JSON.stringify(
  Schema.encodeSync(UsageSummary)({
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-09-12T12:00:00Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-09-11"),
    untilDay: UsageDay.make("2026-09-12"),
    buckets: [
      {
        day: UsageDay.make("2026-09-12"),
        hourStart: "2026-09-12T11:00:00Z",
        provider: "grok",
        model: "grok-code",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 20,
          cacheCreationTokens: 0,
          outputTokens: 50,
          reasoningTokens: 10,
        },
        costUsd: 0.2,
        cacheSavingsUsd: 0.01,
        costSource: "modelPriced",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId: "fixture-host",
          provider: "grok",
          resolvedHomePath: "/fixture/grok",
          volumeId: "1:2",
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: {
      status: "fresh",
      source: "fixture",
      fetchedAt: "2026-09-12T12:00:00Z",
      knownModels: 1,
    },
    scanDurationMs: 1,
  }),
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(usageHistoryPath) ||
    NodeFS.readFileSync(usageHistoryPath, "utf8") !== usageHistorySerialized
  ) {
    console.error("[swift-fixtures] usageHistory.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else NodeFS.writeFileSync(usageHistoryPath, usageHistorySerialized);

const hubFixture = {
  source: Schema.encodeSync(UsageLimitSourceSnapshot)({
    id: UsageLimitSourceId.make("team-hub"),
    kind: "cliproxy",
    label: "Team",
    checkedAt: "2026-09-06T01:00:00.000Z",
    accounts: [
      {
        id: "account-a",
        driver: ProviderDriverKind.make("codex"),
        email: "same@example.com",
        plan: "Pro",
        usageLimits: {
          ...Schema.decodeUnknownSync(ServerProviderUsageLimits)(limits),
          checkedAt: "2026-09-06T01:00:00.000Z",
          resetCredits: {
            availableCount: 2,
            nextCreditId: "credit-a",
            nextExpiresAt: "2026-09-28T00:00:00.000Z",
          },
        },
      },
    ],
  }),
  config: Schema.encodeSync(UsageLimitSourceConfig)({
    kind: "cliproxy",
    url: "https://hub.example.test",
    managementKey: "••••••",
    enabled: true,
  }),
};
const hubPath = NodePath.join(NodePath.dirname(outputPath), "usageLimitSource.json");
const hubSerialized = `${JSON.stringify(hubFixture, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!NodeFS.existsSync(hubPath) || NodeFS.readFileSync(hubPath, "utf8") !== hubSerialized) {
    console.error("[swift-fixtures] usageLimitSource.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else {
  NodeFS.writeFileSync(hubPath, hubSerialized);
}

const actionTerminal = {
  summary: Schema.encodeSync(TerminalSummary)({
    threadId: "thread",
    terminalId: "term-2",
    cwd: "/workspace",
    worktreePath: null,
    status: "running",
    pid: 123,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    activeScriptId: "dev",
    label: "pnpm dev",
    updatedAt: "2026-09-12T12:00:00Z",
  }),
  write: Schema.encodeSync(TerminalWriteInput)({
    threadId: "thread",
    terminalId: "term-2",
    data: "pnpm dev\r",
    scriptId: "dev",
  }),
};
const actionTerminalPath = NodePath.join(
  NodePath.dirname(outputPath),
  "projectActionTerminal.json",
);
const actionTerminalSerialized = `${JSON.stringify(actionTerminal, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (
    !NodeFS.existsSync(actionTerminalPath) ||
    NodeFS.readFileSync(actionTerminalPath, "utf8") !== actionTerminalSerialized
  ) {
    console.error("[swift-fixtures] projectActionTerminal.json is stale; regenerate fixtures.");
    process.exit(1);
  }
} else {
  NodeFS.writeFileSync(actionTerminalPath, actionTerminalSerialized);
}
