import {
  type ChatAttachment,
  type HermesGatewayCompatibility,
  type HermesGatewayApprovalRespondResult,
  type HermesGatewayClarificationRespondResult,
  type HermesGatewayHistoryMessage,
  type HermesGatewayInterruptResult,
  type HermesGatewayMutationStatusResult,
  type HermesGatewayPromptSubmitParams,
  type HermesGatewayPromptSubmitResult,
  type HermesGatewaySessionCreateParams,
  type HermesGatewaySessionCreateResult,
  type HermesGatewaySessionBranchParams,
  type HermesGatewaySessionBranchResult,
  type HermesGatewaySessionHistoryResult,
  type HermesGatewaySessionMcpLeaseResult,
  type HermesGatewaySessionMcpParams,
  type HermesGatewaySessionMcpRevokeResult,
  type HermesGatewaySessionResumeParams,
  type HermesGatewaySessionResumeResult,
  type HermesGatewaySessionStatusResult,
  type HermesGatewaySessionTitleParams,
  type HermesGatewaySessionTitleResult,
  HermesGatewayTitleChangedEventPayload,
  type HermesGatewayToolEventPayload,
  HermesSettings,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2PlanStep,
  type OrchestrationV2TurnItem,
  type PlanId,
  type OrchestrationV2RuntimeRequest,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  assessHermesConnectionSecurity,
  HERMES_REMOTE_PAIRING_TOKEN_ENV,
  HERMES_REMOTE_TLS_CERT_SHA256_ENV,
} from "../../hermes/HermesConnectionSecurity.ts";
import {
  HermesGatewayClient,
  HermesGatewayMutationIndeterminateError,
  HermesGatewayRpcError,
  type HermesGatewayMutationOptions,
  type HermesGatewayOrderedEvent,
} from "../../hermes/HermesGatewayClient.ts";
import {
  classifyHermesToolCall,
  hydrateImportedHermesActivities,
  normalizeImportedHermesUserText,
  parseHermesToolArguments,
  type HermesImportedActivity,
} from "../../hermes/HermesImportHydration.ts";
import {
  hermesHistoryMediaRoots,
  normalizeHermesHistoryMessage,
  parseHermesHistoryText,
  persistHermesHistoryMedia,
  type HermesHistoryMediaKind,
} from "../../hermes/HermesHistoryNormalization.ts";
import {
  resolveHermesServeEndpoint,
  type HermesServeRuntimeShape,
} from "../../hermes/HermesServeRuntime.ts";
import {
  HermesSessionBindingRepository,
  type HermesMutationIntent,
  type HermesMutationIntentState,
  type HermesOwnerLease,
  type HermesSessionBinding,
  type HermesSessionBindingRepositoryShape,
} from "../../hermes/HermesSessionBindingRepository.ts";
import { t3OrchestrationPromptForFirstRun } from "../../provider/T3OrchestrationInstructions.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2EnsureThreadInput,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  ProviderContinuationRequests,
  type ProviderContinuationRequest,
} from "../ProviderContinuationRequests.ts";

export const HERMES_PROVIDER = ProviderDriverKind.make("hermes");
export const HERMES_DRIVER_KIND = HERMES_PROVIDER;

const DEFAULT_HERMES_SETTINGS = Schema.decodeSync(HermesSettings)({});

const LEASE_MINUTES = 30;
const INTERRUPT_TERMINAL_TIMEOUT = "15 seconds";
const HERMES_MODEL_SWITCH_POLL_ATTEMPTS = 40;
const HERMES_MODEL_SWITCH_POLL_INTERVAL = "250 millis";

/**
 * Hermes may receive T3's provider-session credential only when the negotiated
 * protocol advertises its ephemeral live-session MCP lease contract. This
 * capability is intentionally absent from the legacy fallback inventory.
 */
export const HERMES_SESSION_MCP_REQUIRED_CAPABILITIES = ["session_mcp"] as const;

export interface HermesMcpIntegrationDiagnostic {
  readonly status: "ready" | "blocked_upstream";
  readonly missingCapabilities: ReadonlyArray<string>;
  readonly reason: string;
}

export function diagnoseHermesMcpIntegration(
  compatibility: HermesGatewayCompatibility,
): HermesMcpIntegrationDiagnostic {
  const missingCapabilities = HERMES_SESSION_MCP_REQUIRED_CAPABILITIES.filter(
    (capability) => !compatibility.capabilities.includes(capability),
  );
  if (compatibility.status !== "supported" || missingCapabilities.length > 0) {
    return {
      status: "blocked_upstream",
      missingCapabilities,
      reason:
        "Hermes MCP exposure is blocked: the negotiated gateway protocol does not advertise ephemeral per-session MCP leases.",
    };
  }
  return {
    status: "ready",
    missingCapabilities: [],
    reason: "Hermes advertises ephemeral per-session MCP leases with replace and revoke support.",
  };
}

export const HermesProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: true,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface HermesGatewayClientLike {
  readonly compatibility: HermesGatewayCompatibility | undefined;
  connect(): Promise<HermesGatewayCompatibility>;
  hasCapability(capability: string): boolean;
  onEvent(listener: (event: HermesGatewayOrderedEvent) => void | Promise<void>): () => void;
  createSession(
    params: HermesGatewaySessionCreateParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionCreateResult>;
  resumeSession(
    params: HermesGatewaySessionResumeParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionResumeResult>;
  replaceSessionMcp(
    params: HermesGatewaySessionMcpParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionMcpLeaseResult>;
  revokeSessionMcp(
    sessionId: string,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionMcpRevokeResult>;
  readSessionStatus(params: {
    readonly session_id: string;
    readonly profile?: string;
  }): Promise<HermesGatewaySessionStatusResult>;
  readSessionHistory(params: {
    readonly session_id: string;
    readonly profile?: string;
  }): Promise<HermesGatewaySessionHistoryResult>;
  readSessionTitle(
    params: Pick<HermesGatewaySessionTitleParams, "session_id">,
  ): Promise<HermesGatewaySessionTitleResult>;
  updateSessionTitle(
    params: HermesGatewaySessionTitleParams & { readonly title: string },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionTitleResult>;
  branchSession(
    params: HermesGatewaySessionBranchParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionBranchResult>;
  reconcileMutation(
    operationId: string,
    mutationId?: string,
  ): Promise<HermesGatewayMutationStatusResult>;
  submitPrompt(
    params: HermesGatewayPromptSubmitParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayPromptSubmitResult>;
  attachImageBytes(
    params: {
      readonly session_id: string;
      readonly content_base64: string;
      readonly filename?: string;
    },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown>;
  respondToApproval(
    params: { readonly session_id: string; readonly choice: "once" | "session" | "deny" },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayApprovalRespondResult>;
  respondToClarification(
    params: { readonly request_id: string; readonly answer: string },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayClarificationRespondResult>;
  attachFile(
    params: {
      readonly session_id: string;
      readonly name: string;
      readonly data_url: string;
    },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown>;
  attachPdf(
    params: {
      readonly session_id: string;
      readonly filename: string;
      readonly content_base64: string;
    },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown>;
  interruptSession(
    params: { readonly session_id: string },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayInterruptResult>;
  close(): void;
}

export interface HermesServeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: HermesSettings;
  readonly enabled: boolean;
  readonly authToken: string | undefined;
  readonly remotePairingToken?: string | undefined;
  readonly remoteTlsCertificateSha256?: string | undefined;
  readonly connectionRuntime?: HermesServeRuntimeShape | undefined;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly repository: HermesSessionBindingRepositoryShape;
  readonly readAttachment?: (
    attachment: ChatAttachment,
  ) => Effect.Effect<Uint8Array, ProviderAdapterProtocolError>;
  readonly resolveHistoryMedia?: (input: {
    readonly sourcePath: string;
    readonly expectedKind: HermesHistoryMediaKind;
    readonly threadId: string;
    readonly stableKey: string;
  }) => Effect.Effect<ChatAttachment | null>;
  readonly clientFactory?: (input: {
    readonly endpoint: string;
    readonly authToken: string;
  }) => HermesGatewayClientLike;
  /**
   * Sink for continuation requests raised when a gateway run streams with no
   * T3 turn attached. Defaults to dropping them so adapter construction stays
   * dependency-free in tests.
   */
  readonly continuationRequests?: {
    readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  };
}

export function resolveHermesGatewayToken(
  environment: ProviderInstanceEnvironment,
): string | undefined {
  return environment.find(
    (variable) =>
      variable.name === "HERMES_GATEWAY_TOKEN" &&
      variable.sensitive &&
      variable.value.trim().length > 0,
  )?.value;
}

export function resolveHermesRemotePairingToken(
  environment: ProviderInstanceEnvironment,
): string | undefined {
  return resolveSensitiveHermesEnvironment(environment, HERMES_REMOTE_PAIRING_TOKEN_ENV);
}

export function resolveHermesRemoteTlsCertificateSha256(
  environment: ProviderInstanceEnvironment,
): string | undefined {
  return resolveSensitiveHermesEnvironment(environment, HERMES_REMOTE_TLS_CERT_SHA256_ENV);
}

function resolveSensitiveHermesEnvironment(
  environment: ProviderInstanceEnvironment,
  name: string,
): string | undefined {
  return environment.find(
    (variable) => variable.name === name && variable.sensitive && variable.value.trim().length > 0,
  )?.value;
}

interface ActiveHermesTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly operationId: string;
  readonly completion: Deferred.Deferred<void>;
  readonly bufferedEvents: Array<HermesGatewayOrderedEvent>;
  /**
   * True for a continuation turn that attaches to a gateway run T3 never
   * submitted (a Hermes cron job, or a prompt from another client on the same
   * session). It streams the run's events like any other turn but owns no
   * prompt mutation, so it must not settle a durable mutation intent.
   */
  readonly external: boolean;
  /**
   * The gateway run an external continuation attached to. A T3 turn learns its
   * run id from the prompt submission instead, so this stays null there.
   */
  readonly sourceRunId: string | null;
  providerTurn: OrchestrationV2ProviderTurn | null;
  assistantNativeId: string | null;
  assistantText: string;
  // Set when assistantText came from a full-message snapshot (start/interim)
  // so a subsequent delta stream, which re-streams the message from its
  // beginning, replaces the snapshot instead of appending to it.
  assistantSnapshotPending: boolean;
  assistantStartedAt: DateTime.Utc | null;
  reasoningText: string;
  reasoningStartedAt: DateTime.Utc | null;
  reasoningHasStreamedDelta: boolean;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  readonly toolsByIdentity: Map<string, ActiveHermesTool>;
  readonly toolsByNativeId: Map<string, ActiveHermesTool>;
  readonly generatingToolsByName: Map<string, Array<ActiveHermesTool>>;
  readonly seenEventIds: Set<string>;
  planId: PlanId | null;
  gatewayRunId: string | null;
  /**
   * Completions to absorb before terminalizing: a steering prompt Hermes
   * admitted as "queued" runs as a follow-up gateway run on the same
   * session, so the current run's completion must not end this turn.
   */
  pendingSteerCompletions: number;
  interrupted: boolean;
  finalized: boolean;
  intentState: HermesMutationIntentState;
}

interface ActiveHermesTool {
  readonly identity: string;
  nativeToolId: string | null;
  name: string | null;
  input: unknown;
  output: unknown | undefined;
  outputRisk: unknown | undefined;
  outputRedacted: boolean;
  inlineDiff: string | null;
  /**
   * True when `input` came from the tool's actual arguments rather than a
   * context/preview display string, so category classification never
   * mistakes a progress caption for a command.
   */
  structuredInput: boolean;
  title: string | null;
  status: OrchestrationV2TurnItem["status"];
  startedAt: DateTime.Utc | null;
  completedAt: DateTime.Utc | null;
}

/**
 * Compose the projected tool output from the raw provider output plus any
 * output-risk annotation. Keeping the annotation in a dedicated field means
 * repeated `tool.output_risk` events cannot nest wrappers and a later
 * `tool.complete` cannot discard the annotation.
 */
const projectedToolOutput = (tool: ActiveHermesTool): unknown | undefined => {
  const raw = tool.outputRedacted ? "[REDACTED BY HERMES]" : tool.output;
  if (tool.outputRisk === undefined) return raw;
  return { result: raw ?? null, outputRisk: tool.outputRisk };
};

function hermesDiffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

const HERMES_TODO_COMPLETED_STATUSES = new Set(["completed", "complete", "done", "finished"]);
const HERMES_TODO_RUNNING_STATUSES = new Set([
  "in_progress",
  "in-progress",
  "inprogress",
  "active",
  "running",
  "current",
  "started",
  "doing",
]);

/**
 * Hermes todo payloads are declared as opaque entries on the wire, so the
 * parse is tolerant: strings become pending steps and records may carry the
 * step text and status under several historical key names.
 */
export function parseHermesTodoSteps(
  todos: ReadonlyArray<unknown>,
  keyPrefix: string,
): Array<OrchestrationV2PlanStep> {
  const steps: Array<OrchestrationV2PlanStep> = [];
  for (const entry of todos) {
    let text: string | null = null;
    let status: OrchestrationV2PlanStep["status"] = "pending";
    if (typeof entry === "string") {
      text = entry.trim().length > 0 ? entry.trim() : null;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const rawText = [
        record["content"],
        record["text"],
        record["title"],
        record["task"],
        record["description"],
      ].find((value) => typeof value === "string" && value.trim().length > 0);
      text = typeof rawText === "string" ? rawText.trim() : null;
      const rawStatus = [record["status"], record["state"]].find(
        (value) => typeof value === "string",
      );
      const normalized = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
      if (
        HERMES_TODO_COMPLETED_STATUSES.has(normalized) ||
        record["done"] === true ||
        record["completed"] === true
      ) {
        status = "completed";
      } else if (HERMES_TODO_RUNNING_STATUSES.has(normalized)) {
        status = "running";
      }
    }
    if (text === null) continue;
    steps.push({ id: `${keyPrefix}:${steps.length + 1}`, text, status });
  }
  return steps;
}

type HermesToolTurnItemBase = {
  readonly [K in
    | "id"
    | "threadId"
    | "runId"
    | "nodeId"
    | "providerThreadId"
    | "providerTurnId"
    | "nativeItemRef"
    | "parentItemId"
    | "ordinal"
    | "status"
    | "title"
    | "startedAt"
    | "completedAt"
    | "updatedAt"]: Exclude<OrchestrationV2TurnItem[K], undefined>;
};

/**
 * Projects a live Hermes tool onto the same native turn-item categories the
 * import path uses (terminal commands, file edits, web searches), so live
 * turns render rich cards instead of generic tool calls. Risk-annotated or
 * redacted tools keep the generic card: it is the only shape that carries the
 * full projected output with the risk annotation.
 */
function hermesLiveToolTurnItem(
  tool: ActiveHermesTool,
  base: HermesToolTurnItemBase,
): OrchestrationV2TurnItem {
  const projected = projectedToolOutput(tool);
  const classified =
    tool.structuredInput && tool.outputRisk === undefined && !tool.outputRedacted
      ? classifyHermesToolCall(tool.name, tool.input)
      : ({ kind: "dynamic_tool" } as const);
  if (classified.kind === "command_execution") {
    const record =
      typeof projected === "object" && projected !== null && !Array.isArray(projected)
        ? (projected as Record<string, unknown>)
        : null;
    const outputText =
      typeof projected === "string"
        ? projected
        : record !== null && typeof record["output"] === "string"
          ? record["output"]
          : undefined;
    const exitCode =
      record !== null &&
      typeof record["exit_code"] === "number" &&
      Number.isInteger(record["exit_code"])
        ? record["exit_code"]
        : undefined;
    return {
      ...base,
      type: "command_execution",
      input: classified.command,
      ...(outputText === undefined ? {} : { output: outputText }),
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }
  if (classified.kind === "file_change") {
    const diff = tool.inlineDiff;
    const counts = diff === null ? null : hermesDiffLineCounts(diff);
    return {
      ...base,
      type: "file_change",
      fileName: classified.fileName,
      ...(diff === null ? {} : { diffStr: diff }),
      ...(counts === null ? {} : { additions: counts.additions, deletions: counts.deletions }),
    };
  }
  if (classified.kind === "web_search") {
    return {
      ...base,
      type: "web_search",
      patterns: classified.pattern === null ? [] : [classified.pattern],
    };
  }
  return {
    ...base,
    type: "dynamic_tool",
    toolName: tool.name,
    input: tool.input,
    ...(projected === undefined ? {} : { output: projected }),
  };
}

interface HermesThreadState {
  readonly binding: HermesSessionBinding;
  readonly liveSessionId: string;
  lease: HermesOwnerLease;
  titleRevision: number;
  title: string | null;
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActiveHermesTurn | null;
  externalRunActive: boolean;
  /**
   * Events from a gateway run with no T3 turn attached. They are held until a
   * continuation turn opens to drain them, which is what makes Hermes-native
   * proactive work (cron jobs, other clients on the same session) land in the
   * T3 transcript instead of being dropped.
   */
  readonly externalEvents: Array<HermesGatewayOrderedEvent>;
  externalContinuationRequested: boolean;
  externalRunId: string | null;
  /**
   * The gateway run of the turn that most recently terminalized. Hermes can
   * emit trailing artifacts after a run settles; without this, they would be
   * mistaken for new external work and open an empty continuation turn.
   */
  settledRunId: string | null;
  ownershipLost: boolean;
  readonly turns: Map<string, OrchestrationV2ProviderTurn>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  readonly importedTurnItems: Map<string, OrchestrationV2TurnItem>;
  readonly runtimeRequests: Map<string, OrchestrationV2RuntimeRequest>;
}

interface PendingHermesRuntimeRequest {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly state: HermesThreadState;
  readonly active: ActiveHermesTurn;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly nativeIdentity: string;
  readonly kind: "approval" | "clarification";
  readonly prompt: string;
  readonly questionId?: string;
  readonly choices?: ReadonlyArray<string>;
  readonly nativeRequestId?: string;
}

type HermesMutationFence = Pick<HermesThreadState, "binding" | "lease">;

/**
 * A resume prepares its mutation before any session exists, so the fence it
 * carries is not yet a bound thread. Only a bound one can ask the gateway about
 * a session.
 */
const isBoundThreadState = (state: HermesMutationFence): state is HermesThreadState =>
  "liveSessionId" in state;

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const stableDigest = (...parts: ReadonlyArray<unknown>): string => sha256(JSON.stringify(parts));
export const hermesWireMutationId = (operationId: string): string => `t3_${sha256(operationId)}`;

const providerRef = (
  nativeId: string,
  strength: OrchestrationV2ProviderRef["strength"] = "strong",
): OrchestrationV2ProviderRef => ({
  driver: HERMES_PROVIDER,
  nativeId,
  strength,
});

class HermesGatewayCallError extends Schema.TaggedErrorClass<HermesGatewayCallError>()(
  "HermesGatewayCallError",
  {
    cause: Schema.Defect(),
  },
) {}
const isHermesGatewayCallError = Schema.is(HermesGatewayCallError);

/**
 * The Hermes gateway no longer stores the durable session behind an imported
 * binding (session.resume error 4007). The imported transcript that T3
 * projected at import time remains readable; only live resumption is gone.
 */
export class HermesImportedSessionUnavailableError extends Schema.TaggedErrorClass<HermesImportedSessionUnavailableError>()(
  "HermesImportedSessionUnavailableError",
  {
    storedSessionKey: Schema.String,
    profileKey: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Hermes no longer stores session ${this.storedSessionKey} in profile ${this.profileKey} (session.resume reported 4007: session not found). The imported conversation stays available read-only in T3.`;
  }
}

const HERMES_SESSION_NOT_FOUND_CODE = 4007;

const isStoredSessionNotFound = (cause: unknown): boolean =>
  isHermesGatewayCallError(cause) &&
  cause.cause instanceof HermesGatewayRpcError &&
  cause.cause.method === "session.resume" &&
  cause.cause.code === HERMES_SESSION_NOT_FOUND_CODE;
const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapterRuntimeRequestResponseError,
);

/**
 * Continuation turns are dispatched by ProviderContinuationService for an
 * adapter-buffered wake: the run already exists gateway-side, so the turn
 * drains the adapter's buffered events instead of submitting the dispatched
 * text as a new prompt.
 */
function isHermesProviderContinuationTurn(input: ProviderAdapterV2TurnInput): boolean {
  return input.message.createdBy === "agent" && input.message.creationSource === "provider";
}

/** Message text for the continuation turn that carries an external Hermes run. */
export const HERMES_EXTERNAL_RUN_CONTINUATION_DETAIL = "Hermes ran this session outside T3.";

/**
 * Ceiling on events held for a continuation that never attaches (a thread the
 * orchestrator refuses to wake). Dropping the tail keeps a long-running
 * external session from growing the buffer without bound; the turn still shows
 * everything up to the limit.
 */
export const HERMES_EXTERNAL_EVENT_BUFFER_LIMIT = 5000;

/**
 * Event families that carry transcript content. Everything else (title,
 * session info, bare status) only moves session state, so buffering it would
 * open a continuation turn with nothing to show.
 */
const HERMES_EXTERNAL_CONTENT_EVENT_TYPES = new Set([
  "message.start",
  "message.delta",
  "message.interim",
  "message.complete",
  "thinking.delta",
  "reasoning.delta",
  "reasoning.available",
  "tool.generating",
  "tool.progress",
  "tool.start",
  "tool.complete",
  "tool.output_risk",
  "approval.request",
  "clarify.request",
]);

/**
 * The two events that park a Hermes run on an answer from T3. They are the only
 * events whose loss strands the gateway rather than the transcript, so they are
 * exempt from buffer trimming and worth logging when nothing can carry them.
 */
const HERMES_RUNTIME_REQUEST_EVENT_TYPES = new Set(["approval.request", "clarify.request"]);

/**
 * Answering a Hermes approval or clarification is a Tier 2 capability the
 * gateway has to advertise. Pushing the request events is not the same as
 * accepting a response to them: a gateway that never negotiated these still
 * emits `approval.request`, and `approval.respond` then has no method to reach.
 */
export const HERMES_RUNTIME_REQUEST_RESPONSE_CAPABILITIES = {
  approval: "events.approvals",
  clarification: "events.clarification",
} as const;

export function hermesUnanswerableRuntimeRequestReason(kind: "approval" | "clarification"): string {
  const capability = HERMES_RUNTIME_REQUEST_RESPONSE_CAPABILITIES[kind];
  const asked = kind === "approval" ? "a command approval" : "an answer";
  const answer = kind === "approval" ? "a decision" : "an answer";
  return `Hermes asked for ${asked}, but this gateway does not advertise "${capability}", so T3 has no way to send ${answer} back to it. The turn was stopped instead of waiting on a response that could never be delivered.`;
}

const gatewayEffect = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new HermesGatewayCallError({ cause }),
  });

const isIndeterminateGatewayCall = (cause: unknown): boolean =>
  isHermesGatewayCallError(cause) && cause.cause instanceof HermesGatewayMutationIndeterminateError;

const decodeTitleChanged = Schema.decodeUnknownSync(HermesGatewayTitleChangedEventPayload);

export function hermesModelOverride(model: string): { readonly model?: string } {
  return model === "default" ? {} : { model };
}

export function hermesReasoningOverride(
  modelSelection: ProviderAdapterV2EnsureThreadInput["modelSelection"],
): { readonly reasoning_effort?: string } {
  const effort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  return effort === undefined ? {} : { reasoning_effort: effort };
}

export function hermesFastOverride(
  modelSelection: ProviderAdapterV2EnsureThreadInput["modelSelection"],
): { readonly fast?: boolean } {
  const fast = getModelSelectionStringOptionValue(modelSelection, "fast");
  return fast === undefined ? {} : { fast: fast === "fast" };
}

/**
 * Hermes gates its own dangerous commands and has no protocol knob to relax
 * that per session, so the thread's permission mode is enforced here: under
 * Full access T3 answers `approval.request` itself instead of stopping the run
 * on a prompt the user already said they did not want. Every other mode -
 * including Auto, which Hermes has no reviewer to delegate to - keeps asking.
 */
export function hermesAutoApprovesCommands(runtimePolicy: ProviderAdapterV2RuntimePolicy): boolean {
  return runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode === "full-access"
    : runtimePolicy.approvalPolicy === "never";
}

export function hermesApprovalChoice(
  decision: ProviderApprovalDecision,
): "once" | "session" | "deny" {
  if (decision === "accept") return "once";
  if (decision === "acceptForSession") return "session";
  return "deny";
}

export function hermesClarificationAnswer(
  answers: ProviderUserInputAnswers,
  questionId: string,
): string | undefined {
  const value = answers[questionId] ?? Object.values(answers)[0];
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const values = value.filter((entry): entry is string => typeof entry === "string");
    return values.length === 0 ? undefined : values.join(", ");
  }
  return undefined;
}

function compatibilityFields(compatibility: HermesGatewayCompatibility) {
  return {
    protocolClassification: compatibility.status,
    protocolMajor: compatibility.protocol?.major ?? null,
    protocolMinor: compatibility.protocol?.minor ?? null,
    capabilities: compatibility.capabilities,
  } as const;
}

function leaseTimes() {
  const nowValue = DateTime.nowUnsafe();
  return {
    now: DateTime.formatIso(nowValue),
    expiresAt: DateTime.formatIso(DateTime.add(nowValue, { minutes: LEASE_MINUTES })),
  };
}

function eventText(event: HermesGatewayOrderedEvent): string {
  const payload = event.frame.params.payload;
  if (typeof payload !== "object" || payload === null) return "";
  const text = (payload as { readonly text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function eventStatus(event: HermesGatewayOrderedEvent): string | undefined {
  const payload = event.frame.params.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const status = (payload as { readonly status?: unknown }).status;
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

function eventMessageId(event: HermesGatewayOrderedEvent): string | undefined {
  if (event.messageId) return event.messageId;
  const payload = event.frame.params.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const messageId = (payload as { readonly message_id?: unknown }).message_id;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
}

function eventToolPayload(event: HermesGatewayOrderedEvent): HermesGatewayToolEventPayload {
  const payload = event.frame.params.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as HermesGatewayToolEventPayload)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function hermesAttachmentRefText(result: unknown): string | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const row = result as Readonly<Record<string, unknown>>;
  return nonEmptyString(row.ref_text) ?? nonEmptyString(row.refText) ?? null;
}

function sensitiveToolKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return (
    normalized.endsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("accesskey") ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "token"
  );
}

function redactToolString(value: string): string {
  return value
    .replace(
      /\b(Bearer|Basic|Digest|Negotiate|NTLM|AWS4-HMAC-SHA256)\s+[A-Za-z0-9._~+/=,-]+/giu,
      "$1 [REDACTED]",
    )
    .replace(
      /([?&](?:access_token|refresh_token|id_token|client_secret|client_assertion|api_key|apikey|password|secret|token)=)[^&#\s]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|client[_-]?assertion|password|secret|token)\s*[=:]\s*)([^\s,;]+)/giu,
      "$1[REDACTED]",
    );
}

/**
 * Hermes complete events contain the raw tool arguments/result even when the
 * optional verbose text is already redacted. Bound and redact those values
 * before they enter durable orchestration projections.
 */
export function sanitizeHermesToolValue(
  value: unknown,
  options: { readonly maxChars?: number } = {},
): unknown {
  const maxChars = options.maxChars ?? 40_000;
  let remaining = maxChars;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (remaining <= 0) return "[TRUNCATED]";
    if (typeof current === "string") {
      const redacted = redactToolString(current);
      const limit = Math.min(remaining, 16_000);
      remaining -= Math.min(redacted.length, limit);
      return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}… [TRUNCATED]`;
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      remaining -= 8;
      return current;
    }
    if (current === undefined) return undefined;
    if (depth >= 8) return "[MAX_DEPTH]";
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) {
      const values: Array<unknown> = [];
      for (const entry of current.slice(0, 100)) {
        if (remaining <= 0) {
          values.push("[TRUNCATED]");
          break;
        }
        values.push(visit(entry, depth + 1));
      }
      if (current.length > values.length) values.push(`[${current.length - values.length} MORE]`);
      return values;
    }
    const entries = Object.entries(current).slice(0, 100);
    const result: Record<string, unknown> = {};
    let visited = 0;
    for (const [key, nested] of entries) {
      if (remaining <= 0) break;
      const boundedKey =
        key.length <= 256 ? key : `${key.slice(0, 256)}… [TRUNCATED ${key.length - 256} CHARS]`;
      remaining -= boundedKey.length;
      result[boundedKey] = sensitiveToolKey(key) ? "[REDACTED]" : visit(nested, depth + 1);
      visited += 1;
    }
    const omittedKeys = Object.keys(current).length - visited;
    if (omittedKeys > 0) {
      result["[TRUNCATED_KEYS]"] = omittedKeys;
    }
    return result;
  };
  return visit(value, 0);
}

function toolTerminalStatus(
  payload: HermesGatewayToolEventPayload,
): OrchestrationV2TurnItem["status"] {
  const explicit = nonEmptyString(payload.status)?.toLowerCase();
  if (explicit?.includes("interrupt")) return "interrupted";
  if (explicit?.includes("cancel")) return "cancelled";
  if (explicit?.includes("fail") || explicit?.includes("error")) return "failed";
  const result =
    typeof payload.result === "object" && payload.result !== null
      ? (payload.result as Record<string, unknown>)
      : undefined;
  if (
    result?.success === false ||
    result?.ok === false ||
    (typeof result?.exit_code === "number" && result.exit_code !== 0) ||
    (typeof result?.returncode === "number" && result.returncode !== 0)
  ) {
    return "failed";
  }
  if (typeof payload.result === "string") {
    const normalized = payload.result.trim();
    if (
      /^Error executing tool\b/iu.test(normalized) ||
      /^Tool execution failed\b/iu.test(normalized) ||
      /\[Command timed out after \d+s\]\s*$/iu.test(normalized)
    ) {
      return "failed";
    }
  }
  return "completed";
}

function hasRecoveredWork(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function isActiveHermesStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return ["active", "running", "streaming", "queued", "inflight", "busy"].some((value) =>
    normalized.includes(value),
  );
}

function isTerminalHermesStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return ["idle", "complete", "completed", "interrupted", "error", "failed"].some((value) =>
    normalized.includes(value),
  );
}

export function hermesSessionRuntimeStatus(status: HermesGatewaySessionStatusResult): string {
  const runningLine = /^Agent Running:\s*(Yes|No)\s*$/imu.exec(status.output);
  if (runningLine?.[1]?.toLowerCase() === "yes") return "running";
  if (runningLine?.[1]?.toLowerCase() === "no") return "idle";
  return status.output;
}

function historyRole(
  role: HermesGatewayHistoryMessage["role"],
): OrchestrationV2ConversationMessage["role"] {
  if (role === "user" || role === "assistant" || role === "system") return role;
  return "system";
}

export function makeHermesServeAdapterV2(
  options: HermesServeAdapterV2Options,
): ProviderAdapterV2Shape {
  const configuredCapabilities: OrchestrationV2ProviderCapabilities = {
    ...HermesProviderCapabilitiesV2,
    tools: {
      ...HermesProviderCapabilitiesV2.tools,
      supportsMcpTools: options.settings.mcpEnabled,
    },
  };
  const continuationRequests = options.continuationRequests ?? { offer: () => Effect.void };
  const makeClient =
    options.clientFactory ??
    ((input) =>
      new HermesGatewayClient({
        endpoint: input.endpoint,
        authToken: input.authToken,
        criticalCapabilities: [
          "session.lifecycle",
          "session.history",
          "turn.prompt",
          "turn.interrupt",
          "events.tools",
        ],
      }));

  return {
    instanceId: options.instanceId,
    driver: HERMES_PROVIDER,
    getCapabilities: () => Effect.succeed(configuredCapabilities),
    planSelectionTransition: () =>
      // Model changes are applied when the next turn starts, through Hermes'
      // `/model` command channel.
      Effect.succeed({ type: "apply_on_next_turn" } as const),
    openSession: Effect.fn("HermesServeAdapterV2.openSession")(function* (
      input: ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.enabled) {
        return yield* new ProviderAdapterOpenSessionError({
          driver: HERMES_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause: new Error("Hermes requires both enableHermes and an enabled provider instance."),
        });
      }
      if (!options.settings.profileKey.trim()) {
        return yield* new ProviderAdapterOpenSessionError({
          driver: HERMES_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause: new Error("Hermes profileKey must be configured."),
        });
      }
      let endpoint = resolveHermesServeEndpoint(options.settings.endpoint);
      let authToken = options.authToken;
      if (options.connectionRuntime !== undefined) {
        const resolved = yield* options.connectionRuntime.ensureReady.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: HERMES_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
        endpoint = resolved.endpoint;
        authToken = resolved.authToken;
      }
      const connectionSecurity = assessHermesConnectionSecurity({
        endpoint,
        gatewayToken: authToken,
        remoteGloballyEnabled: options.enabled,
        remoteInstanceEnabled: options.settings.remoteAccessEnabled,
        remotePairingToken: options.remotePairingToken,
        remoteTlsCertificateSha256: options.remoteTlsCertificateSha256,
      });
      if (connectionSecurity.status !== "ready") {
        return yield* new ProviderAdapterOpenSessionError({
          driver: HERMES_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause: new Error(connectionSecurity.message),
        });
      }

      const client = makeClient({
        endpoint: connectionSecurity.endpoint,
        authToken: connectionSecurity.authToken,
      });
      const compatibility = yield* gatewayEffect(() => client.connect()).pipe(
        Effect.tapError(() => Effect.sync(() => client.close())),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterOpenSessionError({
              driver: HERMES_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      const mcpDiagnostic = diagnoseHermesMcpIntegration(compatibility);
      const mcpAvailable = options.settings.mcpEnabled && mcpDiagnostic.status === "ready";
      // Derived per connection rather than declared: the same adapter talks to
      // gateways that accept approval responses and to ones that only push the
      // requests, and only the negotiated inventory tells the two apart.
      const canRespondToRuntimeRequest = {
        approval: compatibility.capabilities.includes(
          HERMES_RUNTIME_REQUEST_RESPONSE_CAPABILITIES.approval,
        ),
        clarification: compatibility.capabilities.includes(
          HERMES_RUNTIME_REQUEST_RESPONSE_CAPABILITIES.clarification,
        ),
      } as const;
      if (!canRespondToRuntimeRequest.approval || !canRespondToRuntimeRequest.clarification) {
        yield* Effect.logWarning("hermes.runtime-request-responses-unavailable", {
          providerSessionId: input.providerSessionId,
          providerInstanceId: options.instanceId,
          canRespondToApprovals: canRespondToRuntimeRequest.approval,
          canRespondToClarifications: canRespondToRuntimeRequest.clarification,
        });
      }
      if (options.settings.mcpEnabled && !mcpAvailable) {
        yield* Effect.logWarning("hermes.mcp-integration-blocked", {
          providerSessionId: input.providerSessionId,
          providerInstanceId: options.instanceId,
          status: mcpDiagnostic.status,
          missingCapabilities: mcpDiagnostic.missingCapabilities,
          reason: mcpDiagnostic.reason,
        });
      }
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const runtimeContext = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(runtimeContext);
      const statesByProviderThread = new Map<string, HermesThreadState>();
      const statesByLiveSession = new Map<string, HermesThreadState>();
      const mcpCredentialByLiveSession = new Map<string, string>();
      const pendingRuntimeRequests = new Map<string, PendingHermesRuntimeRequest>();
      const stateForProviderThread = (
        providerThread: OrchestrationV2ProviderThread,
      ): HermesThreadState | undefined => {
        const exact = statesByProviderThread.get(String(providerThread.id));
        if (exact !== undefined) return exact;
        const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
        if (nativeThreadId === undefined) return undefined;
        return [...statesByProviderThread.values()].find(
          (candidate) => candidate.providerThread.nativeThreadRef?.nativeId === nativeThreadId,
        );
      };
      const alignStateProviderThread = (
        state: HermesThreadState,
        projectedThread: OrchestrationV2ProviderThread,
      ): OrchestrationV2ProviderThread => {
        const previousId = String(state.providerThread.id);
        state.providerThread = {
          ...state.providerThread,
          id: projectedThread.id,
          providerSessionId: projectedThread.providerSessionId,
          appThreadId: projectedThread.appThreadId,
          ownerNodeId: projectedThread.ownerNodeId,
          firstRunOrdinal: projectedThread.firstRunOrdinal ?? state.providerThread.firstRunOrdinal,
          lastRunOrdinal: projectedThread.lastRunOrdinal ?? state.providerThread.lastRunOrdinal,
          handoffIds: projectedThread.handoffIds,
          forkedFrom: projectedThread.forkedFrom,
        };
        if (previousId !== String(projectedThread.id)) {
          statesByProviderThread.delete(previousId);
        }
        statesByProviderThread.set(String(projectedThread.id), state);
        return state.providerThread;
      };
      const providerCapabilities: OrchestrationV2ProviderCapabilities = {
        ...HermesProviderCapabilitiesV2,
        tools: {
          ...HermesProviderCapabilitiesV2.tools,
          supportsMcpTools: mcpAvailable,
        },
        approvals: {
          ...HermesProviderCapabilitiesV2.approvals,
          supportsCommandApproval: canRespondToRuntimeRequest.approval,
        },
        planning: {
          ...HermesProviderCapabilitiesV2.planning,
          supportsStructuredQuestions: canRespondToRuntimeRequest.clarification,
        },
      };
      let providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: HERMES_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready" as const,
        cwd: input.runtimePolicy.cwd ?? process.cwd(),
        model: input.modelSelection.model,
        capabilities: providerCapabilities,
        createdAt: yield* DateTime.now,
        updatedAt: yield* DateTime.now,
        lastError: null,
      };

      const emit = (event: ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const reconcileTitle = Effect.fnUntraced(function* (
        state: HermesThreadState,
        titleState: HermesGatewaySessionTitleResult,
      ) {
        const title = titleState.title?.trim();
        const origin = titleState.origin.trim();
        if (!title || !origin) return;
        if (titleState.revision <= state.titleRevision) {
          if (titleState.revision === state.titleRevision) state.title = title;
          return;
        }
        const { now } = leaseTimes();
        const updated = yield* options.repository.updateTitleState({
          bindingId: state.binding.bindingId,
          ownerKey: state.lease.ownerKey,
          generation: state.lease.generation,
          now,
          revision: titleState.revision,
          origin,
        });
        if (!updated) return;
        state.titleRevision = titleState.revision;
        state.title = title;
        yield* emit({
          type: "app_thread.title_reconciled",
          driver: HERMES_PROVIDER,
          threadId: state.providerThread.appThreadId ?? input.threadId,
          title,
          revision: titleState.revision,
          origin,
        });
      });
      const updateSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = providerSession.lastError,
      ) =>
        Effect.gen(function* () {
          providerSession = {
            ...providerSession,
            status,
            lastError,
            updatedAt: yield* DateTime.now,
          };
          yield* emit({
            type: "provider_session.updated",
            driver: HERMES_PROVIDER,
            providerSession,
          });
        });

      const updateThread = (
        state: HermesThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
      ) =>
        Effect.gen(function* () {
          state.providerThread = {
            ...state.providerThread,
            ...patch,
            updatedAt: yield* DateTime.now,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: HERMES_PROVIDER,
            providerThread: state.providerThread,
          });
        });

      const transitionIntent = (
        state: HermesMutationFence,
        operationId: string,
        from: HermesMutationIntentState,
        to: HermesMutationIntentState,
      ) => {
        const { now } = leaseTimes();
        return options.repository
          .transitionMutationIntent({
            bindingId: state.binding.bindingId,
            ownerKey: state.lease.ownerKey,
            generation: state.lease.generation,
            now,
            operationId,
            from,
            to,
          })
          .pipe(
            Effect.flatMap((changed) =>
              changed
                ? Effect.void
                : new ProviderAdapterProtocolError({
                    driver: HERMES_PROVIDER,
                    detail: `Hermes mutation intent ${operationId} lost its lease fence`,
                  }),
            ),
          );
      };

      const reconcileIntent = Effect.fnUntraced(function* (
        intent: HermesMutationIntent,
        expected: {
          readonly bindingId: string | null;
          readonly mutationKind: string;
          readonly method: string;
          readonly payloadDigest: string;
        },
      ) {
        if (
          intent.bindingId !== expected.bindingId ||
          intent.mutationKind !== expected.mutationKind ||
          intent.method !== expected.method ||
          intent.payloadDigest !== expected.payloadDigest
        ) {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: `Hermes mutation ${intent.operationId} conflicts with its durable intent`,
          });
        }
        if (
          intent.state === "confirmed" ||
          intent.state === "reconciled" ||
          intent.state === "rejected"
        ) {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: `Hermes mutation ${intent.operationId} is already terminal (${intent.state})`,
          });
        }
        if (!client.hasCapability("mutation.stable_ids")) {
          return { mutation_status: "admitted" } as const;
        }
        return yield* gatewayEffect(() =>
          client.reconcileMutation(intent.operationId, hermesWireMutationId(intent.operationId)),
        );
      });

      /**
       * Retakes the binding's owner lease when the in-memory fence has gone
       * stale. Renewal cannot revive a lapsed lease, and the generation this
       * state remembers is stale as soon as anyone else acquires, so retry once
       * against the generation the row actually carries. The compare-and-swap
       * still refuses a lease another owner holds and has not let expire, so
       * this widens recovery without ever stealing live ownership.
       */
      const retakeLease = Effect.fnUntraced(function* (state: HermesMutationFence) {
        const { now, expiresAt } = leaseTimes();
        const reacquired = yield* options.repository.acquireOwnerLease({
          bindingId: state.binding.bindingId,
          ownerKey: state.lease.ownerKey,
          expectedGeneration: state.lease.generation,
          now,
          expiresAt,
        });
        if (Option.isSome(reacquired)) {
          state.lease = reacquired.value;
          return true;
        }
        const current = yield* options.repository.getByThreadId(String(state.binding.threadId));
        if (Option.isNone(current) || current.value.bindingId !== state.binding.bindingId) {
          return false;
        }
        const retaken = yield* options.repository.acquireOwnerLease({
          bindingId: state.binding.bindingId,
          ownerKey: state.lease.ownerKey,
          expectedGeneration: current.value.leaseGeneration,
          now,
          expiresAt,
        });
        if (Option.isNone(retaken)) return false;
        state.lease = retaken.value;
        return true;
      });

      /**
       * Settles a prompt intent that no live turn owns any more.
       *
       * A prompt intent is admitted before the gateway call and settled by
       * `finalizeTurn`, which only ever runs in the process that opened the
       * turn. A crash, a restart, or a session torn down mid-run therefore
       * leaves the intent unsettled forever, and the durable one-unsettled-
       * prompt guard then rejects every later prompt on the binding — one lost
       * process bricking the thread permanently. Nothing else can clear it:
       * `reconcileIntent` is only reachable when the *same* operation id is
       * retried, which a new run never produces.
       *
       * Clearing it is only safe once the gateway agrees the prompt is over,
       * so ask before settling and leave the guard standing when the answer is
       * "still running" — that case is real backpressure, not a leak.
       */
      const settleStrandedPromptIntent = Effect.fnUntraced(function* (
        state: HermesThreadState,
        operationId: string,
      ) {
        for (const candidate of statesByProviderThread.values()) {
          const active = candidate.activeTurn;
          if (active !== null && !active.finalized && active.operationId === operationId) {
            return false;
          }
        }
        const intent = yield* options.repository.getMutationIntent(operationId);
        if (Option.isNone(intent)) return true;
        const stranded = intent.value;
        if (
          stranded.state === "confirmed" ||
          stranded.state === "reconciled" ||
          stranded.state === "rejected"
        ) {
          return true;
        }
        const settle = Effect.fnUntraced(function* () {
          // `admitted` may only reach a terminal state through `indeterminate`:
          // the outcome of a prompt whose owner died is exactly that, unknown.
          if (stranded.state === "admitted") {
            yield* transitionIntent(state, operationId, "admitted", "indeterminate");
          }
          yield* transitionIntent(
            state,
            operationId,
            stranded.state === "prepared" ? "prepared" : "indeterminate",
            "reconciled",
          );
          yield* Effect.logWarning("orchestration-v2.hermes-stranded-prompt-settled", {
            bindingId: state.binding.bindingId,
            providerThreadId: String(state.providerThread.id),
            operationId,
            from: stranded.state,
          });
          return true;
        });
        if (client.hasCapability("mutation.stable_ids")) {
          const outcome = yield* gatewayEffect(() =>
            client.reconcileMutation(operationId, hermesWireMutationId(operationId)),
          ).pipe(Effect.option);
          // A gateway that knows the mutation and still cannot say what became
          // of it is the one case the guard exists for. Keep it: the write may
          // yet be admitted, and a prompt behind it could double.
          if (Option.isSome(outcome) && outcome.value.mutation_status === "indeterminate") {
            return false;
          }
          if (Option.isSome(outcome) && outcome.value.mutation_status === "completed") {
            return yield* settle();
          }
          // Otherwise the gateway either took the prompt without reporting its
          // run ("admitted"), or no longer recalls a mutation this old. Both
          // leave the session's own state as the authority.
        }
        const status = yield* gatewayEffect(() =>
          client.readSessionStatus({
            session_id: state.liveSessionId,
            profile: state.binding.profileKey,
          }),
        );
        if (isActiveHermesStatus(hermesSessionRuntimeStatus(status))) return false;
        return yield* settle();
      });

      /**
       * Clears prompt intents left behind by a previous process. Runs on the
       * bind that follows a restart, where the authoritative session status is
       * already known, so a thread is repaired before its owner ever prompts.
       */
      const sweepStrandedPromptIntents = Effect.fnUntraced(function* (state: HermesThreadState) {
        const unsettled = yield* options.repository.listUnsettledMutationIntents(
          state.binding.bindingId,
        );
        for (const intent of unsettled) {
          if (intent.mutationKind !== "prompt") continue;
          yield* settleStrandedPromptIntent(state, intent.operationId);
        }
      });

      const prepareBoundMutation = Effect.fnUntraced(function* (
        state: HermesMutationFence,
        input: {
          readonly operationId: string;
          readonly mutationKind: string;
          readonly method: string;
          readonly payloadDigest: string;
        },
      ) {
        const { now, expiresAt } = leaseTimes();
        const renewed = yield* options.repository.renewOwnerLease({
          bindingId: state.binding.bindingId,
          ownerKey: state.lease.ownerKey,
          generation: state.lease.generation,
          now,
          expiresAt,
        });
        if (!renewed) {
          // A thread that sat idle past the lease window still belongs to this
          // owner, and renewal cannot revive a lapsed lease. Retake it so the
          // lapse costs one prompt at most instead of stranding every later
          // prompt on the thread. A competing owner still holding a live lease
          // keeps it.
          if (!(yield* retakeLease(state))) {
            return yield* new ProviderAdapterProtocolError({
              driver: HERMES_PROVIDER,
              detail: "Hermes owner lease is no longer held",
            });
          }
        }
        const prepare = () =>
          options.repository.prepareMutationIntent({
            ...input,
            bindingId: state.binding.bindingId,
            ownerKey: state.lease.ownerKey,
            generation: state.lease.generation,
            now,
          });
        let result = yield* prepare();
        if (result.status === "unsettled_prompt" && isBoundThreadState(state)) {
          // The blocker outlived the turn that admitted it. Settle it against
          // the gateway and prepare again rather than failing this prompt and
          // every prompt after it.
          if (yield* settleStrandedPromptIntent(state, result.operationId)) {
            result = yield* prepare();
          }
        }
        if (result.status === "prepared") {
          yield* transitionIntent(state, input.operationId, "prepared", "admitted");
          return {
            replay: false,
            intentState: "admitted" as HermesMutationIntentState,
          };
        }
        if (result.status === "operation_exists") {
          const outcome = yield* reconcileIntent(result.intent, {
            bindingId: state.binding.bindingId,
            mutationKind: input.mutationKind,
            method: input.method,
            payloadDigest: input.payloadDigest,
          });
          if (outcome.mutation_status === "indeterminate") {
            if (result.intent.state === "prepared" || result.intent.state === "admitted") {
              yield* transitionIntent(
                state,
                input.operationId,
                result.intent.state,
                "indeterminate",
              );
            }
            return yield* new ProviderAdapterProtocolError({
              driver: HERMES_PROVIDER,
              detail: `Hermes mutation ${input.operationId} remains indeterminate`,
            });
          }
          return {
            replay: true,
            intentState: result.intent.state,
          };
        }
        {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail:
              result.status === "unsettled_prompt"
                ? "Hermes is still running an earlier prompt on this session, so it cannot accept another one. Stop the running turn, or wait for it to finish, then try again"
                : `Hermes mutation ${input.operationId} cannot be safely resubmitted (${result.status})`,
          });
        }
      });

      const mutationOptions = (operationId: string) => ({
        operationId,
        ...(client.hasCapability("mutation.stable_ids")
          ? { mutationId: hermesWireMutationId(operationId) }
          : {}),
      });

      const settleMutation = <A>(
        state: HermesMutationFence,
        operationId: string,
        operation: () => Promise<A>,
      ) =>
        gatewayEffect(operation).pipe(
          Effect.tap(() => transitionIntent(state, operationId, "admitted", "confirmed")),
          Effect.tapError((cause) =>
            transitionIntent(
              state,
              operationId,
              "admitted",
              isIndeterminateGatewayCall(cause) ? "indeterminate" : "rejected",
            ).pipe(Effect.ignore),
          ),
        );

      /**
       * Stops a gateway run T3 is walking away from. Hermes parks a run on an
       * unanswered approval or clarification indefinitely, so abandoning our
       * side of one without this leaves the session blocked on a decision that
       * nobody is left to make. Best effort by design: this runs while a turn is
       * being torn down or the session released, and a gateway that already
       * moved on is exactly the outcome we wanted.
       */
      const unblockGatewayRun = Effect.fnUntraced(function* (
        state: HermesThreadState,
        operationId: string,
      ) {
        yield* gatewayEffect(() =>
          client.interruptSession(
            { session_id: state.liveSessionId },
            mutationOptions(operationId),
          ),
        ).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("orchestration-v2.hermes-unblock-run-failed", {
              providerThreadId: state.providerThread.id,
              liveSessionId: state.liveSessionId,
              cause,
            }),
          ),
          Effect.ignore,
        );
      });

      const resolveItemOrdinal = (active: ActiveHermesTurn, identity: string): number => {
        const existing = active.itemOrdinals.get(identity);
        if (existing !== undefined) return existing;
        const ordinal = active.nextItemOrdinal++;
        active.itemOrdinals.set(identity, ordinal);
        return ordinal;
      };

      const toolArtifacts = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
        tool: ActiveHermesTool,
      ) {
        const turn = active.providerTurn;
        if (turn === null) return;
        const now = yield* DateTime.now;
        const nativeItemRef =
          tool.nativeToolId === null
            ? providerRef(tool.identity, "weak")
            : providerRef(tool.nativeToolId);
        const nodeId = options.idAllocator.derive.nodeFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId: tool.identity,
        });
        const turnItemId = options.idAllocator.derive.turnItemFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId: tool.identity,
        });
        const nodeStatus: OrchestrationV2ExecutionNode["status"] =
          tool.status === "pending" ||
          tool.status === "running" ||
          tool.status === "waiting" ||
          tool.status === "completed" ||
          tool.status === "interrupted" ||
          tool.status === "failed" ||
          tool.status === "cancelled"
            ? tool.status
            : "running";
        yield* emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: {
            id: nodeId,
            threadId: active.input.threadId,
            runId: active.input.runId,
            parentNodeId: active.input.rootNodeId,
            rootNodeId: active.input.rootNodeId,
            kind: "tool_call",
            status: nodeStatus,
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.id,
            nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: tool.startedAt,
            completedAt: tool.completedAt,
          },
        });
        const turnItem = hermesLiveToolTurnItem(tool, {
          id: turnItemId,
          threadId: active.input.threadId,
          runId: active.input.runId,
          nodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.id,
          nativeItemRef,
          parentItemId: null,
          ordinal: resolveItemOrdinal(active, tool.identity),
          status: tool.status,
          title: tool.title,
          startedAt: tool.startedAt,
          completedAt: tool.completedAt,
          updatedAt: now,
        });
        yield* emit({ type: "turn_item.updated", driver: HERMES_PROVIDER, turnItem });
      });

      const todoArtifacts = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
        todos: ReadonlyArray<unknown>,
      ) {
        const turn = active.providerTurn;
        if (turn === null) return;
        // One todo list per T3 turn: repeated todo payloads update the same
        // item in place, mirroring the other todo-emitting adapters.
        const nativeItemId = `hermes-todo:${active.operationId}`;
        const steps = parseHermesTodoSteps(todos, nativeItemId);
        if (steps.length === 0) return;
        const now = yield* DateTime.now;
        if (active.planId === null) {
          active.planId = yield* options.idAllocator.allocate.plan({
            threadId: active.input.threadId,
            ...(active.input.runId === null ? {} : { runId: active.input.runId }),
            driver: HERMES_PROVIDER,
          });
        }
        const planId = active.planId;
        const nodeId = options.idAllocator.derive.nodeFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId,
        });
        const turnItemId = options.idAllocator.derive.turnItemFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId,
        });
        const completed = steps.every((step) => step.status === "completed");
        yield* emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: {
            id: nodeId,
            threadId: active.input.threadId,
            runId: active.input.runId,
            parentNodeId: active.input.rootNodeId,
            rootNodeId: active.input.rootNodeId,
            kind: "todo_list",
            status: completed ? "completed" : "running",
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.id,
            nativeItemRef: providerRef(nativeItemId, "weak"),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: turn.startedAt,
            completedAt: completed ? now : null,
          },
        });
        yield* emit({
          type: "plan.updated",
          driver: HERMES_PROVIDER,
          plan: {
            id: planId,
            threadId: active.input.threadId,
            runId: active.input.runId,
            nodeId,
            status: completed ? "completed" : "active",
            kind: "todo_list",
            steps,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: HERMES_PROVIDER,
          turnItem: {
            id: turnItemId,
            threadId: active.input.threadId,
            runId: active.input.runId,
            nodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.id,
            nativeItemRef: providerRef(nativeItemId, "weak"),
            parentItemId: null,
            ordinal: resolveItemOrdinal(active, nativeItemId),
            status: completed ? "completed" : "running",
            title: "Todo list",
            startedAt: turn.startedAt,
            completedAt: completed ? now : null,
            updatedAt: now,
            type: "todo_list",
            planId,
            steps,
          },
        });
      });

      const messageArtifacts = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
        completed: boolean,
      ) {
        const turn = active.providerTurn;
        if (turn === null || active.assistantText.length === 0) return;
        const now = yield* DateTime.now;
        const nativeMessageId =
          active.assistantNativeId ??
          stableDigest(state.binding.storedSessionKey, active.operationId, "assistant");
        const messageId = options.idAllocator.derive.messageFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId: nativeMessageId,
        });
        const nodeId = options.idAllocator.derive.nodeFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId: nativeMessageId,
        });
        const turnItemId = options.idAllocator.derive.turnItemFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId: nativeMessageId,
        });
        const startedAt = active.assistantStartedAt ?? now;
        active.assistantStartedAt = startedAt;
        const normalizedAssistant = completed
          ? yield* normalizeHermesHistoryMessage({
              role: "assistant",
              text: active.assistantText,
              resolveMedia: (media, index) =>
                options.resolveHistoryMedia?.({
                  sourcePath: media.path,
                  expectedKind: media.kind,
                  threadId: String(active.input.threadId),
                  stableKey: `${state.binding.providerInstanceId}:${state.binding.profileKey}:${state.binding.storedSessionKey}:${nativeMessageId}:${index}`,
                }) ?? Effect.succeed(null),
            })
          : {
              text: parseHermesHistoryText({
                role: "assistant",
                text: active.assistantText,
              }).text,
              attachments: [],
            };
        const message: OrchestrationV2ConversationMessage = {
          createdBy: "agent",
          creationSource: "provider",
          id: messageId,
          threadId: active.input.threadId,
          runId: active.input.runId,
          nodeId,
          role: "assistant",
          text: normalizedAssistant.text,
          attachments: normalizedAssistant.attachments,
          streaming: !completed,
          createdAt: startedAt,
          updatedAt: now,
        };
        state.messages.set(String(messageId), message);
        yield* emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: {
            id: nodeId,
            threadId: active.input.threadId,
            runId: active.input.runId,
            parentNodeId: active.input.rootNodeId,
            rootNodeId: active.input.rootNodeId,
            kind: "assistant_message",
            status: completed ? "completed" : "running",
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.id,
            nativeItemRef: providerRef(nativeMessageId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt: completed ? now : null,
          },
        });
        yield* emit({ type: "message.updated", driver: HERMES_PROVIDER, message });
        const turnItem: OrchestrationV2TurnItem = {
          id: turnItemId,
          threadId: active.input.threadId,
          runId: active.input.runId,
          nodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.id,
          nativeItemRef: providerRef(nativeMessageId),
          parentItemId: null,
          ordinal: resolveItemOrdinal(active, `assistant:${nativeMessageId}`),
          status: completed ? "completed" : "running",
          title: null,
          startedAt,
          completedAt: completed ? now : null,
          updatedAt: now,
          type: "assistant_message",
          messageId,
          text: normalizedAssistant.text,
          streaming: !completed,
        };
        yield* emit({ type: "turn_item.updated", driver: HERMES_PROVIDER, turnItem });
      });

      const reasoningArtifacts = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
        completed: boolean,
      ) {
        const turn = active.providerTurn;
        if (turn === null || active.reasoningText.length === 0) return;
        const now = yield* DateTime.now;
        active.reasoningStartedAt ??= now;
        const nativeIdentity = `hermes-reasoning:${active.gatewayRunId ?? active.operationId}`;
        const nativeRef = providerRef(nativeIdentity, "weak");
        const nodeId = options.idAllocator.derive.nodeFromProviderItem({
          driver: HERMES_PROVIDER,
          nativeItemId: nativeIdentity,
        });
        yield* emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: {
            id: nodeId,
            threadId: active.input.threadId,
            runId: active.input.runId,
            parentNodeId: active.input.rootNodeId,
            rootNodeId: active.input.rootNodeId,
            kind: "reasoning",
            status: completed ? "completed" : "running",
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.id,
            nativeItemRef: nativeRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: active.reasoningStartedAt,
            completedAt: completed ? now : null,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: HERMES_PROVIDER,
          turnItem: {
            id: options.idAllocator.derive.turnItemFromProviderItem({
              driver: HERMES_PROVIDER,
              nativeItemId: nativeIdentity,
            }),
            threadId: active.input.threadId,
            runId: active.input.runId,
            nodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.id,
            nativeItemRef: nativeRef,
            parentItemId: null,
            ordinal: resolveItemOrdinal(active, nativeIdentity),
            status: completed ? "completed" : "running",
            title: "Reasoning",
            startedAt: active.reasoningStartedAt,
            completedAt: completed ? now : null,
            updatedAt: now,
            type: "reasoning",
            text: active.reasoningText,
            streaming: !completed,
          },
        });
      });

      const runtimeRequestTurnItem = (
        pending: PendingHermesRuntimeRequest,
        status: OrchestrationV2TurnItem["status"],
        completedAt: DateTime.Utc | null,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2TurnItem => {
        const base = {
          id: pending.turnItemId,
          threadId: pending.active.input.threadId,
          runId: pending.active.input.runId,
          nodeId: pending.nodeId,
          providerThreadId: pending.state.providerThread.id,
          providerTurnId: pending.active.providerTurn?.id ?? null,
          nativeItemRef: providerRef(
            pending.nativeIdentity,
            pending.nativeRequestId === undefined ? "weak" : "strong",
          ),
          parentItemId: null,
          ordinal: resolveItemOrdinal(pending.active, pending.nativeIdentity),
          status,
          title: pending.kind === "approval" ? "Approval required" : "User input",
          startedAt: pending.request.createdAt,
          completedAt,
          updatedAt,
        } as const;
        if (pending.kind === "approval") {
          return {
            ...base,
            type: "approval_request",
            requestId: pending.request.id,
            requestKind: "command",
            prompt: pending.prompt,
          };
        }
        return {
          ...base,
          type: "user_input_request",
          requestId: pending.request.id,
          questions: [
            {
              id: pending.questionId ?? "question",
              header: "Question",
              question: pending.prompt,
              options: (pending.choices ?? []).map((choice) => ({
                label: choice,
                description: choice,
              })),
            },
          ],
        };
      };

      /**
       * Answers a Hermes command approval on the thread's behalf. Returns false
       * when the gateway did not take the answer, so the caller can fall back to
       * asking the user rather than leaving the run parked on nobody.
       */
      const autoApproveCommand = Effect.fnUntraced(function* (
        state: HermesThreadState,
        prompt: string,
        nativeIdentity: string,
      ) {
        const resolved = yield* gatewayEffect(() =>
          client.respondToApproval(
            { session_id: state.liveSessionId, choice: "once" },
            mutationOptions(`hermes:auto-approve:${state.providerThread.id}:${nativeIdentity}`),
          ),
        ).pipe(
          Effect.map((result) => result.resolved),
          Effect.catch((cause) =>
            Effect.logWarning("orchestration-v2.hermes-auto-approve-failed", {
              providerSessionId: input.providerSessionId,
              providerThreadId: state.providerThread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (resolved) {
          yield* Effect.logDebug("orchestration-v2.hermes-auto-approved", {
            providerSessionId: input.providerSessionId,
            providerThreadId: state.providerThread.id,
            prompt,
          });
        }
        return resolved;
      });

      const emitRuntimeRequest = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
        event: HermesGatewayOrderedEvent,
        kind: PendingHermesRuntimeRequest["kind"],
      ) {
        if (active.providerTurn === null) return;
        const payload =
          typeof event.frame.params.payload === "object" && event.frame.params.payload !== null
            ? (event.frame.params.payload as Record<string, unknown>)
            : {};
        const nativeRequestId =
          kind === "clarification" ? nonEmptyString(payload.request_id) : undefined;
        if (kind === "clarification" && nativeRequestId === undefined) return;
        const nativeIdentity =
          nativeRequestId ??
          `approval:${event.eventId ?? event.eventSequence ?? event.transportSequence}`;
        if (
          [...pendingRuntimeRequests.values()].some(
            (pending) =>
              pending.state === state &&
              pending.kind === kind &&
              pending.nativeIdentity === nativeIdentity,
          )
        ) {
          return;
        }
        const prompt =
          kind === "approval"
            ? (nonEmptyString(payload.command) ??
              nonEmptyString(payload.description) ??
              "Hermes requests permission to run a command.")
            : (nonEmptyString(payload.question) ?? "Hermes requests more information.");
        const answerable = canRespondToRuntimeRequest[kind];
        if (
          kind === "approval" &&
          answerable &&
          hermesAutoApprovesCommands(active.input.runtimePolicy) &&
          // A request raised by a run T3 never submitted belongs to whoever
          // started it — a cron job, or another client on the session. T3
          // shows it either way, but only answers for the gateway when the
          // instance has opted into acting on its behalf.
          (!active.external || options.settings.proactiveEnabled) &&
          // `approval.respond` names a session, not a request, so an answer can
          // only be aimed while this is the session's sole outstanding
          // approval. With another one already parked on the user, approving
          // here would resolve whichever Hermes considers current.
          ![...pendingRuntimeRequests.values()].some(
            (candidate) => candidate.kind === "approval" && candidate.state === state,
          ) &&
          (yield* autoApproveCommand(state, prompt, nativeIdentity))
        ) {
          return;
        }
        const requestId = yield* options.idAllocator.allocate.runtimeRequest({
          driver: HERMES_PROVIDER,
          providerTurnId: active.providerTurn.id,
          nativeRequestId: nativeIdentity,
        });
        const now = yield* DateTime.now;
        const nodeId = options.idAllocator.derive.approvalNode({ requestId });
        const request: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: active.providerTurn.id,
          nativeRequestRef:
            nativeRequestId === undefined ? null : providerRef(nativeRequestId, "strong"),
          kind: kind === "approval" ? "command" : "user_input",
          status: "pending",
          responseCapability: answerable
            ? {
                type: "live",
                providerSessionId: input.providerSessionId,
              }
            : {
                type: "not_resumable",
                reason: hermesUnanswerableRuntimeRequestReason(kind),
              },
          createdAt: now,
          resolvedAt: null,
        };
        const pending: PendingHermesRuntimeRequest = {
          request,
          state,
          active,
          nodeId,
          turnItemId: options.idAllocator.derive.approvalTurnItem({ requestId }),
          nativeIdentity,
          kind,
          prompt,
          ...(kind === "clarification" && nativeRequestId !== undefined
            ? { questionId: nativeRequestId }
            : {}),
          ...(Array.isArray(payload.choices)
            ? {
                choices: payload.choices.filter(
                  (choice): choice is string => typeof choice === "string",
                ),
              }
            : {}),
          ...(nativeRequestId === undefined ? {} : { nativeRequestId }),
        };
        pendingRuntimeRequests.set(String(requestId), pending);
        state.runtimeRequests.set(String(requestId), request);
        const nativeRef = providerRef(
          nativeIdentity,
          nativeRequestId === undefined ? "weak" : "strong",
        );
        yield* emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: {
            id: nodeId,
            threadId: active.input.threadId,
            runId: active.input.runId,
            parentNodeId: active.input.rootNodeId,
            rootNodeId: active.input.rootNodeId,
            kind: kind === "approval" ? "approval_request" : "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: active.providerTurn.id,
            nativeItemRef: nativeRef,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* emit({
          type: "runtime_request.updated",
          driver: HERMES_PROVIDER,
          threadId: active.input.threadId,
          runtimeRequest: request,
        });
        yield* emit({
          type: "turn_item.updated",
          driver: HERMES_PROVIDER,
          turnItem: runtimeRequestTurnItem(pending, "waiting", null, now),
        });
        // The request is on the record either way, so the user can see what was
        // asked. What changes is whether T3 can carry an answer: without the
        // capability, parking the run here would wait forever, so settle it and
        // fail the turn with the reason instead of showing a live prompt whose
        // buttons cannot work.
        if (!answerable) {
          yield* Effect.logWarning("orchestration-v2.hermes-runtime-request-unanswerable", {
            providerSessionId: input.providerSessionId,
            providerThreadId: state.providerThread.id,
            requestId,
            kind,
            missingCapability: HERMES_RUNTIME_REQUEST_RESPONSE_CAPABILITIES[kind],
          });
          yield* settleRuntimeRequest(pending, "cancelled");
          yield* unblockGatewayRun(state, `hermes:unanswerable:${requestId}`);
          yield* finalizeTurn(state, "failed", hermesUnanswerableRuntimeRequestReason(kind));
          return;
        }
        yield* updateSession("waiting", null);
      });

      const settleRuntimeRequest = Effect.fnUntraced(function* (
        pending: PendingHermesRuntimeRequest,
        status: "resolved" | "cancelled",
      ) {
        const now = yield* DateTime.now;
        const resolved: OrchestrationV2RuntimeRequest = {
          ...pending.request,
          status,
          resolvedAt: now,
        };
        pending.state.runtimeRequests.set(String(resolved.id), resolved);
        pendingRuntimeRequests.delete(String(resolved.id));
        yield* emit({
          type: "runtime_request.updated",
          driver: HERMES_PROVIDER,
          threadId: pending.active.input.threadId,
          runtimeRequest: resolved,
        });
        yield* emit({
          type: "node.updated",
          driver: HERMES_PROVIDER,
          node: {
            id: pending.nodeId,
            threadId: pending.active.input.threadId,
            runId: pending.active.input.runId,
            parentNodeId: pending.active.input.rootNodeId,
            rootNodeId: pending.active.input.rootNodeId,
            kind: pending.kind === "approval" ? "approval_request" : "user_input_request",
            status: status === "resolved" ? "completed" : "cancelled",
            countsForRun: false,
            providerThreadId: pending.state.providerThread.id,
            providerTurnId: pending.active.providerTurn?.id ?? null,
            nativeItemRef: providerRef(
              pending.nativeIdentity,
              pending.nativeRequestId === undefined ? "weak" : "strong",
            ),
            runtimeRequestId: pending.request.id,
            checkpointScopeId: null,
            startedAt: pending.request.createdAt,
            completedAt: now,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: HERMES_PROVIDER,
          turnItem: runtimeRequestTurnItem(
            pending,
            status === "resolved" ? "completed" : "cancelled",
            now,
            now,
          ),
        });
      });

      const removeGeneratingTool = (active: ActiveHermesTurn, tool: ActiveHermesTool): void => {
        const key = tool.name ?? "";
        const queued = active.generatingToolsByName.get(key);
        if (queued === undefined) return;
        const index = queued.indexOf(tool);
        if (index >= 0) queued.splice(index, 1);
        if (queued.length === 0) active.generatingToolsByName.delete(key);
      };

      const handleToolEvent = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
        event: HermesGatewayOrderedEvent,
      ) {
        const payload = eventToolPayload(event);
        const eventType = event.frame.params.type;
        const name = nonEmptyString(payload.name) ?? null;
        const toolId = nonEmptyString(payload.tool_id);
        const runIdentity = event.runId ?? active.gatewayRunId ?? active.operationId;
        const generatingIdentity = `hermes-tool:${event.runId ?? active.operationId}:${
          event.eventId ?? event.eventSequence ?? event.transportSequence
        }`;
        let tool: ActiveHermesTool | undefined =
          toolId === undefined ? undefined : active.toolsByNativeId.get(toolId);

        if (tool === undefined && eventType !== "tool.generating") {
          const queued = active.generatingToolsByName.get(name ?? "")?.[0];
          if (queued !== undefined) {
            tool = queued;
            if (eventType !== "tool.progress") removeGeneratingTool(active, queued);
          }
        }
        if (tool === undefined && eventType === "tool.complete" && toolId === undefined) {
          tool = [...active.toolsByIdentity.values()]
            .toReversed()
            .find(
              (candidate) =>
                candidate.name === name &&
                (candidate.status === "pending" ||
                  candidate.status === "running" ||
                  candidate.status === "waiting"),
            );
        }
        if (tool === undefined) {
          const identity =
            toolId === undefined ? generatingIdentity : `hermes-tool:${runIdentity}:${toolId}`;
          tool = {
            identity,
            nativeToolId: toolId ?? null,
            name,
            input: {},
            output: undefined,
            outputRisk: undefined,
            outputRedacted: false,
            inlineDiff: null,
            structuredInput: false,
            title: name,
            status: eventType === "tool.generating" ? "pending" : "running",
            startedAt: null,
            completedAt: null,
          };
          active.toolsByIdentity.set(identity, tool);
          if (
            eventType === "tool.generating" ||
            (eventType === "tool.progress" && toolId === undefined)
          ) {
            const queued = active.generatingToolsByName.get(name ?? "") ?? [];
            queued.push(tool);
            active.generatingToolsByName.set(name ?? "", queued);
          }
        }
        if (toolId !== undefined) {
          tool.nativeToolId = toolId;
          active.toolsByNativeId.set(toolId, tool);
        }
        if (name !== null) tool.name = name;

        const now = yield* DateTime.now;
        if (eventType === "tool.generating") {
          tool.status = "pending";
        } else if (eventType === "tool.start" || eventType === "tool.progress") {
          if (eventType === "tool.start") removeGeneratingTool(active, tool);
          tool.status = "running";
          tool.startedAt ??= now;
          const argsText = nonEmptyString(payload.args_text);
          let startInput: unknown;
          if (payload.args !== undefined) {
            startInput = payload.args;
            tool.structuredInput = true;
          } else if (payload.arguments !== undefined) {
            startInput = payload.arguments;
            tool.structuredInput = true;
          } else if (argsText !== undefined) {
            startInput = parseHermesToolArguments(argsText);
            tool.structuredInput = true;
          } else {
            startInput = nonEmptyString(payload.context) ?? nonEmptyString(payload.preview) ?? {};
            tool.structuredInput = false;
          }
          tool.input = sanitizeHermesToolValue(startInput, { maxChars: 20_000 });
          tool.title =
            nonEmptyString(payload.context) ?? nonEmptyString(payload.preview) ?? tool.name;
        } else {
          removeGeneratingTool(active, tool);
          tool.status = toolTerminalStatus(payload);
          tool.startedAt ??= now;
          tool.completedAt ??= now;
          const completedInput =
            payload.args !== undefined
              ? payload.args
              : payload.arguments !== undefined
                ? payload.arguments
                : undefined;
          if (completedInput !== undefined) {
            tool.input = sanitizeHermesToolValue(completedInput, { maxChars: 20_000 });
            tool.structuredInput = true;
          }
          const inlineDiff = nonEmptyString(payload.inline_diff);
          if (inlineDiff !== undefined) {
            const sanitizedDiff = sanitizeHermesToolValue(inlineDiff);
            if (typeof sanitizedDiff === "string") tool.inlineDiff = sanitizedDiff;
          }
          const completedOutput =
            payload.result !== undefined
              ? payload.result
              : (nonEmptyString(payload.result_text) ??
                nonEmptyString(payload.summary) ??
                inlineDiff);
          if (completedOutput !== undefined) {
            tool.output = sanitizeHermesToolValue(completedOutput);
          }
          tool.title =
            nonEmptyString(payload.summary) ??
            nonEmptyString(payload.context) ??
            nonEmptyString(payload.preview) ??
            tool.name;
        }
        yield* toolArtifacts(state, active, tool);
        if (payload.todos !== undefined) {
          yield* todoArtifacts(state, active, payload.todos);
        }
      });

      const handleToolOutputRisk = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
        event: HermesGatewayOrderedEvent,
      ) {
        const payload = eventToolPayload(event);
        const toolId = nonEmptyString(payload.tool_id);
        if (toolId === undefined) return;
        const tool = active.toolsByNativeId.get(toolId);
        if (tool === undefined) return;
        const risk = nonEmptyString(payload.risk);
        const findings = payload.findings;
        const riskDetails = sanitizeHermesToolValue(
          {
            ...(risk === undefined ? {} : { risk }),
            ...(findings === undefined ? {} : { findings }),
            ...(payload.redacted === undefined ? {} : { redacted: payload.redacted }),
          },
          { maxChars: 10_000 },
        );
        tool.outputRisk = riskDetails;
        if (payload.redacted === true) tool.outputRedacted = true;
        yield* toolArtifacts(state, active, tool);
      });

      const finalizeUnsettledTools = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
        turnStatus: "completed" | "interrupted" | "failed",
      ) {
        const now = yield* DateTime.now;
        for (const tool of active.toolsByIdentity.values()) {
          if (tool.status !== "pending" && tool.status !== "running" && tool.status !== "waiting") {
            continue;
          }
          tool.status =
            turnStatus === "failed"
              ? "failed"
              : turnStatus === "interrupted"
                ? "interrupted"
                : "cancelled";
          tool.startedAt ??= tool.status === "cancelled" ? null : now;
          tool.completedAt = now;
          yield* toolArtifacts(state, active, tool);
        }
      });

      const finalizeTurn = Effect.fnUntraced(function* (
        state: HermesThreadState,
        status: "completed" | "interrupted" | "failed",
        failureMessage?: string,
      ) {
        const active = state.activeTurn;
        if (active === null || active.providerTurn === null || active.finalized) return;
        const terminalIntentSettlement = yield* Effect.gen(function* () {
          const { now, expiresAt } = leaseTimes();
          const renewed = yield* options.repository.renewOwnerLease({
            bindingId: state.binding.bindingId,
            ownerKey: state.lease.ownerKey,
            generation: state.lease.generation,
            now,
            expiresAt,
          });
          if (!renewed) {
            const reacquired = yield* options.repository.acquireOwnerLease({
              bindingId: state.binding.bindingId,
              ownerKey: state.lease.ownerKey,
              expectedGeneration: state.lease.generation,
              now,
              expiresAt,
            });
            if (Option.isNone(reacquired)) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes terminal mutation settlement lost its generation fence",
              });
            }
            state.lease = reacquired.value;
          }
          // An external run carries no prompt mutation of T3's, so there is no
          // durable intent to settle — only the ownership lease above matters.
          if (active.external) return;
          yield* transitionIntent(
            state,
            active.operationId,
            active.intentState,
            active.intentState === "admitted" ? "confirmed" : "reconciled",
          );
        }).pipe(Effect.result);
        const settlementFailed = terminalIntentSettlement._tag === "Failure";
        if (terminalIntentSettlement._tag === "Failure") {
          state.ownershipLost = true;
          yield* Effect.logError("Hermes terminal event could not settle its durable intent", {
            operationId: active.operationId,
            cause: terminalIntentSettlement.failure,
          });
        }
        const projectedStatus = settlementFailed ? "failed" : status;
        const projectedFailureMessage = settlementFailed
          ? "Hermes ownership was lost before terminal settlement."
          : failureMessage;
        active.finalized = true;
        const now = yield* DateTime.now;
        yield* finalizeUnsettledTools(state, active, projectedStatus);
        yield* reasoningArtifacts(state, active, true);
        yield* messageArtifacts(state, active, true);
        for (const pending of pendingRuntimeRequests.values()) {
          if (pending.active === active) {
            yield* settleRuntimeRequest(pending, "cancelled");
          }
        }
        const providerTurn: OrchestrationV2ProviderTurn = {
          ...active.providerTurn,
          status: projectedStatus,
          completedAt: now,
        };
        active.providerTurn = providerTurn;
        state.turns.set(String(providerTurn.id), providerTurn);
        yield* emit({
          type: "provider_turn.updated",
          driver: HERMES_PROVIDER,
          threadId: active.input.threadId,
          providerTurn,
        });
        yield* updateThread(state, {
          status: projectedStatus === "failed" ? "error" : "idle",
        });
        yield* updateSession(
          projectedStatus === "failed" ? "error" : "ready",
          projectedFailureMessage ?? null,
        );
        yield* emit(
          projectedStatus === "failed"
            ? {
                type: "turn.terminal",
                driver: HERMES_PROVIDER,
                providerThreadId: state.providerThread.id,
                providerTurnId: providerTurn.id,
                runOrdinal: active.input.runOrdinal,
                failureItemOrdinal: active.nextItemOrdinal,
                status: "failed",
                failure: makeProviderFailure({
                  class: "provider_error",
                  message: projectedFailureMessage ?? "Hermes turn failed.",
                }),
                threadDisposition: "broken",
              }
            : {
                type: "turn.terminal",
                driver: HERMES_PROVIDER,
                providerThreadId: state.providerThread.id,
                providerTurnId: providerTurn.id,
                runOrdinal: active.input.runOrdinal,
                status: projectedStatus,
                failure: null,
                threadDisposition: "reusable",
              },
        );
        yield* Deferred.succeed(active.completion, undefined);
        state.settledRunId = active.gatewayRunId ?? active.sourceRunId ?? state.settledRunId;
        state.activeTurn = null;
      });

      /**
       * Holds the events of a gateway run T3 never submitted and asks the
       * orchestrator for a continuation turn to drain them. Hermes streams
       * cron jobs and other clients' prompts on the same session, and without
       * this the transcript would only ever move when a T3 turn was open.
       *
       * Content opens the offer; bare status events are captured only once
       * content exists, so a terminal status that arrives before the
       * continuation attaches still closes its turn instead of leaving it
       * streaming forever.
       */
      const captureExternalEvent = Effect.fnUntraced(function* (
        state: HermesThreadState,
        event: HermesGatewayOrderedEvent,
      ) {
        const eventType = event.frame.params.type;
        const isRuntimeRequest = HERMES_RUNTIME_REQUEST_EVENT_TYPES.has(eventType);
        // Capture is not gated on the proactive switch. These events are
        // already in hand on a socket T3 is already reading, and dropping them
        // is the one outcome with no recovery: the pinned protocol has no
        // durable event cursor, so what is discarded here can never be read
        // back. The switch governs what T3 *spends* on an external run —
        // keeping sessions subscribed when nobody is looking, and answering
        // requests on behalf of whoever started it — not whether the work is
        // allowed to reach the transcript at all.
        const isContent = HERMES_EXTERNAL_CONTENT_EVENT_TYPES.has(eventType);
        const isTerminalSignal =
          eventType === "status.update" || eventType === "session.status" || eventType === "error";
        if (!isContent && !(isTerminalSignal && state.externalEvents.length > 0)) return;
        if (state.ownershipLost) return;
        if (event.runId !== undefined && event.runId === state.settledRunId) return;
        // Trimming the tail costs transcript detail, which is why the limit is
        // safe for content. It is not safe for a request: drop that one and the
        // continuation turn opens with no prompt to answer while the gateway
        // stays parked on it, so requests are buffered past the limit.
        if (
          state.externalEvents.length >= HERMES_EXTERNAL_EVENT_BUFFER_LIMIT &&
          !isRuntimeRequest
        ) {
          if (state.externalEvents.length === HERMES_EXTERNAL_EVENT_BUFFER_LIMIT) {
            state.externalEvents.push(event);
            yield* Effect.logWarning("orchestration-v2.hermes-external-buffer-full", {
              providerThreadId: state.providerThread.id,
              limit: HERMES_EXTERNAL_EVENT_BUFFER_LIMIT,
            });
          }
          return;
        }
        if (state.externalEvents.length === 0) {
          state.externalRunId = event.runId ?? null;
        }
        state.externalEvents.push(event);
        if (state.externalContinuationRequested) return;
        const appThreadId = state.providerThread.appThreadId;
        if (appThreadId === null) {
          yield* Effect.logWarning("orchestration-v2.hermes-external-run-unroutable", {
            providerThreadId: state.providerThread.id,
            liveSessionId: state.liveSessionId,
          });
          return;
        }
        state.externalContinuationRequested = true;
        yield* Effect.logInfo("orchestration-v2.hermes-external-run-detected", {
          providerSessionId: input.providerSessionId,
          providerThreadId: state.providerThread.id,
          threadId: appThreadId,
          gatewayRunId: state.externalRunId,
        });
        yield* continuationRequests.offer({
          threadId: appThreadId,
          providerThreadId: state.providerThread.id,
          driver: HERMES_PROVIDER,
          detail: HERMES_EXTERNAL_RUN_CONTINUATION_DETAIL,
          // A continuation the worker drops (archived thread) must clear the
          // offer, or no later external run would ever be delivered.
          clearIfCurrent: () =>
            Effect.sync(() => {
              state.externalContinuationRequested = false;
              state.externalEvents.length = 0;
              state.externalRunId = null;
            }),
        });
      });

      const settleExternalRun = Effect.fnUntraced(function* (
        state: HermesThreadState,
        status: string | undefined,
      ) {
        if (!state.externalRunActive || status === undefined || !isTerminalHermesStatus(status)) {
          return;
        }
        state.externalRunActive = false;
        const failed = status.includes("error") || status.includes("failed");
        yield* updateThread(state, { status: failed ? "error" : "idle" });
        yield* updateSession(
          failed ? "error" : "ready",
          failed ? "Hermes recovered external run failed." : null,
        );
      });

      /**
       * Applies a mid-session model switch through Hermes' `/model` command
       * channel: the pinned gateway protocol exposes no model mutation, but
       * the command executes gateway-side and Hermes confirms the switch with
       * a `session.info` event. The optimistic session update keeps
       * back-to-back turns from resubmitting the switch while that event is
       * still in flight.
       */
      const applySessionModelSwitch = Effect.fnUntraced(function* (
        state: HermesThreadState,
        turnInput: ProviderAdapterV2TurnInput,
        model: string,
      ) {
        const operationId = `hermes:model:${turnInput.attemptId}`;
        const prepared = yield* prepareBoundMutation(state, {
          operationId,
          mutationKind: "model_switch",
          method: "prompt.submit",
          payloadDigest: stableDigest(state.binding.storedSessionKey, model),
        });
        const submit = () =>
          client.submitPrompt(
            {
              session_id: state.liveSessionId,
              text: `/model ${model} --session`,
            },
            mutationOptions(operationId),
          );
        const submitted = prepared.replay
          ? yield* gatewayEffect(submit).pipe(
              Effect.tap(() =>
                transitionIntent(
                  state,
                  operationId,
                  prepared.intentState,
                  prepared.intentState === "admitted" ? "confirmed" : "reconciled",
                ),
              ),
            )
          : yield* settleMutation(state, operationId, submit);
        if (submitted.mutation_status === "completed") {
          if (submitted.status === "error") {
            return yield* new ProviderAdapterProtocolError({
              driver: HERMES_PROVIDER,
              detail: `Hermes rejected the model switch to ${model}`,
            });
          }
        } else {
          // The command was admitted as its own gateway run; wait for the
          // session to settle so the actual prompt is not queued into the
          // command run.
          let settled = false;
          for (let attempt = 0; attempt < HERMES_MODEL_SWITCH_POLL_ATTEMPTS; attempt += 1) {
            const status = yield* gatewayEffect(() =>
              client.readSessionStatus({
                session_id: state.liveSessionId,
                profile: options.settings.profileKey,
              }),
            );
            if (!isActiveHermesStatus(hermesSessionRuntimeStatus(status))) {
              settled = true;
              break;
            }
            yield* Effect.sleep(HERMES_MODEL_SWITCH_POLL_INTERVAL);
          }
          if (!settled) {
            return yield* new ProviderAdapterProtocolError({
              driver: HERMES_PROVIDER,
              detail: `Hermes did not settle the model switch to ${model}`,
            });
          }
        }
        if (providerSession.model !== model) {
          providerSession = {
            ...providerSession,
            model,
            updatedAt: yield* DateTime.now,
          };
          yield* emit({
            type: "provider_session.updated",
            driver: HERMES_PROVIDER,
            providerSession,
          });
        }
      });

      // Consume one absorbed completion for a Hermes-side queued steering
      // prompt instead of terminalizing the turn: close out the finished
      // run's streamed artifacts and reset the accumulators so the follow-up
      // run (which arrives under a fresh gateway run id) streams new items.
      const absorbSteerCompletion = Effect.fnUntraced(function* (
        state: HermesThreadState,
        active: ActiveHermesTurn,
      ) {
        if (active.interrupted || active.pendingSteerCompletions <= 0) return false;
        active.pendingSteerCompletions -= 1;
        yield* reasoningArtifacts(state, active, true);
        yield* messageArtifacts(state, active, true);
        active.gatewayRunId = null;
        active.assistantNativeId = null;
        active.assistantText = "";
        active.assistantSnapshotPending = false;
        active.assistantStartedAt = null;
        active.reasoningText = "";
        active.reasoningStartedAt = null;
        active.reasoningHasStreamedDelta = false;
        return true;
      });

      const handleGatewayEvent = Effect.fnUntraced(function* (event: HermesGatewayOrderedEvent) {
        const state =
          (event.sessionId === undefined ? undefined : statesByLiveSession.get(event.sessionId)) ??
          [...statesByProviderThread.values()].find(
            (candidate) => candidate.binding.storedSessionKey === event.sessionKey,
          );
        if (state === undefined) return;
        if (event.frame.params.type === "title.changed") {
          let titleState: HermesGatewaySessionTitleResult;
          try {
            titleState = decodeTitleChanged(event.frame.params.payload);
          } catch {
            return;
          }
          yield* reconcileTitle(state, titleState);
          return;
        }
        if (event.frame.params.type === "session.info") {
          const payload =
            typeof event.frame.params.payload === "object" && event.frame.params.payload !== null
              ? (event.frame.params.payload as Record<string, unknown>)
              : {};
          const model = nonEmptyString(payload.model);
          if (model !== undefined && model !== providerSession.model) {
            providerSession = {
              ...providerSession,
              model,
              updatedAt: yield* DateTime.now,
            };
            yield* emit({
              type: "provider_session.updated",
              driver: HERMES_PROVIDER,
              providerSession,
            });
          }
          return;
        }
        const active = state.activeTurn;
        if (active === null) {
          const externalStatus =
            event.frame.params.type === "message.complete"
              ? (eventStatus(event) ?? "complete")
              : event.frame.params.type === "error"
                ? "error"
                : eventStatus(event);
          yield* captureExternalEvent(state, event);
          yield* settleExternalRun(state, externalStatus);
          return;
        }
        if (active.providerTurn === null) {
          active.bufferedEvents.push(event);
          return;
        }
        if (
          active.gatewayRunId !== null &&
          event.runId !== undefined &&
          event.runId !== active.gatewayRunId
        ) {
          return;
        }
        if (event.eventId !== undefined) {
          if (active.seenEventIds.has(event.eventId)) return;
          active.seenEventIds.add(event.eventId);
        }

        switch (event.frame.params.type) {
          case "thinking.delta": {
            const text = eventText(event);
            if (text.length > 0 && !active.reasoningHasStreamedDelta) {
              active.reasoningText += text;
              yield* reasoningArtifacts(state, active, false);
            }
            return;
          }
          case "reasoning.delta": {
            const text = eventText(event);
            if (text.length > 0) {
              if (!active.reasoningHasStreamedDelta) active.reasoningText = "";
              active.reasoningHasStreamedDelta = true;
              active.reasoningText += text;
              yield* reasoningArtifacts(state, active, false);
            }
            return;
          }
          case "reasoning.available": {
            const text = eventText(event);
            if (text.length > 0 && !active.reasoningHasStreamedDelta) {
              active.reasoningText = text;
              yield* reasoningArtifacts(state, active, false);
            }
            return;
          }
          case "approval.request":
            yield* emitRuntimeRequest(state, active, event, "approval");
            return;
          case "clarify.request":
            yield* emitRuntimeRequest(state, active, event, "clarification");
            return;
          case "tool.generating":
          case "tool.progress":
          case "tool.start":
          case "tool.complete": {
            yield* handleToolEvent(state, active, event);
            return;
          }
          case "tool.output_risk":
            yield* handleToolOutputRisk(state, active, event);
            return;
          case "message.start": {
            active.assistantNativeId =
              eventMessageId(event) ?? active.assistantNativeId ?? active.operationId;
            const text = eventText(event);
            if (text) {
              active.assistantText = text;
              active.assistantSnapshotPending = true;
            }
            yield* messageArtifacts(state, active, false);
            return;
          }
          case "message.delta": {
            active.assistantNativeId =
              eventMessageId(event) ?? active.assistantNativeId ?? active.operationId;
            if (active.assistantSnapshotPending) {
              active.assistantText = "";
              active.assistantSnapshotPending = false;
            }
            active.assistantText += eventText(event);
            yield* messageArtifacts(state, active, false);
            return;
          }
          case "message.interim": {
            active.assistantNativeId =
              eventMessageId(event) ?? active.assistantNativeId ?? active.operationId;
            // Interim events carry a full message snapshot, not a delta:
            // merge instead of appending so a repeated snapshot (e.g. the
            // delegation acknowledgement) is not duplicated.
            const text = eventText(event);
            if (text && text !== active.assistantText) {
              active.assistantText = text.startsWith(active.assistantText)
                ? text
                : `${active.assistantText}${text}`;
            }
            if (text) active.assistantSnapshotPending = true;
            yield* messageArtifacts(state, active, false);
            return;
          }
          case "message.complete": {
            if (active.finalized) return;
            active.assistantNativeId =
              eventMessageId(event) ?? active.assistantNativeId ?? active.operationId;
            const text = eventText(event);
            if (text && text !== active.assistantText && !active.assistantText.endsWith(text)) {
              active.assistantText = text.startsWith(active.assistantText)
                ? text
                : `${active.assistantText}${text}`;
            }
            const status = eventStatus(event);
            if (status === "error" || status === "failed") {
              yield* finalizeTurn(state, "failed", "Hermes reported a turn error.");
            } else if (status === "interrupted") {
              yield* finalizeTurn(state, "interrupted");
            } else if (!(yield* absorbSteerCompletion(state, active))) {
              yield* finalizeTurn(state, active.interrupted ? "interrupted" : "completed");
            }
            return;
          }
          case "status.update":
          case "session.status": {
            const status = eventStatus(event);
            if (status === "error" || status === "failed") {
              yield* finalizeTurn(state, "failed", "Hermes reported a turn error.");
            } else if (status === "interrupted") {
              yield* finalizeTurn(state, "interrupted");
            } else if (status === "idle" || status === "complete" || status === "completed") {
              if (!(yield* absorbSteerCompletion(state, active))) {
                yield* finalizeTurn(state, active.interrupted ? "interrupted" : "completed");
              }
            }
            return;
          }
          case "error":
            yield* finalizeTurn(state, "failed", "Hermes reported a turn error.");
            return;
          default:
            // Unsupported and future event families are isolated from text streaming.
            return;
        }
      });

      const unsubscribe = client.onEvent((event) =>
        runPromise(
          handleGatewayEvent(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Ignored malformed Hermes gateway event", {
                eventType: event.frame.params.type,
                cause,
              }),
            ),
          ),
        ),
      );

      /**
       * Opens the turn that carries a gateway run T3 never submitted. Nothing
       * is sent to Hermes: the run already exists, so the turn only replays
       * the events captured while no turn was attached and then streams the
       * rest live. Events that arrive after this turn terminalizes fall back
       * to the capture path and offer their own continuation.
       */
      const startExternalContinuationTurn = Effect.fnUntraced(function* (
        state: HermesThreadState,
        turnInput: ProviderAdapterV2TurnInput,
      ) {
        const drained = state.externalEvents.splice(0);
        const gatewayRunId = state.externalRunId;
        state.externalContinuationRequested = false;
        state.externalRunId = null;
        alignStateProviderThread(state, turnInput.providerThread);
        const operationId = `hermes:external:${turnInput.attemptId}`;
        const nativeRunId =
          gatewayRunId ?? stableDigest(state.binding.storedSessionKey, operationId, "external-run");
        const completion = yield* Deferred.make<void>();
        const active: ActiveHermesTurn = {
          input: turnInput,
          operationId,
          completion,
          external: true,
          sourceRunId: gatewayRunId,
          bufferedEvents: [],
          providerTurn: null,
          assistantNativeId: null,
          assistantText: "",
          assistantSnapshotPending: false,
          assistantStartedAt: null,
          reasoningText: "",
          reasoningStartedAt: null,
          reasoningHasStreamedDelta: false,
          itemOrdinals: new Map(),
          nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          toolsByIdentity: new Map(),
          toolsByNativeId: new Map(),
          generatingToolsByName: new Map(),
          seenEventIds: new Set(),
          planId: null,
          // Left unfiltered: a second external run that starts while this turn
          // streams belongs in the same continuation rather than nowhere.
          gatewayRunId: null,
          pendingSteerCompletions: 0,
          interrupted: false,
          finalized: false,
          intentState: "prepared",
        };
        state.activeTurn = active;
        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: options.idAllocator.derive.providerTurn({
            driver: HERMES_PROVIDER,
            nativeTurnId: nativeRunId,
          }),
          providerThreadId: state.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: providerRef(nativeRunId, gatewayRunId === null ? "weak" : "strong"),
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        active.providerTurn = providerTurn;
        state.turns.set(String(providerTurn.id), providerTurn);
        yield* emit({
          type: "provider_turn.updated",
          driver: HERMES_PROVIDER,
          threadId: turnInput.threadId,
          providerTurn,
        });
        yield* updateThread(state, {
          status: "active",
          firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
          lastRunOrdinal: turnInput.runOrdinal,
        });
        yield* updateSession("running", null);
        for (const buffered of drained) {
          yield* handleGatewayEvent(buffered);
        }
        if (!active.finalized && !state.externalRunActive) {
          // The run had already settled before this turn attached, so no
          // further event will arrive to terminalize it.
          yield* finalizeTurn(state, "completed");
        }
      });

      const acquireLease = Effect.fnUntraced(function* (binding: HermesSessionBinding) {
        const { now, expiresAt } = leaseTimes();
        const acquired = yield* options.repository.acquireOwnerLease({
          bindingId: binding.bindingId,
          ownerKey: String(input.providerSessionId),
          expectedGeneration: binding.leaseGeneration,
          now,
          expiresAt,
        });
        if (Option.isNone(acquired)) {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: `Hermes binding ${binding.bindingId} is owned by another generation`,
          });
        }
        return acquired.value;
      });

      const readTitleState = Effect.fnUntraced(function* (liveSessionId: string) {
        if (!client.hasCapability("session.title")) return undefined;
        return yield* gatewayEffect(() => client.readSessionTitle({ session_id: liveSessionId }));
      });

      const ensureSessionMcp = Effect.fnUntraced(function* (
        liveSessionId: string,
        threadId: ProviderAdapterV2EnsureThreadInput["threadId"],
      ) {
        if (!mcpAvailable) return;
        const mcpSession = McpProviderSession.readMcpProviderSession(threadId);
        if (mcpSession === undefined) {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: `T3 MCP credential was not prepared for Hermes thread ${threadId}`,
          });
        }
        const credentialIdentity = mcpSession.credentialId ?? mcpSession.providerSessionId;
        if (mcpCredentialByLiveSession.get(liveSessionId) === credentialIdentity) {
          return;
        }
        const operationId = `hermes:mcp:replace:${stableDigest(
          options.instanceId,
          liveSessionId,
          credentialIdentity,
        )}`;
        const lease = yield* gatewayEffect(() =>
          client.replaceSessionMcp(
            {
              session_id: liveSessionId,
              servers: {
                "t3-code": {
                  url: mcpSession.endpoint,
                  headers: {
                    Authorization: mcpSession.authorizationHeader,
                  },
                },
              },
            },
            mutationOptions(operationId),
          ),
        );
        if (
          lease.scope.session_id !== liveSessionId ||
          !lease.servers.some((server) => server.name === "t3-code") ||
          !lease.tool_names.some((toolName) => toolName.endsWith("__delegate_task"))
        ) {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: `Hermes did not scope the T3 orchestration MCP lease to live session ${liveSessionId}`,
          });
        }
        mcpCredentialByLiveSession.set(liveSessionId, credentialIdentity);
      });

      const importedActivityTurnItems = (
        threadId: ProviderAdapterV2EnsureThreadInput["threadId"],
        binding: HermesSessionBinding,
        activities: ReadonlyArray<HermesImportedActivity>,
      ): ReadonlyArray<OrchestrationV2TurnItem> => {
        const createdAt = DateTime.makeUnsafe(binding.createdAt);
        return activities.map((activity, index): OrchestrationV2TurnItem => {
          const nativeItemId = `hermes-import:${binding.providerInstanceId}:${binding.profileKey}:${binding.storedSessionKey}:${activity.key}`;
          // Imported history carries no timestamps, so activities share the
          // ordinal-offset clock used for hydrated messages: they interleave
          // deterministically with the surrounding transcript.
          const at = DateTime.add(createdAt, { milliseconds: activity.ordinal });
          const base = {
            id: options.idAllocator.derive.turnItemFromProviderItem({
              driver: HERMES_PROVIDER,
              nativeItemId,
            }),
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: providerRef(nativeItemId, "weak"),
            parentItemId: null,
            ordinal: index,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
          };
          switch (activity.kind) {
            case "reasoning":
              return {
                ...base,
                status: "completed",
                title: null,
                type: "reasoning",
                text: activity.text,
                streaming: false,
              };
            case "command_execution":
              return {
                ...base,
                status: activity.status,
                title: activity.title,
                type: "command_execution",
                input: activity.input,
                ...(activity.output === undefined ? {} : { output: activity.output }),
              };
            case "file_change":
              return {
                ...base,
                status: activity.status,
                title: activity.title,
                type: "file_change",
                fileName: activity.fileName,
              };
            case "web_search":
              return {
                ...base,
                status: activity.status,
                title: activity.title,
                type: "web_search",
                patterns: activity.patterns,
              };
            case "dynamic_tool":
              return {
                ...base,
                status: activity.status,
                title: activity.title,
                type: "dynamic_tool",
                toolName: activity.toolName,
                input: activity.input,
                ...(activity.output === undefined ? {} : { output: activity.output }),
              };
          }
        });
      };

      const historyMessages = Effect.fnUntraced(function* (
        threadId: ProviderAdapterV2EnsureThreadInput["threadId"],
        binding: HermesSessionBinding,
        history: HermesGatewaySessionHistoryResult,
      ) {
        const createdAt = DateTime.makeUnsafe(binding.createdAt);
        const imported = yield* options.repository.getSessionImportByStoredIdentity({
          providerInstanceId: binding.providerInstanceId,
          profileKey: binding.profileKey,
          projectId: binding.projectId,
          storedSessionKey: binding.storedSessionKey,
        });
        // The inherited boundary is recorded once, on the first hydration
        // that actually observes history, so imported-transcript
        // normalization and activity rehydration only ever apply to the
        // history that existed at import time. An empty read leaves the
        // boundary unrecorded — history may simply not be readable yet — so
        // a later full history still hydrates. Native T3 messages appended
        // after the boundary are left untouched.
        const inheritedCount = Option.isSome(imported)
          ? (imported.value.inheritedMessageCount ??
            (history.messages.length === 0
              ? 0
              : yield* options.repository.setSessionImportInheritedCount({
                  importId: imported.value.importId,
                  inheritedMessageCount: history.messages.length,
                  now: DateTime.formatIso(yield* DateTime.now),
                })))
          : 0;
        // Activity rehydration runs over the whole history, not just the
        // inherited prefix: `session.history` is the only record of a run T3
        // did not drive (a cron job, another client, or anything Hermes kept
        // doing after a turn settled while T3 was disconnected), and reading
        // it back is how the native client shows that work too. Transcript
        // normalization stays fenced to the inherited prefix — post-boundary
        // rows are native T3 messages that were never transport-framed.
        //
        // Live-streamed items carry a run identity history has no column for,
        // so a call T3 already projected rehydrates under a different id. The
        // orchestrator settles that on content when it merges the snapshot.
        const hydration = hydrateImportedHermesActivities(history.messages);
        // Rehydrated tool outputs come from raw history rows, so they may
        // still carry Hermes' MEDIA: output protocol. Resolve it to durable
        // attachment markers the same way visible transcript rows do.
        const normalizedActivities = yield* Effect.forEach(
          hydration.activities,
          Effect.fnUntraced(function* (activity) {
            if (!("output" in activity) || activity.output === undefined) return activity;
            const normalized = yield* normalizeHermesHistoryMessage({
              role: "tool",
              text: activity.output,
              resolveMedia: (media, index) =>
                options.resolveHistoryMedia?.({
                  sourcePath: media.path,
                  expectedKind: media.kind,
                  threadId: String(threadId),
                  stableKey: `${binding.providerInstanceId}:${binding.profileKey}:${binding.storedSessionKey}:${activity.key}:${index}`,
                }) ?? Effect.succeed(null),
            });
            const markers = normalized.attachments.map(
              (attachment) => `[Attachment: ${attachment.name}]`,
            );
            const output = [normalized.text, ...markers].filter(Boolean).join("\n\n");
            return { ...activity, output };
          }),
          { concurrency: 1 },
        );
        const turnItems = importedActivityTurnItems(threadId, binding, normalizedActivities);
        const messages = yield* Effect.forEach(
          history.messages,
          Effect.fnUntraced(function* (message, ordinal) {
            // A row subsumed by a rehydrated activity is hidden wherever it
            // sits: now that activities cover the whole history, leaving the
            // post-boundary ones in would print every tool result twice —
            // once as a system message, once as the tool item it belongs to.
            if (hydration.hiddenOrdinals.has(ordinal)) return [];
            const rawText = message.text ?? "";
            const text =
              ordinal < inheritedCount && message.role === "user"
                ? normalizeImportedHermesUserText(rawText)
                : rawText;
            if (!text) return [];
            const nativeId =
              message.message_id ??
              stableDigest(
                options.instanceId,
                options.settings.profileKey,
                binding.storedSessionKey,
                ordinal,
                message.role,
                text,
              );
            // Imported transport messages need sender/envelope cleanup, while
            // every assistant/tool history message may contain Hermes' native
            // MEDIA: output protocol (including sessions created in T3 Work).
            const normalized =
              ordinal < inheritedCount || message.role === "assistant" || message.role === "tool"
                ? yield* normalizeHermesHistoryMessage({
                    role: message.role,
                    text,
                    resolveMedia: (media, index) =>
                      options.resolveHistoryMedia?.({
                        sourcePath: media.path,
                        expectedKind: media.kind,
                        threadId: String(threadId),
                        stableKey: `${binding.providerInstanceId}:${binding.profileKey}:${binding.storedSessionKey}:${nativeId}:${index}`,
                      }) ?? Effect.succeed(null),
                  })
                : { text, attachments: [] };
            if (!normalized.text && normalized.attachments.length === 0) return [];
            return [
              {
                createdBy: message.role === "user" ? "user" : "agent",
                creationSource: "provider",
                id: options.idAllocator.derive.messageFromProviderItem({
                  driver: HERMES_PROVIDER,
                  nativeItemId: nativeId,
                }),
                threadId,
                runId: null,
                nodeId: null,
                role: historyRole(message.role),
                text: normalized.text,
                attachments: normalized.attachments,
                streaming: false,
                // The pinned history payload has no timestamps. Preserve its
                // authoritative array order in projection queries, which sort
                // messages by createdAt before id.
                createdAt: DateTime.add(createdAt, { milliseconds: ordinal }),
                updatedAt: DateTime.add(createdAt, { milliseconds: ordinal }),
              } satisfies OrchestrationV2ConversationMessage,
            ];
          }),
          { concurrency: 1 },
        ).pipe(Effect.map((rows) => rows.flat()));
        return { messages, turnItems };
      });

      const registerState = Effect.fnUntraced(function* (
        binding: HermesSessionBinding,
        liveSessionId: string,
        lease: HermesOwnerLease,
        appThreadId: ProviderAdapterV2EnsureThreadInput["threadId"],
        history: HermesGatewaySessionHistoryResult,
        externalRunActive: boolean,
        titleState?: HermesGatewaySessionTitleResult,
      ) {
        const now = yield* DateTime.now;
        const nativeThreadId = `${options.instanceId}:${options.settings.profileKey}:${binding.storedSessionKey}`;
        const providerThread: OrchestrationV2ProviderThread = {
          id: options.idAllocator.derive.providerThread({
            driver: HERMES_PROVIDER,
            nativeThreadId,
          }),
          driver: HERMES_PROVIDER,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId,
          ownerNodeId: null,
          nativeThreadRef: providerRef(nativeThreadId),
          nativeConversationHeadRef: null,
          status: externalRunActive ? "active" : "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const hydrated = yield* historyMessages(appThreadId, binding, history);
        const state: HermesThreadState = {
          binding,
          liveSessionId,
          lease,
          titleRevision: binding.titleRevision,
          title: null,
          providerThread,
          activeTurn: null,
          externalRunActive,
          externalEvents: [],
          externalContinuationRequested: false,
          externalRunId: null,
          settledRunId: null,
          ownershipLost: false,
          turns: new Map(),
          messages: new Map(hydrated.messages.map((message) => [String(message.id), message])),
          importedTurnItems: new Map(hydrated.turnItems.map((item) => [String(item.id), item])),
          runtimeRequests: new Map(),
        };
        const superseded = statesByProviderThread.get(String(providerThread.id));
        if (superseded !== undefined && superseded.liveSessionId !== liveSessionId) {
          statesByLiveSession.delete(superseded.liveSessionId);
        }
        statesByProviderThread.set(String(providerThread.id), state);
        statesByLiveSession.set(liveSessionId, state);
        if (externalRunActive) {
          yield* updateSession("running", null);
        }
        if (titleState !== undefined) {
          yield* reconcileTitle(state, titleState);
        }
        return providerThread;
      });

      const resumeBinding = Effect.fnUntraced(function* (
        binding: HermesSessionBinding,
        threadInput: ProviderAdapterV2EnsureThreadInput,
      ) {
        const lease = yield* acquireLease(binding);
        const operationId = `hermes:resume:${binding.bindingId}:g${lease.generation}`;
        const temporaryState = {
          binding,
          lease,
        } satisfies HermesMutationFence;
        const prepared = yield* prepareBoundMutation(temporaryState, {
          operationId,
          mutationKind: "session_resume",
          method: "session.resume",
          payloadDigest: stableDigest(binding.storedSessionKey, binding.profileKey),
        });
        // The durable session key lives in the profile database the binding
        // was discovered under, so resume targets the binding's profile.
        const resumeParams = {
          session_id: binding.storedSessionKey,
          profile: binding.profileKey,
          source: "t3-code",
          close_on_disconnect: false,
        } satisfies HermesGatewaySessionResumeParams;
        const resumed = yield* (
          prepared.replay
            ? gatewayEffect(() =>
                client.resumeSession(resumeParams, mutationOptions(operationId)),
              ).pipe(
                Effect.tap(() =>
                  transitionIntent(
                    temporaryState,
                    operationId,
                    prepared.intentState,
                    prepared.intentState === "admitted" ? "confirmed" : "reconciled",
                  ),
                ),
              )
            : settleMutation(temporaryState, operationId, () =>
                client.resumeSession(resumeParams, mutationOptions(operationId)),
              )
        ).pipe(
          Effect.mapError((cause) =>
            isStoredSessionNotFound(cause)
              ? new HermesImportedSessionUnavailableError({
                  storedSessionKey: binding.storedSessionKey,
                  profileKey: binding.profileKey,
                  cause,
                })
              : cause,
          ),
        );
        // Hermes revokes an ephemeral MCP lease as part of session.resume.
        mcpCredentialByLiveSession.delete(resumed.session_id);
        yield* ensureSessionMcp(resumed.session_id, threadInput.threadId);
        const authoritativeStatus = yield* gatewayEffect(() =>
          client.readSessionStatus({
            session_id: resumed.session_id,
            profile: binding.profileKey,
          }),
        );
        const history = yield* gatewayEffect(() =>
          client.readSessionHistory({
            session_id: resumed.session_id,
            profile: binding.profileKey,
          }),
        );
        const titleState = yield* readTitleState(resumed.session_id);
        const recoveredWork =
          resumed.running ||
          hasRecoveredWork(resumed.inflight) ||
          hasRecoveredWork(resumed.queued) ||
          isActiveHermesStatus(resumed.status);
        const authoritativeRuntimeStatus = hermesSessionRuntimeStatus(authoritativeStatus);
        const externalRunActive = isTerminalHermesStatus(authoritativeRuntimeStatus)
          ? false
          : recoveredWork || isActiveHermesStatus(authoritativeRuntimeStatus);
        const registered = yield* registerState(
          binding,
          resumed.session_id,
          lease,
          threadInput.threadId,
          history,
          externalRunActive,
          titleState,
        );
        // This is the first bind after a restart, so any prompt intent still
        // open belongs to a process that is gone. Repair it here, while the
        // authoritative status is in hand, instead of letting the next prompt
        // discover it.
        const state = statesByProviderThread.get(String(registered.id));
        if (state !== undefined && !externalRunActive) {
          yield* sweepStrandedPromptIntents(state).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("orchestration-v2.hermes-stranded-prompt-sweep-failed", {
                bindingId: binding.bindingId,
                cause,
              }),
            ),
            Effect.ignore,
          );
        }
        return registered;
      });

      const createBinding = Effect.fnUntraced(function* (
        threadInput: ProviderAdapterV2EnsureThreadInput,
      ) {
        const operationId = `hermes:create:${options.instanceId}:${threadInput.threadId}`;
        const now = DateTime.formatIso(yield* DateTime.now);
        const payloadDigest = stableDigest(
          options.instanceId,
          options.settings.profileKey,
          threadInput.threadId,
          threadInput.runtimePolicy.cwd,
          threadInput.modelSelection.model,
        );
        const prepared = yield* options.repository.prepareSessionCreateIntent({
          operationId,
          providerInstanceId: options.instanceId,
          profileKey: options.settings.profileKey,
          projectId: String(threadInput.threadId),
          threadId: String(threadInput.threadId),
          method: "session.create",
          payloadDigest,
          now,
        });
        let replay = false;
        if (prepared.status === "prepared") {
          const admitted = yield* options.repository.transitionSessionCreateIntent({
            operationId,
            from: "prepared",
            to: "admitted",
            now,
          });
          if (!admitted) {
            return yield* new ProviderAdapterProtocolError({
              driver: HERMES_PROVIDER,
              detail: "Hermes session.create intent could not be admitted",
            });
          }
        } else if (prepared.status === "operation_exists") {
          const outcome = yield* reconcileIntent(prepared.intent, {
            bindingId: null,
            mutationKind: "session_create",
            method: "session.create",
            payloadDigest,
          });
          if (outcome.mutation_status === "indeterminate") {
            if (prepared.intent.state === "prepared" || prepared.intent.state === "admitted") {
              yield* options.repository.transitionSessionCreateIntent({
                operationId,
                from: prepared.intent.state,
                to: "indeterminate",
                now,
              });
            }
            return yield* new ProviderAdapterProtocolError({
              driver: HERMES_PROVIDER,
              detail: `Hermes session.create remains indeterminate (${operationId})`,
            });
          }
          replay = true;
        } else {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: `Hermes session.create cannot be safely resubmitted (${prepared.status})`,
          });
        }
        const createParams = {
          profile: options.settings.profileKey,
          source: "t3-code",
          cwd: threadInput.runtimePolicy.cwd ?? providerSession.cwd,
          close_on_disconnect: false,
          // T3 persists this stored identity before the first prompt, so Hermes
          // must make the otherwise-lazy empty session resumable as well.
          persist_immediately: true,
          ...hermesModelOverride(threadInput.modelSelection.model),
          ...hermesReasoningOverride(threadInput.modelSelection),
          ...hermesFastOverride(threadInput.modelSelection),
        } satisfies HermesGatewaySessionCreateParams;
        const created = yield* gatewayEffect(() =>
          client.createSession(createParams, mutationOptions(operationId)),
        ).pipe(
          Effect.tapError((cause) =>
            replay
              ? Effect.void
              : options.repository
                  .transitionSessionCreateIntent({
                    operationId,
                    from: "admitted",
                    to: isIndeterminateGatewayCall(cause) ? "indeterminate" : "rejected",
                    now: DateTime.formatIso(DateTime.nowUnsafe()),
                  })
                  .pipe(Effect.ignore),
          ),
        );
        const existingIdentity = yield* options.repository.getByStoredIdentity({
          providerInstanceId: options.instanceId,
          profileKey: options.settings.profileKey,
          storedSessionKey: created.stored_session_id,
        });
        if (
          Option.isSome(existingIdentity) &&
          existingIdentity.value.threadId !== String(threadInput.threadId)
        ) {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: "Hermes stored session is already bound to another T3 thread",
          });
        }
        const bindingId = `hermes-binding:${stableDigest(
          options.instanceId,
          options.settings.profileKey,
          created.stored_session_id,
        )}`;
        const bindingCreatedAt = DateTime.formatIso(yield* DateTime.now);
        const inserted = yield* options.repository.createBinding({
          bindingId,
          providerInstanceId: options.instanceId,
          profileKey: options.settings.profileKey,
          projectId: String(threadInput.threadId),
          storedSessionKey: created.stored_session_id,
          threadId: String(threadInput.threadId),
          ...compatibilityFields(compatibility),
          reconciliationCursor: null,
          reconciliationFingerprint: null,
          now: bindingCreatedAt,
          createOperationId: operationId,
        });
        if (!inserted) {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: "Hermes binding creation conflicted with existing durable identity",
          });
        }
        const loaded = yield* options.repository.getByThreadId(String(threadInput.threadId));
        if (Option.isNone(loaded)) {
          return yield* new ProviderAdapterProtocolError({
            driver: HERMES_PROVIDER,
            detail: "Hermes binding was not readable after creation",
          });
        }
        const lease = yield* acquireLease(loaded.value);
        yield* ensureSessionMcp(created.session_id, threadInput.threadId);
        yield* gatewayEffect(() =>
          client.readSessionStatus({
            session_id: created.session_id,
            profile: options.settings.profileKey,
          }),
        );
        const history = yield* gatewayEffect(() =>
          client.readSessionHistory({
            session_id: created.session_id,
            profile: options.settings.profileKey,
          }),
        );
        const titleState = yield* readTitleState(created.session_id);
        return yield* registerState(
          loaded.value,
          created.session_id,
          lease,
          threadInput.threadId,
          history,
          false,
          titleState,
        );
      });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          unsubscribe();
          // A Hermes session outlives the T3 process that was driving it. T3
          // cancels its own pending requests when the server restarts, but the
          // gateway keeps the run parked on the decision until someone answers
          // it, and after a restart nobody can: the request identity was live
          // only. Stop those runs on the way out so the session comes back idle
          // instead of blocked on a prompt with no reader.
          const blockedSessions = new Map<string, PendingHermesRuntimeRequest>();
          for (const pending of pendingRuntimeRequests.values()) {
            if (!blockedSessions.has(pending.state.liveSessionId)) {
              blockedSessions.set(pending.state.liveSessionId, pending);
            }
          }
          for (const pending of blockedSessions.values()) {
            yield* unblockGatewayRun(pending.state, `hermes:release:${pending.request.id}`);
          }
          pendingRuntimeRequests.clear();
          for (const [liveSessionId, credentialIdentity] of mcpCredentialByLiveSession) {
            const operationId = `hermes:mcp:revoke:${stableDigest(
              options.instanceId,
              liveSessionId,
              credentialIdentity,
            )}`;
            yield* gatewayEffect(() =>
              client.revokeSessionMcp(liveSessionId, mutationOptions(operationId)),
            ).pipe(Effect.ignore);
          }
          mcpCredentialByLiveSession.clear();
          for (const state of statesByProviderThread.values()) {
            const { now } = leaseTimes();
            yield* options.repository
              .releaseOwnerLease({
                bindingId: state.binding.bindingId,
                ownerKey: state.lease.ownerKey,
                generation: state.lease.generation,
                now,
              })
              .pipe(Effect.ignore);
          }
          client.close();
          yield* Queue.shutdown(events);
        }),
      );

      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: HERMES_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return providerSession;
        },
        events: Stream.fromEffectRepeat(Queue.take(events)),
        // Releasing the session while an external run is streaming would drop
        // the gateway subscription that feeds the continuation turn, so idle
        // release waits for the wake to be delivered.
        hasPendingBackgroundWork: Effect.sync(() =>
          [...statesByProviderThread.values()].some(
            (state) =>
              state.externalRunActive ||
              state.externalContinuationRequested ||
              state.externalEvents.length > 0,
          ),
        ),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            if (threadInput.existingProviderThread !== undefined) {
              return yield* runtime.resumeThread({
                providerThread: threadInput.existingProviderThread,
                threadId: threadInput.threadId,
                modelSelection: threadInput.modelSelection,
                runtimePolicy: threadInput.runtimePolicy,
              });
            }
            const existing = yield* options.repository.getByThreadId(String(threadInput.threadId));
            return Option.isSome(existing)
              ? yield* resumeBinding(existing.value, threadInput)
              : yield* createBinding(threadInput);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterEnsureThreadError({
                  driver: HERMES_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          Effect.gen(function* () {
            const existingState = stateForProviderThread(threadInput.providerThread);
            if (existingState !== undefined) {
              const appThreadId =
                threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId;
              yield* ensureSessionMcp(existingState.liveSessionId, appThreadId);
              return alignStateProviderThread(existingState, threadInput.providerThread);
            }
            const appThreadId =
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId;
            const binding = yield* options.repository.getByThreadId(String(appThreadId));
            if (Option.isNone(binding)) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: `No Hermes binding exists for thread ${appThreadId}`,
              });
            }
            const resumedThread = yield* resumeBinding(binding.value, {
              threadId: appThreadId,
              modelSelection: threadInput.modelSelection ?? input.modelSelection,
              runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
              existingProviderThread: threadInput.providerThread,
            });
            const resumedState = stateForProviderThread(resumedThread);
            return resumedState === undefined
              ? resumedThread
              : alignStateProviderThread(resumedState, threadInput.providerThread);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterResumeThreadError({
                  driver: HERMES_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const requestedModel = hermesModelOverride(turnInput.modelSelection.model).model;
            const state = stateForProviderThread(turnInput.providerThread);
            if (state === undefined) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: `Hermes provider thread ${turnInput.providerThread.id} is not resumed`,
              });
            }
            if (state.activeTurn !== null) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes does not support queued or steered prompts",
              });
            }
            if (state.ownershipLost) {
              // Ownership is lost when a terminal settlement could not hold the
              // lease fence, which a lapse causes as readily as a competing
              // owner does. The flag is per-process and nothing else clears it,
              // so without this retake the thread stays unusable until T3 is
              // restarted. Retaking fails only while someone else holds a live
              // lease, which is the one case worth refusing.
              if (!(yield* retakeLease(state))) {
                return yield* new ProviderAdapterProtocolError({
                  driver: HERMES_PROVIDER,
                  detail:
                    "Another Hermes client owns this session right now, so T3 cannot prompt it. Close it there, then try again",
                });
              }
              state.ownershipLost = false;
              yield* sweepStrandedPromptIntents(state).pipe(Effect.ignore);
            }
            // An adapter-buffered wake attaches to the external run instead of
            // prompting, so it deliberately runs before the guard that rejects
            // prompts while such a run is in flight.
            if (isHermesProviderContinuationTurn(turnInput)) {
              return yield* startExternalContinuationTurn(state, turnInput);
            }
            if (state.externalRunActive) {
              const authoritative = yield* gatewayEffect(() =>
                client.readSessionStatus({
                  session_id: state.liveSessionId,
                  profile: options.settings.profileKey,
                }),
              );
              yield* settleExternalRun(state, hermesSessionRuntimeStatus(authoritative));
              if (state.externalRunActive) {
                return yield* new ProviderAdapterProtocolError({
                  driver: HERMES_PROVIDER,
                  detail: "Hermes has a recovered external run in progress",
                });
              }
            }
            if (requestedModel !== undefined && requestedModel !== providerSession.model) {
              yield* applySessionModelSwitch(state, turnInput, requestedModel);
            }
            alignStateProviderThread(state, turnInput.providerThread);
            const projectedTitle = turnInput.appThread.title.trim();
            if (
              client.hasCapability("session.title") &&
              projectedTitle &&
              projectedTitle !== state.title &&
              (turnInput.appThread.titleRevision ?? state.titleRevision) === state.titleRevision
            ) {
              const titleOperationId = `hermes:title:${state.binding.bindingId}:r${state.titleRevision + 1}:${stableDigest(projectedTitle).slice(0, 12)}`;
              const titleSyncResult = yield* Effect.gen(function* () {
                const preparedTitle = yield* prepareBoundMutation(state, {
                  operationId: titleOperationId,
                  mutationKind: "session_title",
                  method: "session.title",
                  payloadDigest: stableDigest(
                    state.binding.storedSessionKey,
                    projectedTitle,
                    "client:t3-code",
                  ),
                });
                const titleState = yield* preparedTitle.replay
                  ? gatewayEffect(() =>
                      client.updateSessionTitle(
                        {
                          session_id: state.liveSessionId,
                          title: projectedTitle,
                          origin: "client:t3-code",
                        },
                        mutationOptions(titleOperationId),
                      ),
                    ).pipe(
                      Effect.tap(() =>
                        transitionIntent(
                          state,
                          titleOperationId,
                          preparedTitle.intentState,
                          preparedTitle.intentState === "admitted" ? "confirmed" : "reconciled",
                        ),
                      ),
                    )
                  : settleMutation(state, titleOperationId, () =>
                      client.updateSessionTitle(
                        {
                          session_id: state.liveSessionId,
                          title: projectedTitle,
                          origin: "client:t3-code",
                        },
                        mutationOptions(titleOperationId),
                      ),
                    );
                yield* reconcileTitle(state, titleState);
              }).pipe(Effect.result);
              if (titleSyncResult._tag === "Failure") {
                yield* Effect.logWarning("Hermes title sync failed; continuing prompt", {
                  providerThreadId: state.providerThread.id,
                  operationId: titleOperationId,
                  cause: titleSyncResult.failure,
                });
              }
            }
            if (turnInput.message.attachments.length > 0 && !options.settings.attachmentsEnabled) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Attachments are disabled for this Hermes instance",
              });
            }
            if (turnInput.message.attachments.length > 0 && options.readAttachment === undefined) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes attachment storage is unavailable",
              });
            }
            const attachmentRefs = yield* Effect.forEach(
              turnInput.message.attachments,
              (attachment, attachmentOrdinal) =>
                Effect.gen(function* () {
                  const bytes = yield* options.readAttachment!(attachment);
                  const contentBase64 = Buffer.from(bytes).toString("base64");
                  if (attachment.type === "image") {
                    if (!client.hasCapability("attachments.image")) {
                      return yield* new ProviderAdapterProtocolError({
                        driver: HERMES_PROVIDER,
                        detail: "This Hermes gateway does not support image attachments",
                      });
                    }
                    yield* gatewayEffect(() =>
                      client.attachImageBytes(
                        {
                          session_id: state.liveSessionId,
                          content_base64: contentBase64,
                          filename: attachment.name,
                        },
                        mutationOptions(`hermes:image:${turnInput.attemptId}:${attachmentOrdinal}`),
                      ),
                    );
                    return null;
                  }
                  if (attachment.type === "pdf") {
                    if (!client.hasCapability("attachments.pdf")) {
                      return yield* new ProviderAdapterProtocolError({
                        driver: HERMES_PROVIDER,
                        detail: "This Hermes gateway does not support PDF attachments",
                      });
                    }
                    yield* gatewayEffect(() =>
                      client.attachPdf(
                        {
                          session_id: state.liveSessionId,
                          content_base64: contentBase64,
                          filename: attachment.name,
                        },
                        mutationOptions(`hermes:pdf:${turnInput.attemptId}:${attachmentOrdinal}`),
                      ),
                    );
                    return null;
                  }
                  if (!client.hasCapability("attachments.file")) {
                    return yield* new ProviderAdapterProtocolError({
                      driver: HERMES_PROVIDER,
                      detail: `This Hermes gateway does not support ${attachment.type === "video" ? "video" : "file"} attachments`,
                    });
                  }
                  const attachResult = yield* gatewayEffect(() =>
                    client.attachFile(
                      {
                        session_id: state.liveSessionId,
                        name: attachment.name,
                        data_url: `data:${attachment.mimeType};base64,${contentBase64}`,
                      },
                      mutationOptions(`hermes:file:${turnInput.attemptId}:${attachmentOrdinal}`),
                    ),
                  );
                  // The gateway stages the file and hands back a reference token
                  // (e.g. "@file:..."); the model only sees the file when that
                  // token is included in the prompt text.
                  const refText = hermesAttachmentRefText(attachResult);
                  if (refText === null) {
                    return yield* new ProviderAdapterProtocolError({
                      driver: HERMES_PROVIDER,
                      detail: `Hermes gateway staged "${attachment.name}" without returning a file reference`,
                    });
                  }
                  return refText;
                }),
              { concurrency: 1 },
            );
            const promptRefs = attachmentRefs.filter((ref): ref is string => ref !== null);
            // Hermes has no system/developer context channel, so the first
            // prompt of a thread carries the T3 orchestration and t3-html
            // embed instructions inline when the session-scoped MCP lease is
            // available.
            const promptBase = t3OrchestrationPromptForFirstRun({
              prompt: turnInput.message.text,
              runOrdinal: turnInput.runOrdinal,
              hasT3Mcp: mcpAvailable,
            });
            const promptText =
              promptRefs.length > 0 ? `${promptBase}\n\n${promptRefs.join("\n")}` : promptBase;
            const operationId = `hermes:prompt:${turnInput.attemptId}`;
            const prepared = yield* prepareBoundMutation(state, {
              operationId,
              mutationKind: "prompt",
              method: "prompt.submit",
              payloadDigest: stableDigest(
                state.binding.storedSessionKey,
                turnInput.message.text,
                turnInput.attemptId,
              ),
            });
            const completion = yield* Deferred.make<void>();
            const active: ActiveHermesTurn = {
              input: turnInput,
              operationId,
              completion,
              external: false,
              sourceRunId: null,
              bufferedEvents: [],
              providerTurn: null,
              assistantNativeId: null,
              assistantText: "",
              assistantSnapshotPending: false,
              assistantStartedAt: null,
              reasoningText: "",
              reasoningStartedAt: null,
              reasoningHasStreamedDelta: false,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              toolsByIdentity: new Map(),
              toolsByNativeId: new Map(),
              generatingToolsByName: new Map(),
              seenEventIds: new Set(),
              planId: null,
              gatewayRunId: null,
              pendingSteerCompletions: 0,
              interrupted: false,
              finalized: false,
              intentState: prepared.intentState,
            };
            state.activeTurn = active;
            const submitted = yield* gatewayEffect(() =>
              client.submitPrompt(
                {
                  session_id: state.liveSessionId,
                  text: promptText,
                },
                mutationOptions(operationId),
              ),
            ).pipe(
              Effect.tapError((cause) =>
                prepared.replay
                  ? Effect.void
                  : transitionIntent(
                      state,
                      operationId,
                      "admitted",
                      isIndeterminateGatewayCall(cause) ? "indeterminate" : "rejected",
                    ).pipe(Effect.ignore),
              ),
            );
            const terminalReplay = submitted.mutation_status === "completed";
            if (prepared.replay && prepared.intentState === "prepared" && !terminalReplay) {
              yield* transitionIntent(state, operationId, "prepared", "admitted");
              active.intentState = "admitted";
            }
            const nativeRunId =
              submitted.run_id ?? stableDigest(state.binding.storedSessionKey, operationId, "run");
            active.gatewayRunId = submitted.run_id ?? null;
            const startedAt = yield* DateTime.now;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: options.idAllocator.derive.providerTurn({
                driver: HERMES_PROVIDER,
                nativeTurnId: nativeRunId,
              }),
              providerThreadId: state.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(
                nativeRunId,
                submitted.run_id === undefined ? "weak" : "strong",
              ),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            active.providerTurn = providerTurn;
            active.assistantNativeId = submitted.assistant_message_id ?? null;
            state.turns.set(String(providerTurn.id), providerTurn);
            yield* emit({
              type: "provider_turn.updated",
              driver: HERMES_PROVIDER,
              threadId: turnInput.threadId,
              providerTurn,
            });
            yield* updateThread(state, {
              status: "active",
              firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
              lastRunOrdinal: turnInput.runOrdinal,
            });
            yield* updateSession("running", null);
            for (const buffered of active.bufferedEvents.splice(0)) {
              yield* handleGatewayEvent(buffered);
            }
            if (terminalReplay && !active.finalized) {
              if (submitted.status === "error") {
                yield* finalizeTurn(state, "failed", "Hermes reported a turn error.");
              } else {
                yield* finalizeTurn(
                  state,
                  submitted.status === "interrupted" ? "interrupted" : "completed",
                );
              }
            }
          }).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                const state = stateForProviderThread(turnInput.providerThread);
                if (state === undefined || state.activeTurn === null) return;
                if (state.activeTurn.providerTurn === null) {
                  state.activeTurn = null;
                  return;
                }
                yield* finalizeTurn(state, "failed", "Hermes turn start failed after submission.");
              }).pipe(Effect.ignore),
            ),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterTurnStartError({
                  driver: HERMES_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (steerInput) =>
          Effect.gen(function* () {
            const state = stateForProviderThread(steerInput.providerThread);
            const active = state?.activeTurn;
            if (state === undefined || active == null || active.providerTurn === null) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes provider turn is not active",
              });
            }
            if (String(active.providerTurn.id) !== String(steerInput.providerTurnId)) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes steering targets a provider turn that is no longer active",
              });
            }
            const operationId = `hermes:steer:${steerInput.message.messageId}`;
            // mutationKind "steer", not "prompt": the turn's own prompt
            // intent is still unsettled while the run streams, and prompt
            // intents are exclusive per binding.
            const prepared = yield* prepareBoundMutation(state, {
              operationId,
              mutationKind: "steer",
              method: "prompt.submit",
              payloadDigest: stableDigest(
                state.binding.storedSessionKey,
                steerInput.message.text,
                operationId,
              ),
            });
            const submit = () =>
              client.submitPrompt(
                {
                  session_id: state.liveSessionId,
                  text: steerInput.message.text,
                },
                mutationOptions(operationId),
              );
            const submitted = prepared.replay
              ? yield* gatewayEffect(submit).pipe(
                  Effect.tap(() =>
                    transitionIntent(
                      state,
                      operationId,
                      prepared.intentState,
                      prepared.intentState === "admitted" ? "confirmed" : "reconciled",
                    ),
                  ),
                )
              : yield* settleMutation(state, operationId, submit);
            if (submitted.mutation_status === "completed") {
              // Historical replay: the steering prompt already ran to
              // completion in a previous owner generation.
              return;
            }
            if (submitted.status === "queued") {
              // Hermes runs the steered prompt as a follow-up run on the
              // same session; keep this provider turn open across the
              // current run's completion so both runs project into it.
              active.pendingSteerCompletions += 1;
            } else if (
              submitted.run_id !== undefined &&
              active.gatewayRunId !== null &&
              submitted.run_id !== active.gatewayRunId
            ) {
              // The prompt was merged into (or redirected to) a different
              // gateway run; follow it so its events are not filtered out.
              active.gatewayRunId = submitted.run_id;
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterSteerRunError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: steerInput.providerThread.id,
                  providerTurnId: steerInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const state = stateForProviderThread(interruptInput.providerThread);
            const active = state?.activeTurn;
            if (state === undefined || active == null || active.providerTurn === null) {
              // The turn already terminalized (or never started); treat the
              // interrupt as satisfied so stop is idempotent instead of
              // failing a race against normal completion.
              yield* Effect.logDebug("Hermes interrupt found no active turn; treating as done.", {
                providerThreadId: String(interruptInput.providerThread.id),
                providerTurnId: String(interruptInput.providerTurnId),
              });
              return;
            }
            const operationId = `hermes:interrupt:${interruptInput.providerTurnId}`;
            const prepared = yield* prepareBoundMutation(state, {
              operationId,
              mutationKind: "interrupt",
              method: "session.interrupt",
              payloadDigest: stableDigest(
                state.binding.storedSessionKey,
                interruptInput.providerTurnId,
              ),
            });
            active.interrupted = true;
            if (prepared.replay) {
              yield* gatewayEffect(() =>
                client.interruptSession(
                  { session_id: state.liveSessionId },
                  mutationOptions(operationId),
                ),
              ).pipe(
                Effect.tap(() =>
                  transitionIntent(
                    state,
                    operationId,
                    prepared.intentState,
                    prepared.intentState === "admitted" ? "confirmed" : "reconciled",
                  ),
                ),
              );
            } else {
              yield* settleMutation(state, operationId, () =>
                client.interruptSession(
                  { session_id: state.liveSessionId },
                  mutationOptions(operationId),
                ),
              );
            }
            const terminal = yield* Deferred.await(active.completion).pipe(
              Effect.timeoutOption(INTERRUPT_TERMINAL_TIMEOUT),
            );
            if (Option.isNone(terminal)) {
              // The gateway accepted the interrupt but never pushed a
              // terminal event (e.g. the run is blocked on a pending
              // clarification). Finalize locally so the run cannot stay
              // running forever; finalizeTurn also cancels the turn's
              // pending runtime requests.
              yield* Effect.logWarning(
                "Hermes interrupt did not produce a terminal event; finalizing locally.",
                {
                  providerThreadId: String(state.providerThread.id),
                  providerTurnId: String(interruptInput.providerTurnId),
                },
              );
              yield* finalizeTurn(state, "interrupted");
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterInterruptError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.gen(function* () {
            const pending = pendingRuntimeRequests.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: `No pending Hermes runtime request ${requestInput.requestId}.`,
              });
            }
            const operationId = `hermes:runtime-response:${requestInput.requestId}`;
            if (!canRespondToRuntimeRequest[pending.kind]) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: hermesUnanswerableRuntimeRequestReason(pending.kind),
              });
            }
            if (pending.kind === "approval") {
              if (requestInput.decision === undefined) {
                return yield* new ProviderAdapterProtocolError({
                  driver: HERMES_PROVIDER,
                  detail: `Hermes approval ${requestInput.requestId} requires a decision.`,
                });
              }
              // `approval.respond` names a session, not a request: the pinned
              // protocol carries no approval request id. With one outstanding
              // approval that is unambiguous, with two it is a coin flip, so
              // refuse rather than resolve the wrong command.
              const outstanding = [...pendingRuntimeRequests.values()].filter(
                (candidate) => candidate.kind === "approval" && candidate.state === pending.state,
              );
              if (outstanding.length > 1) {
                return yield* new ProviderAdapterProtocolError({
                  driver: HERMES_PROVIDER,
                  detail: `Hermes has ${outstanding.length} approvals outstanding on this session and approval.respond carries no request id, so T3 cannot target ${requestInput.requestId}. Interrupt the run instead.`,
                });
              }
              const result = yield* gatewayEffect(() =>
                client.respondToApproval(
                  {
                    session_id: pending.state.liveSessionId,
                    choice: hermesApprovalChoice(requestInput.decision!),
                  },
                  mutationOptions(operationId),
                ),
              );
              if (!result.resolved) {
                return yield* new ProviderAdapterProtocolError({
                  driver: HERMES_PROVIDER,
                  detail:
                    "Hermes no longer has a live approval for this session; the response was not applied.",
                });
              }
            } else {
              if (requestInput.answers === undefined || pending.nativeRequestId === undefined) {
                return yield* new ProviderAdapterProtocolError({
                  driver: HERMES_PROVIDER,
                  detail: `Hermes clarification ${requestInput.requestId} requires an answer.`,
                });
              }
              const answer = hermesClarificationAnswer(
                requestInput.answers,
                pending.questionId ?? pending.nativeRequestId,
              );
              if (answer === undefined) {
                return yield* new ProviderAdapterProtocolError({
                  driver: HERMES_PROVIDER,
                  detail: `Hermes clarification ${requestInput.requestId} received no usable answer.`,
                });
              }
              const result = yield* gatewayEffect(() =>
                client.respondToClarification(
                  { request_id: pending.nativeRequestId!, answer },
                  mutationOptions(operationId),
                ),
              );
              if (result.status === "expired") {
                yield* settleRuntimeRequest(pending, "cancelled");
                return;
              }
            }
            yield* settleRuntimeRequest(pending, "resolved");
            yield* updateSession("running", null);
          }).pipe(
            Effect.mapError((cause) =>
              isProviderAdapterRuntimeRequestResponseError(cause)
                ? cause
                : new ProviderAdapterRuntimeRequestResponseError({
                    driver: HERMES_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
            ),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.gen(function* () {
            const state = stateForProviderThread(snapshotInput.providerThread);
            if (state === undefined) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes thread must be resumed before reading its snapshot",
              });
            }
            yield* gatewayEffect(() =>
              client.readSessionStatus({
                session_id: state.liveSessionId,
                profile: state.binding.profileKey,
              }),
            );
            const history = yield* gatewayEffect(() =>
              client.readSessionHistory({
                session_id: state.liveSessionId,
                profile: state.binding.profileKey,
              }),
            );
            const hydrated = yield* historyMessages(
              state.providerThread.appThreadId ?? input.threadId,
              state.binding,
              history,
            );
            // History rows lacking a message_id get digest-derived ids that
            // never match the ids of live-streamed T3 messages, so merging
            // them blindly duplicates every turn's text. Skip history rows
            // whose content is already represented by a live message,
            // consuming one live occurrence per skipped row so repeated
            // identical messages still hydrate proportionally.
            const hydratedIds = new Set(hydrated.messages.map((message) => String(message.id)));
            const liveTextBudget = new Map<string, number>();
            for (const message of state.messages.values()) {
              if (hydratedIds.has(String(message.id))) continue;
              const key = `${message.role}\n${message.text}`;
              liveTextBudget.set(key, (liveTextBudget.get(key) ?? 0) + 1);
            }
            for (const message of hydrated.messages) {
              if (!state.messages.has(String(message.id))) {
                const key = `${message.role}\n${message.text}`;
                const budget = liveTextBudget.get(key) ?? 0;
                if (budget > 0) {
                  liveTextBudget.set(key, budget - 1);
                  continue;
                }
              }
              state.messages.set(String(message.id), message);
            }
            for (const item of hydrated.turnItems) {
              state.importedTurnItems.set(String(item.id), item);
            }
            return {
              providerThread: state.providerThread,
              providerTurns: [...state.turns.values()],
              messages: [...state.messages.values()],
              runtimeRequests: [...state.runtimeRequests.values()],
              turnItems: [...state.importedTurnItems.values()],
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterReadThreadSnapshotError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: snapshotInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (rollbackInput) =>
          new ProviderAdapterRollbackThreadError({
            driver: HERMES_PROVIDER,
            providerThreadId: rollbackInput.providerThread.id,
            checkpointId: rollbackInput.target.checkpointId,
            cause: new Error("Hermes rollback is not supported."),
          }),
        forkThread: (forkInput) =>
          Effect.gen(function* () {
            if (!client.hasCapability("session.branch.latest")) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "This Hermes gateway does not support latest-head native branches",
              });
            }
            const source = stateForProviderThread(forkInput.sourceProviderThread);
            if (source === undefined) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes source thread must be resumed before branching",
              });
            }
            if (source.activeTurn !== null || source.externalRunActive) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes can branch only from an idle latest transcript head",
              });
            }
            const existing = yield* options.repository.getByThreadId(
              String(forkInput.targetThreadId),
            );
            if (Option.isSome(existing)) {
              const resumed = yield* resumeBinding(existing.value, {
                threadId: forkInput.targetThreadId,
                modelSelection: forkInput.modelSelection ?? input.modelSelection,
                runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
              });
              const resumedState = stateForProviderThread(resumed);
              if (resumedState === undefined) return resumed;
              yield* updateThread(resumedState, {
                ownerNodeId: forkInput.ownerNodeId ?? null,
                forkedFrom: {
                  providerThreadId: forkInput.sourceProviderThread.id,
                  ...(forkInput.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: forkInput.providerTurnId }),
                },
              });
              return resumedState.providerThread;
            }

            const operationId = `hermes:branch:${source.binding.bindingId}:${forkInput.targetThreadId}`;
            const prepared = yield* prepareBoundMutation(source, {
              operationId,
              mutationKind: "session_branch",
              method: "session.branch",
              payloadDigest: stableDigest(
                source.binding.storedSessionKey,
                forkInput.targetThreadId,
                "latest_only",
              ),
            });
            const branched = prepared.replay
              ? yield* gatewayEffect(() =>
                  client.branchSession(
                    { session_id: source.liveSessionId },
                    mutationOptions(operationId),
                  ),
                ).pipe(
                  Effect.tap(() =>
                    transitionIntent(
                      source,
                      operationId,
                      prepared.intentState,
                      prepared.intentState === "admitted" ? "confirmed" : "reconciled",
                    ),
                  ),
                )
              : yield* settleMutation(source, operationId, () =>
                  client.branchSession(
                    { session_id: source.liveSessionId },
                    mutationOptions(operationId),
                  ),
                );
            if (
              branched.parent !== source.binding.storedSessionKey ||
              branched.boundary.mode !== "latest_only" ||
              branched.boundary.exact !== false
            ) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes returned an unsupported branch boundary",
              });
            }
            const bindingId = `hermes-binding:${stableDigest(
              options.instanceId,
              options.settings.profileKey,
              branched.stored_session_id,
            )}`;
            const now = DateTime.formatIso(yield* DateTime.now);
            const inserted = yield* options.repository.createBinding({
              bindingId,
              providerInstanceId: options.instanceId,
              profileKey: options.settings.profileKey,
              projectId: String(forkInput.targetThreadId),
              storedSessionKey: branched.stored_session_id,
              threadId: String(forkInput.targetThreadId),
              ...compatibilityFields(compatibility),
              reconciliationCursor: null,
              reconciliationFingerprint: null,
              parentBindingId: source.binding.bindingId,
              branchBoundaryMode: branched.boundary.mode,
              branchBoundaryMessageId: branched.boundary.message_id,
              branchBoundaryMessageCount: branched.boundary.message_count,
              now,
            });
            if (!inserted) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes child binding conflicted with an existing durable identity",
              });
            }
            const childBinding = yield* options.repository.getByThreadId(
              String(forkInput.targetThreadId),
            );
            if (Option.isNone(childBinding)) {
              return yield* new ProviderAdapterProtocolError({
                driver: HERMES_PROVIDER,
                detail: "Hermes child binding was not readable after native branching",
              });
            }
            const lease = yield* acquireLease(childBinding.value);
            yield* ensureSessionMcp(branched.session_id, forkInput.targetThreadId);
            const history = yield* gatewayEffect(() =>
              client.readSessionHistory({
                session_id: branched.session_id,
                profile: options.settings.profileKey,
              }),
            );
            const titleState = yield* readTitleState(branched.session_id);
            const child = yield* registerState(
              childBinding.value,
              branched.session_id,
              lease,
              forkInput.targetThreadId,
              history,
              false,
              titleState,
            );
            const childState = stateForProviderThread(child);
            if (childState === undefined) return child;
            yield* updateThread(childState, {
              ownerNodeId: forkInput.ownerNodeId ?? null,
              forkedFrom: {
                providerThreadId: forkInput.sourceProviderThread.id,
                ...(forkInput.providerTurnId === undefined
                  ? {}
                  : { providerTurnId: forkInput.providerTurnId }),
              },
            });
            return childState.providerThread;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterForkThreadError({
                  driver: HERMES_PROVIDER,
                  providerThreadId: forkInput.sourceProviderThread.id,
                  cause,
                }),
            ),
          ),
      };
      return runtime;
    }),
  };
}

export type HermesServeAdapterV2DriverEnv =
  | FileSystem.FileSystem
  | IdAllocatorV2
  | HermesSessionBindingRepository
  | ServerConfig;

export const makeHermesServeAdapterV2Driver = Effect.fn("makeHermesServeAdapterV2Driver")(
  function* (
    input: ProviderAdapterDriverCreateInput<HermesSettings>,
    options: { readonly connectionRuntime?: HermesServeRuntimeShape } = {},
  ) {
    const idAllocator = yield* IdAllocatorV2;
    const repository = yield* HermesSessionBindingRepository;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const hostPlatform = yield* HostProcessPlatform;
    const continuationRequests = yield* ProviderContinuationRequests;
    const configuredHermesHome = input.environment.find(
      (variable) => variable.name === "HERMES_HOME" && variable.value.trim().length > 0,
    )?.value;
    const configuredMediaRoots = input.environment
      .find(
        (variable) =>
          variable.name === "HERMES_MEDIA_ALLOW_DIRS" && variable.value.trim().length > 0,
      )
      ?.value.split(hostPlatform === "win32" ? ";" : ":")
      .flatMap((chunk) => chunk.split(","))
      .map((root) => root.trim())
      .filter(Boolean);
    const approvedHistoryMediaRoots = hermesHistoryMediaRoots({
      hermesHome: configuredHermesHome ?? process.env.HERMES_HOME,
      profileKey: input.config.profileKey,
      extraRoots: configuredMediaRoots,
    });
    const token = resolveHermesGatewayToken(input.environment);
    return makeHermesServeAdapterV2({
      instanceId: input.instanceId,
      settings: input.config,
      enabled: input.enabled,
      authToken: token,
      remotePairingToken: resolveHermesRemotePairingToken(input.environment),
      remoteTlsCertificateSha256: resolveHermesRemoteTlsCertificateSha256(input.environment),
      ...(options.connectionRuntime === undefined
        ? {}
        : { connectionRuntime: options.connectionRuntime }),
      idAllocator,
      repository,
      continuationRequests,
      readAttachment: (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (attachmentPath === null) {
            return yield* new ProviderAdapterProtocolError({
              driver: HERMES_PROVIDER,
              detail: `Invalid Hermes attachment id '${attachment.id}'`,
            });
          }
          return yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProtocolError({
                  driver: HERMES_PROVIDER,
                  detail: `Failed to read Hermes attachment '${attachment.id}'`,
                  payload: cause,
                }),
            ),
          );
        }),
      resolveHistoryMedia: ({ sourcePath, expectedKind, threadId, stableKey }) =>
        persistHermesHistoryMedia({
          sourcePath,
          expectedKind,
          approvedRoots: approvedHistoryMediaRoots,
          attachmentsDir: serverConfig.attachmentsDir,
          threadId,
          stableKey,
        }),
    });
  },
);

export const HermesServeAdapterV2Driver: ProviderAdapterDriver<
  HermesSettings,
  HermesServeAdapterV2DriverEnv
> = {
  driverKind: HERMES_DRIVER_KIND,
  configSchema: HermesSettings,
  defaultConfig: () => DEFAULT_HERMES_SETTINGS,
  create: Effect.fn("HermesServeAdapterV2Driver.create")(
    (input: ProviderAdapterDriverCreateInput<HermesSettings>) =>
      makeHermesServeAdapterV2Driver(input),
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: HERMES_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Hermes adapter.",
              cause,
            }),
        ),
      ),
  ),
};
