import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type HermesGatewayCompatibility,
  type HermesGatewayInterruptResult,
  type HermesGatewayMutationStatusResult,
  type HermesGatewayPromptSubmitParams,
  type HermesGatewayPromptSubmitResult,
  type HermesGatewaySessionCreateParams,
  type HermesGatewaySessionCreateResult,
  type HermesGatewaySessionHistoryResult,
  type HermesGatewaySessionMcpParams,
  type HermesGatewaySessionResumeParams,
  type HermesGatewaySessionResumeResult,
  type HermesGatewaySessionStatusResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  HermesGatewayMutationIndeterminateError,
  HermesGatewayRpcError,
  type HermesGatewayMutationOptions,
  type HermesGatewayOrderedEvent,
} from "../../hermes/HermesGatewayClient.ts";
import {
  HermesSessionBindingRepository,
  layer as HermesSessionBindingRepositoryLayer,
} from "../../hermes/HermesSessionBindingRepository.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { IdAllocatorV2, layer as IdAllocatorV2Layer } from "../IdAllocator.ts";
import type { ProviderAdapterV2TurnInput } from "../ProviderAdapter.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import {
  diagnoseHermesMcpIntegration,
  HERMES_EXTERNAL_EVENT_BUFFER_LIMIT,
  HERMES_EXTERNAL_RUN_CONTINUATION_DETAIL,
  HermesImportedSessionUnavailableError,
  HermesProviderCapabilitiesV2,
  hermesWireMutationId,
  makeHermesServeAdapterV2,
  sanitizeHermesToolValue,
  type HermesGatewayClientLike,
} from "./HermesServeAdapterV2.ts";

it("does not advertise Git checkpointing for DM-like Hermes sessions", () => {
  assert.isFalse(HermesProviderCapabilitiesV2.checkpointing.appCanCheckpointFilesystem);
  assert.isFalse(HermesProviderCapabilitiesV2.checkpointing.supportsNestedCheckpointScopes);
});

const compatibility: HermesGatewayCompatibility = {
  status: "supported",
  protocol: {
    major: 1,
    minor: 0,
    capabilities: ["mutation.stable_ids"],
  },
  capabilities: [
    "session.lifecycle",
    "session.history",
    "turn.prompt",
    "turn.interrupt",
    "attachments.image",
    "attachments.file",
    "attachments.pdf",
    "mutation.stable_ids",
  ],
  inventory: ["mutation.stable_ids"],
  reason: "test",
};

/** The pinned gateway does not advertise these; only a richer one negotiates them. */
const answering = (...capabilities: ReadonlyArray<string>): HermesGatewayCompatibility => ({
  ...compatibility,
  capabilities: [...compatibility.capabilities, ...capabilities],
});

class FakeHermesGatewayClient implements HermesGatewayClientLike {
  compatibility: HermesGatewayCompatibility | undefined = compatibility;
  readonly creates: Array<{
    readonly params: HermesGatewaySessionCreateParams;
    readonly options: Omit<HermesGatewayMutationOptions, "requiredCapability">;
  }> = [];
  readonly resumes: Array<{
    readonly params: HermesGatewaySessionResumeParams & { readonly model?: string };
    readonly options: Omit<HermesGatewayMutationOptions, "requiredCapability">;
  }> = [];
  readonly prompts: Array<{
    readonly params: HermesGatewayPromptSubmitParams;
    readonly options: Omit<HermesGatewayMutationOptions, "requiredCapability">;
  }> = [];
  readonly mcpReplacements: Array<HermesGatewaySessionMcpParams> = [];
  readonly mcpRevocations: Array<string> = [];
  readonly titleReads: Array<string> = [];
  readonly titleUpdates: Array<string> = [];
  mcpReplacementResult: {
    readonly scopeSessionId?: string;
    readonly serverName?: string;
    readonly toolNames?: Array<string>;
  } = {};
  readonly imageAttachments: Array<{
    readonly params: {
      readonly session_id: string;
      readonly content_base64: string;
      readonly filename?: string;
    };
    readonly options: Omit<HermesGatewayMutationOptions, "requiredCapability">;
  }> = [];
  readonly fileAttachments: Array<{
    readonly params: {
      readonly session_id: string;
      readonly name: string;
      readonly data_url: string;
    };
    readonly options: Omit<HermesGatewayMutationOptions, "requiredCapability">;
  }> = [];
  readonly pdfAttachments: Array<{
    readonly params: {
      readonly session_id: string;
      readonly filename: string;
      readonly content_base64: string;
    };
    readonly options: Omit<HermesGatewayMutationOptions, "requiredCapability">;
  }> = [];
  readonly interrupts: Array<Omit<HermesGatewayMutationOptions, "requiredCapability">> = [];
  readonly listeners = new Set<(event: HermesGatewayOrderedEvent) => void | Promise<void>>();
  history: HermesGatewaySessionHistoryResult = { count: 0, messages: [] };
  statusOutput = "idle";
  resumeRunning = false;
  resumeInflight: unknown = undefined;
  resumeQueued: unknown = undefined;
  resumeStatus = "idle";
  mutationStatus: HermesGatewayMutationStatusResult = { mutation_status: "completed" };
  readonly reconciliations: Array<string> = [];
  readonly reconciliationMutationIds: Array<string> = [];
  createError: Error | null = null;
  resumeError: Error | null = null;
  titleError: Error | null = null;
  promptError: Error | null = null;
  promptResult: HermesGatewayPromptSubmitResult | null = null;
  closeCount = 0;
  connectError: Error | null = null;
  private transportSequence = 0;

  async connect(): Promise<HermesGatewayCompatibility> {
    if (this.connectError) throw this.connectError;
    return this.compatibility ?? compatibility;
  }

  hasCapability(capability: string): boolean {
    return (this.compatibility ?? compatibility).capabilities.includes(capability);
  }

  onEvent(listener: (event: HermesGatewayOrderedEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createSession(
    params: HermesGatewaySessionCreateParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionCreateResult> {
    this.creates.push({ params, options });
    if (this.createError) throw this.createError;
    const createOrdinal = this.creates.length;
    return {
      session_id: `live-create-${createOrdinal}`,
      stored_session_id: `stored-session-${createOrdinal}`,
      message_count: 0,
      messages: [],
      info: {},
    };
  }

  async resumeSession(
    params: HermesGatewaySessionResumeParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySessionResumeResult> {
    this.resumes.push({ params, options });
    if (this.resumeError) throw this.resumeError;
    return {
      session_id: "live-resume-1",
      resumed: params.session_id,
      message_count: this.history.count,
      messages: this.history.messages,
      info: {},
      ...(this.resumeInflight === undefined ? {} : { inflight: this.resumeInflight }),
      ...(this.resumeQueued === undefined ? {} : { queued: this.resumeQueued }),
      running: this.resumeRunning,
      session_key: params.session_id,
      started_at: 1,
      status: this.resumeStatus,
    };
  }

  async replaceSessionMcp(params: HermesGatewaySessionMcpParams) {
    this.mcpReplacements.push(params);
    return {
      lease_id: `lease-${this.mcpReplacements.length}`,
      generation: this.mcpReplacements.length,
      servers: [
        {
          name: this.mcpReplacementResult.serverName ?? "t3-code",
          runtime_name: "tui_session_fixture_t3_code",
        },
      ],
      tool_names: this.mcpReplacementResult.toolNames ?? [
        "mcp__tui_session_fixture_t3_code__delegate_task",
      ],
      scope: {
        session_id: this.mcpReplacementResult.scopeSessionId ?? params.session_id,
        session_key: "stored-session-1",
      },
      persisted: false as const,
      history_recorded: false as const,
    };
  }

  async revokeSessionMcp(sessionId: string) {
    this.mcpRevocations.push(sessionId);
    return {
      revoked: true,
      lease_id: "lease-1",
      persisted: false as const,
    };
  }

  async readSessionStatus(): Promise<HermesGatewaySessionStatusResult> {
    return { output: this.statusOutput };
  }

  async readSessionHistory(): Promise<HermesGatewaySessionHistoryResult> {
    return this.history;
  }

  async readSessionTitle(params: { readonly session_id: string }) {
    this.titleReads.push(params.session_id);
    return {
      session_key: "stored-session-1",
      title: "Hermes session",
      revision: 1,
      origin: "gateway",
    };
  }

  async updateSessionTitle(params: { readonly title: string }) {
    this.titleUpdates.push(params.title);
    if (this.titleError) throw this.titleError;
    return {
      session_key: "stored-session-1",
      title: params.title,
      revision: 2,
      origin: "t3",
    };
  }

  async branchSession(params: { readonly session_id: string }) {
    return {
      session_id: "live-branch-1",
      stored_session_id: "stored-branch-1",
      title: "Hermes branch",
      parent: params.session_id,
      boundary: {
        mode: "latest_only" as const,
        exact: false as const,
        message_id: "message-head",
        message_count: this.history.count,
      },
    };
  }

  async reconcileMutation(
    operationId: string,
    mutationId: string = operationId,
  ): Promise<HermesGatewayMutationStatusResult> {
    this.reconciliations.push(operationId);
    this.reconciliationMutationIds.push(mutationId);
    return this.mutationStatus;
  }

  async submitPrompt(
    params: HermesGatewayPromptSubmitParams,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayPromptSubmitResult> {
    this.prompts.push({ params, options });
    if (this.promptError) throw this.promptError;
    if (this.promptResult) return this.promptResult;
    return {
      status: "streaming",
      run_id: "hermes-run-1",
      user_message_id: "hermes-user-1",
      assistant_message_id: "hermes-assistant-1",
      mutation_id: options.mutationId,
    };
  }

  async attachImageBytes(
    params: {
      readonly session_id: string;
      readonly content_base64: string;
      readonly filename?: string;
    },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown> {
    this.imageAttachments.push({ params, options });
    return { attached: true };
  }

  readonly approvalResponses: Array<{
    readonly session_id: string;
    readonly choice: "once" | "session" | "deny";
  }> = [];

  async respondToApproval(
    params: { readonly session_id: string; readonly choice: "once" | "session" | "deny" },
    _options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ) {
    this.approvalResponses.push(params);
    return { resolved: true };
  }

  async respondToClarification(
    _params: { readonly request_id: string; readonly answer: string },
    _options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ) {
    return { status: "ok" as const };
  }

  async attachFile(
    params: { readonly session_id: string; readonly name: string; readonly data_url: string },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown> {
    this.fileAttachments.push({ params, options });
    return this.fileAttachOmitsRef
      ? { attached: true }
      : { attached: true, ref_text: `@file:${params.name}` };
  }

  fileAttachOmitsRef = false;

  async attachPdf(
    params: {
      readonly session_id: string;
      readonly filename: string;
      readonly content_base64: string;
    },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<unknown> {
    this.pdfAttachments.push({ params, options });
    return { attached: true };
  }

  interruptEmitsTerminal = true;

  async interruptSession(
    _params: { readonly session_id: string },
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayInterruptResult> {
    this.interrupts.push(options);
    if (this.interruptEmitsTerminal) {
      queueMicrotask(() => void this.emit("message.complete", { text: "partial" }));
    }
    return { status: "interrupted" };
  }

  close(): void {
    this.closeCount += 1;
  }

  async emit(
    type: string,
    payload?: unknown,
    overrides: Partial<HermesGatewayOrderedEvent> = {},
  ): Promise<void> {
    const event: HermesGatewayOrderedEvent = {
      transportSequence: ++this.transportSequence,
      sessionSequence: this.transportSequence,
      sessionId: "live-create-1",
      eventId: `event-${this.transportSequence}`,
      eventSequence: this.transportSequence,
      emittedAt: undefined,
      sessionKey: "stored-session-1",
      runId: "hermes-run-1",
      messageId: "hermes-assistant-1",
      cursor: this.transportSequence,
      mutationId: undefined,
      frame: {
        jsonrpc: "2.0",
        method: "event",
        params: {
          type,
          session_id: "live-create-1",
          payload,
          event_id: `event-${this.transportSequence}`,
          event_sequence: this.transportSequence,
          session_key: "stored-session-1",
          run_id: "hermes-run-1",
          message_id: "hermes-assistant-1",
        },
      },
      ...overrides,
    };
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

const TestLayer = Layer.mergeAll(
  IdAllocatorV2Layer,
  HermesSessionBindingRepositoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const instanceId = ProviderInstanceId.make("hermes_test");
const threadId = ThreadId.make("thread:hermes-test");
const projectId = ProjectId.make("project:hermes-test");
const providerSessionId = ProviderSessionId.make("provider-session:hermes-test");
const modelSelection = { instanceId, model: "default" } as const;
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/tmp/hermes-project",
} as const;

function appThread(): OrchestrationV2AppThread {
  const now = DateTime.nowUnsafe();
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Hermes test",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lastVisitedAt: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
}

function turnInput(providerThread: OrchestrationV2ProviderThread): ProviderAdapterV2TurnInput {
  return {
    appThread: appThread(),
    threadId,
    runId: RunId.make("run:hermes-test"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt:hermes-test"),
    rootNodeId: NodeId.make("node:hermes-root"),
    providerThread,
    message: {
      messageId: MessageId.make("message:hermes-user"),
      text: "hello Hermes",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  };
}

const makeRuntime = Effect.fnUntraced(function* (
  fake: FakeHermesGatewayClient,
  enabled = true,
  readAttachment?: (attachment: { readonly id: string }) => Effect.Effect<Uint8Array, never>,
  mcpEnabled = false,
  resolveHistoryMedia?: Parameters<typeof makeHermesServeAdapterV2>[0]["resolveHistoryMedia"],
  continuationRequests?: Parameters<typeof makeHermesServeAdapterV2>[0]["continuationRequests"],
  proactiveEnabled = false,
) {
  const idAllocator = yield* IdAllocatorV2;
  const repository = yield* HermesSessionBindingRepository;
  const adapter = makeHermesServeAdapterV2({
    instanceId,
    settings: {
      enabled: true,
      endpoint: "ws://127.0.0.1:9119/api/ws",
      remoteAccessEnabled: false,
      profileKey: "real-profile",
      managedServerEnabled: true,
      customModels: [],
      importEnabled: false,
      mcpEnabled,
      attachmentsEnabled: readAttachment !== undefined,
      proactiveEnabled,
      voiceEnabled: false,
    },
    enabled,
    authToken: "test-token",
    idAllocator,
    repository,
    ...(readAttachment === undefined ? {} : { readAttachment }),
    ...(resolveHistoryMedia === undefined ? {} : { resolveHistoryMedia }),
    ...(continuationRequests === undefined ? {} : { continuationRequests }),
    clientFactory: () => fake,
  });
  return yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection,
    runtimePolicy,
  });
});

describe("HermesServeAdapterV2", () => {
  it("requires the upstream ephemeral session MCP lease capability", () => {
    assert.deepEqual(diagnoseHermesMcpIntegration(compatibility), {
      status: "blocked_upstream",
      missingCapabilities: ["session_mcp"],
      reason:
        "Hermes MCP exposure is blocked: the negotiated gateway protocol does not advertise ephemeral per-session MCP leases.",
    });

    assert.deepEqual(
      diagnoseHermesMcpIntegration({
        ...compatibility,
        capabilities: [...compatibility.capabilities, "session_mcp"],
      }),
      {
        status: "ready",
        missingCapabilities: [],
        reason:
          "Hermes advertises ephemeral per-session MCP leases with replace and revoke support.",
      },
    );
  });

  it.effect("creates a durable binding and omits the default model override", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const repository = yield* HermesSessionBindingRepository;
        const binding = yield* repository.getByThreadId(String(threadId));

        assert.isTrue(Option.isSome(binding));
        assert.equal(
          Option.getOrNull(Option.map(binding, (value) => value.storedSessionKey)),
          "stored-session-1",
        );
        assert.equal(providerThread.nativeThreadRef?.strength, "strong");
        assert.notProperty(fake.creates[0]!.params, "model");
        assert.isTrue(fake.creates[0]!.params.persist_immediately);
        assert.equal(
          fake.creates[0]!.options.mutationId,
          hermesWireMutationId(fake.creates[0]!.options.operationId),
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "resumes an imported binding against its stored profile with historical timestamps",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = new FakeHermesGatewayClient();
          fake.history = { count: 1, messages: [{ role: "user", text: "imported hello" }] };
          const repository = yield* HermesSessionBindingRepository;
          yield* repository.createBinding({
            bindingId: "hermes-binding:test-imported",
            providerInstanceId: String(instanceId),
            profileKey: "imported-profile",
            projectId: String(threadId),
            storedSessionKey: "stored-imported-1",
            threadId: String(threadId),
            protocolClassification: "supported",
            protocolMajor: 1,
            protocolMinor: 0,
            capabilities: [],
            reconciliationCursor: null,
            reconciliationFingerprint: null,
            now: "2020-01-01T00:00:00.000Z",
          });
          const runtime = yield* makeRuntime(fake);
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const snapshot = yield* runtime.readThreadSnapshot({ providerThread });

          assert.lengthOf(fake.creates, 0);
          assert.equal(fake.resumes[0]!.params.session_id, "stored-imported-1");
          assert.equal(fake.resumes[0]!.params.profile, "imported-profile");
          const message = snapshot.messages.find((entry) => entry.text === "imported hello");
          assert.isDefined(message);
          assert.equal(
            DateTime.toEpochMillis(message!.createdAt),
            Date.parse("2020-01-01T00:00:00.000Z"),
          );
        }),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("degrades a vanished imported session into a typed read-only resume error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.resumeError = new HermesGatewayRpcError(4007, "session.resume", "fatal");
        const repository = yield* HermesSessionBindingRepository;
        yield* repository.createBinding({
          bindingId: "hermes-binding:test-vanished",
          providerInstanceId: String(instanceId),
          profileKey: "imported-profile",
          projectId: String(threadId),
          storedSessionKey: "stored-vanished-1",
          threadId: String(threadId),
          protocolClassification: "supported",
          protocolMajor: 1,
          protocolMinor: 0,
          capabilities: [],
          reconciliationCursor: null,
          reconciliationFingerprint: null,
          now: "2020-01-01T00:00:00.000Z",
        });
        const runtime = yield* makeRuntime(fake);

        const error = yield* Effect.flip(
          runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          }),
        );

        assert.equal(error._tag, "ProviderAdapterEnsureThreadError");
        assert.instanceOf(error.cause, HermesImportedSessionUnavailableError);
        const unavailable = error.cause as HermesImportedSessionUnavailableError;
        assert.include(unavailable.message, "4007");
        assert.include(unavailable.message, "read-only");
        assert.include(unavailable.message, "stored-vanished-1");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("replaces the live Hermes session MCP lease with the scoped T3 endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.compatibility = {
          ...compatibility,
          capabilities: [...compatibility.capabilities, "session_mcp"],
        };
        McpProviderSession.setMcpProviderSession({
          credentialId: "credential-hermes-test",
          environmentId: EnvironmentId.make("environment-hermes-test"),
          threadId,
          providerSessionId: "mcp-provider-session-hermes-test",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer scoped-hermes-token",
          capabilities: ["orchestration"],
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        const runtime = yield* makeRuntime(fake, true, undefined, true);
        yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        assert.isTrue(runtime.providerSession.capabilities.tools.supportsMcpTools);
        assert.deepEqual(fake.mcpReplacements, [
          {
            session_id: "live-create-1",
            servers: {
              "t3-code": {
                url: "http://127.0.0.1:43123/mcp",
                headers: { Authorization: "Bearer scoped-hermes-token" },
              },
            },
          },
        ]);
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("rejects an MCP lease that is not scoped to the live Hermes session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.compatibility = {
          ...compatibility,
          capabilities: [...compatibility.capabilities, "session_mcp"],
        };
        fake.mcpReplacementResult = { scopeSessionId: "different-live-session" };
        McpProviderSession.setMcpProviderSession({
          credentialId: "credential-hermes-wrong-scope",
          environmentId: EnvironmentId.make("environment-hermes-test"),
          threadId,
          providerSessionId: "mcp-provider-session-hermes-wrong-scope",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer scoped-hermes-token",
          capabilities: ["orchestration"],
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        const runtime = yield* makeRuntime(fake, true, undefined, true);

        const exit = yield* Effect.exit(
          runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          }),
        );

        assert.equal(exit._tag, "Failure");
        assert.equal(fake.mcpReplacements.length, 1);
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("creates and prompts without optional session.title and session_mcp capabilities", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        McpProviderSession.setMcpProviderSession({
          credentialId: "credential-hermes-degraded",
          environmentId: EnvironmentId.make("environment-hermes-test"),
          threadId,
          providerSessionId: "mcp-provider-session-hermes-degraded",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer scoped-hermes-token",
          capabilities: ["orchestration"],
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        const runtime = yield* makeRuntime(fake, true, undefined, true);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "response", status: "complete" }),
        );

        assert.equal(fake.creates.length, 1);
        assert.equal(fake.prompts.length, 1);
        assert.deepEqual(fake.titleReads, []);
        assert.deepEqual(fake.titleUpdates, []);
        assert.deepEqual(fake.mcpReplacements, []);
        assert.deepEqual(fake.mcpRevocations, []);
        assert.isFalse(runtime.providerSession.capabilities.tools.supportsMcpTools);
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("resumes and prompts without optional session.title and session_mcp capabilities", () =>
    Effect.gen(function* () {
      const createFake = new FakeHermesGatewayClient();
      const createdThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(createFake);
          return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );
      const resumeFake = new FakeHermesGatewayClient();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(resumeFake, true, undefined, true);
          const resumed = yield* runtime.resumeThread({
            providerThread: createdThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          yield* runtime.startTurn(turnInput(resumed));
          yield* Effect.promise(() =>
            resumeFake.emit(
              "message.complete",
              { text: "response", status: "complete" },
              {
                sessionId: "live-resume-1",
              },
            ),
          );

          assert.equal(resumeFake.resumes.length, 1);
          assert.equal(resumeFake.prompts.length, 1);
          assert.deepEqual(resumeFake.titleReads, []);
          assert.deepEqual(resumeFake.titleUpdates, []);
          assert.deepEqual(resumeFake.mcpReplacements, []);
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not duplicate live-streamed text when history lacks message ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "response", status: "complete" }),
        );
        fake.history = {
          count: 2,
          messages: [
            { role: "user", text: "hello Hermes" },
            { role: "assistant", text: "response" },
          ],
        };

        const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
        const assistantRows = snapshot.messages.filter(
          (message) => message.role === "assistant" && message.text === "response",
        );
        assert.equal(assistantRows.length, 1);
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("fails a fork with a typed error when session.branch.latest is not advertised", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        const exit = yield* Effect.exit(
          runtime.forkThread({
            sourceProviderThread: providerThread,
            targetThreadId: ThreadId.make("thread:hermes-test:fork"),
          }),
        );

        assert.equal(exit._tag, "Failure");
      }).pipe(Effect.provide(TestLayer)),
    ),
  );

  it.effect("creates a fresh Hermes context for every distinct T3 thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const secondThreadId = ThreadId.make("thread:hermes-test:2");
        const first = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const second = yield* runtime.ensureThread({
          threadId: secondThreadId,
          modelSelection,
          runtimePolicy,
        });
        const repository = yield* HermesSessionBindingRepository;
        const firstBinding = yield* repository.getByThreadId(String(threadId));
        const secondBinding = yield* repository.getByThreadId(String(secondThreadId));

        assert.equal(fake.creates.length, 2);
        assert.notEqual(first.id, second.id);
        assert.equal(
          Option.getOrNull(Option.map(firstBinding, (binding) => binding.storedSessionKey)),
          "stored-session-1",
        );
        assert.equal(
          Option.getOrNull(Option.map(secondBinding, (binding) => binding.storedSessionKey)),
          "stored-session-2",
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resumes by durable stored key and hydrates history", () =>
    Effect.gen(function* () {
      const createFake = new FakeHermesGatewayClient();
      const createdThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(createFake);
          return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );
      const resumeFake = new FakeHermesGatewayClient();
      const mediaPath = "/Users/maria/Downloads/history-render.png";
      resumeFake.history = {
        count: 1,
        messages: [
          {
            message_id: "history-1",
            role: "assistant",
            text: `from history\nMEDIA:${mediaPath}`,
          },
        ],
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(resumeFake, true, undefined, false, ({ sourcePath }) =>
            Effect.succeed(
              sourcePath === mediaPath
                ? {
                    type: "image" as const,
                    id: ChatAttachmentId.make("hermes-history-media"),
                    name: "history-render.png",
                    mimeType: "image/png",
                    sizeBytes: 128,
                  }
                : null,
            ),
          );
          const resumed = yield* runtime.resumeThread({
            providerThread: createdThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const snapshot = yield* runtime.readThreadSnapshot({ providerThread: resumed });

          assert.equal(resumeFake.resumes[0]!.params.session_id, "stored-session-1");
          assert.notProperty(resumeFake.resumes[0]!.params, "model");
          assert.deepEqual(
            snapshot.messages.map((message) => message.text),
            ["from history"],
          );
          assert.deepEqual(snapshot.messages[0]?.attachments, [
            {
              type: "image",
              id: "hermes-history-media",
              name: "history-render.png",
              mimeType: "image/png",
              sizeBytes: 128,
            },
          ]);
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("normalizes imported transport history with stable ordering and attachments", () =>
    Effect.gen(function* () {
      const createFake = new FakeHermesGatewayClient();
      const createdThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(createFake);
          return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );
      const repository = yield* HermesSessionBindingRepository;
      const now = "2026-07-26T12:00:00.000Z";
      const imported = yield* repository.prepareSessionImport({
        importId: "hermes-import:test-history",
        providerInstanceId: String(instanceId),
        profileKey: "real-profile",
        projectId: String(threadId),
        importKind: "session",
        storedSessionKey: "stored-session-1",
        threadId: String(threadId),
        now,
      });
      yield* repository.transitionSessionImport({
        importId: imported.importId,
        from: "prepared",
        to: "thread_created",
        now,
      });
      yield* repository.transitionSessionImport({
        importId: imported.importId,
        from: "thread_created",
        to: "completed",
        now,
      });

      const fake = new FakeHermesGatewayClient();
      fake.history = {
        count: 2,
        messages: [
          {
            message_id: "history-user",
            role: "user",
            text: [
              "[maria] rewrite better",
              "",
              "[Image attached at: /Users/maria/.hermes/cache/images/img_fixture.webp]",
              "[screenshot]",
            ].join("\n"),
          },
          { message_id: "history-assistant", role: "assistant", text: "Rewritten." },
        ],
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(fake, true, undefined, false, () =>
            Effect.succeed({
              type: "image",
              id: "thread-hermes-test-00000000-0000-0000-0000-000000000001",
              name: "img_fixture.webp",
              mimeType: "image/webp",
              sizeBytes: 12,
            }),
          );
          const resumed = yield* runtime.resumeThread({
            providerThread: createdThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const first = yield* runtime.readThreadSnapshot({ providerThread: resumed });
          const replay = yield* runtime.readThreadSnapshot({ providerThread: resumed });

          assert.deepEqual(
            first.messages.map((message) => [message.role, message.text]),
            [
              ["user", "rewrite better"],
              ["assistant", "Rewritten."],
            ],
          );
          assert.deepEqual(first.messages[0]?.attachments, [
            {
              type: "image",
              id: "thread-hermes-test-00000000-0000-0000-0000-000000000001",
              name: "img_fixture.webp",
              mimeType: "image/webp",
              sizeBytes: 12,
            },
          ]);
          assert.isBelow(
            DateTime.toEpochMillis(first.messages[0]!.createdAt),
            DateTime.toEpochMillis(first.messages[1]!.createdAt),
          );
          assert.deepEqual(
            replay.messages.map((message) => ({
              id: message.id,
              role: message.role,
              text: message.text,
              attachments: message.attachments,
              createdAt: DateTime.formatIso(message.createdAt),
            })),
            first.messages.map((message) => ({
              id: message.id,
              role: message.role,
              text: message.text,
              attachments: message.attachments,
              createdAt: DateTime.formatIso(message.createdAt),
            })),
          );
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("leaves the inherited boundary unrecorded while imported history reads empty", () =>
    Effect.gen(function* () {
      const createFake = new FakeHermesGatewayClient();
      const createdThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(createFake);
          return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );
      const repository = yield* HermesSessionBindingRepository;
      const now = "2026-07-26T12:00:00.000Z";
      const imported = yield* repository.prepareSessionImport({
        importId: "hermes-import:test-empty-boundary",
        providerInstanceId: String(instanceId),
        profileKey: "real-profile",
        projectId: String(threadId),
        importKind: "session",
        storedSessionKey: "stored-session-1",
        threadId: String(threadId),
        now,
      });
      yield* repository.transitionSessionImport({
        importId: imported.importId,
        from: "prepared",
        to: "thread_created",
        now,
      });
      yield* repository.transitionSessionImport({
        importId: imported.importId,
        from: "thread_created",
        to: "completed",
        now,
      });

      const fake = new FakeHermesGatewayClient();
      fake.history = { count: 0, messages: [] };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(fake);
          const resumed = yield* runtime.resumeThread({
            providerThread: createdThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const empty = yield* runtime.readThreadSnapshot({ providerThread: resumed });
          assert.deepEqual(empty.messages, []);

          fake.history = {
            count: 2,
            messages: [
              { message_id: "late-user", role: "user", text: "[maria] late history" },
              { message_id: "late-assistant", role: "assistant", text: "Recovered." },
            ],
          };
          const hydratedLater = yield* runtime.readThreadSnapshot({ providerThread: resumed });
          assert.deepEqual(
            hydratedLater.messages.map((message) => [message.role, message.text]),
            [
              ["user", "late history"],
              ["assistant", "Recovered."],
            ],
          );
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resolves MEDIA output inside rehydrated imported tool activities", () =>
    Effect.gen(function* () {
      const createFake = new FakeHermesGatewayClient();
      const createdThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(createFake);
          return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );
      const repository = yield* HermesSessionBindingRepository;
      const now = "2026-07-26T12:00:00.000Z";
      const imported = yield* repository.prepareSessionImport({
        importId: "hermes-import:test-tool-media",
        providerInstanceId: String(instanceId),
        profileKey: "real-profile",
        projectId: String(threadId),
        importKind: "session",
        storedSessionKey: "stored-session-1",
        threadId: String(threadId),
        now,
      });
      yield* repository.transitionSessionImport({
        importId: imported.importId,
        from: "prepared",
        to: "thread_created",
        now,
      });
      yield* repository.transitionSessionImport({
        importId: imported.importId,
        from: "thread_created",
        to: "completed",
        now,
      });

      const mediaPath = "/Users/maria/.hermes/cache/images/tool-render.png";
      const fake = new FakeHermesGatewayClient();
      fake.history = {
        count: 3,
        messages: [
          { message_id: "m-user", role: "user", text: "render it" },
          {
            message_id: "m-assistant",
            role: "assistant",
            text: "",
            tool_calls: [
              {
                id: "call-render",
                function: { name: "render_chart", arguments: "{}" },
              },
            ],
          },
          {
            message_id: "m-tool",
            role: "tool",
            tool_call_id: "call-render",
            text: `rendered\nMEDIA:${mediaPath}`,
          },
        ],
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(fake, true, undefined, false, ({ sourcePath }) =>
            Effect.succeed(
              sourcePath === mediaPath
                ? {
                    type: "image" as const,
                    id: ChatAttachmentId.make("hermes-tool-media"),
                    name: "tool-render.png",
                    mimeType: "image/png",
                    sizeBytes: 64,
                  }
                : null,
            ),
          );
          const resumed = yield* runtime.resumeThread({
            providerThread: createdThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const snapshot = yield* runtime.readThreadSnapshot({ providerThread: resumed });
          const tool = snapshot.turnItems?.find((item) => item.type === "dynamic_tool");
          assert.isDefined(tool);
          if (tool?.type === "dynamic_tool") {
            assert.notInclude(tool.output ?? "", "MEDIA:");
            assert.include(tool.output ?? "", "rendered");
            assert.include(tool.output ?? "", "[Attachment: tool-render.png]");
          }
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("uploads image attachments to Hermes before submitting the prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const readAttachmentIds: string[] = [];
        const runtime = yield* makeRuntime(fake, true, (attachment) => {
          readAttachmentIds.push(attachment.id);
          return Effect.succeed(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* runtime.startTurn({
          ...input,
          message: {
            ...input.message,
            attachments: [
              {
                type: "image",
                id: "thread-hermes-test-00000000-0000-4000-8000-000000000000",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 4,
              },
            ],
          },
        });

        assert.deepEqual(readAttachmentIds, [
          "thread-hermes-test-00000000-0000-4000-8000-000000000000",
        ]);
        assert.deepEqual(
          fake.imageAttachments.map((entry) => ({
            params: entry.params,
            operationId: entry.options.operationId,
          })),
          [
            {
              params: {
                session_id: "live-create-1",
                content_base64: "iVBORw==",
                filename: "image.png",
              },
              operationId: "hermes:image:attempt:hermes-test:0",
            },
          ],
        );
        // Attachment uploads go through mutationOptions so the gateway can
        // dedupe/reconcile them like every other mutation.
        assert.equal(typeof fake.imageAttachments[0]?.options.mutationId, "string");
        assert.equal(fake.prompts.length, 1);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("maps files, PDFs, and videos to their protocol-supported Hermes methods", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake, true, () =>
          Effect.succeed(Uint8Array.from([0x61, 0x62, 0x63])),
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* runtime.startTurn({
          ...input,
          message: {
            ...input.message,
            attachments: [
              {
                type: "file",
                id: "thread-hermes-test-00000000-0000-4000-8000-000000000001",
                name: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: 3,
              },
              {
                type: "pdf",
                id: "thread-hermes-test-00000000-0000-4000-8000-000000000002",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 3,
              },
              {
                type: "video",
                id: "thread-hermes-test-00000000-0000-4000-8000-000000000003",
                name: "clip.webm",
                mimeType: "video/webm",
                sizeBytes: 3,
              },
            ],
          },
        });

        assert.deepEqual(
          fake.fileAttachments.map((entry) => ({
            params: entry.params,
            operationId: entry.options.operationId,
          })),
          [
            {
              params: {
                session_id: "live-create-1",
                name: "notes.txt",
                data_url: "data:text/plain;base64,YWJj",
              },
              operationId: "hermes:file:attempt:hermes-test:0",
            },
            {
              params: {
                session_id: "live-create-1",
                name: "clip.webm",
                data_url: "data:video/webm;base64,YWJj",
              },
              operationId: "hermes:file:attempt:hermes-test:2",
            },
          ],
        );
        assert.deepEqual(
          fake.pdfAttachments.map((entry) => ({
            params: entry.params,
            operationId: entry.options.operationId,
          })),
          [
            {
              params: {
                session_id: "live-create-1",
                filename: "report.pdf",
                content_base64: "YWJj",
              },
              operationId: "hermes:pdf:attempt:hermes-test:1",
            },
          ],
        );
        assert.equal(typeof fake.fileAttachments[0]?.options.mutationId, "string");
        assert.equal(typeof fake.pdfAttachments[0]?.options.mutationId, "string");
        // Staged file/video references are what make the uploads visible to
        // the model, so they must ride along in the submitted prompt text.
        assert.equal(fake.prompts.length, 1);
        assert.equal(
          fake.prompts[0]?.params.text,
          `${input.message.text}\n\n@file:notes.txt\n@file:clip.webm`,
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails the turn when a staged file attach returns no reference token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.fileAttachOmitsRef = true;
        const runtime = yield* makeRuntime(fake, true, () =>
          Effect.succeed(Uint8Array.from([0x61, 0x62, 0x63])),
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        const result = yield* Effect.exit(
          runtime.startTurn({
            ...input,
            message: {
              ...input.message,
              attachments: [
                {
                  type: "file",
                  id: "thread-hermes-test-00000000-0000-4000-8000-000000000001",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: 3,
                },
              ],
            },
          }),
        );
        assert.equal(Exit.isFailure(result), true);
        assert.equal(fake.prompts.length, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "keeps prompt admitted through streaming, confirms on terminal, and ignores duplicates/unknown events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = new FakeHermesGatewayClient();
          const runtime = yield* makeRuntime(fake);
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const input = turnInput(providerThread);
          yield* runtime.startTurn(input);
          const repository = yield* HermesSessionBindingRepository;
          const operationId = `hermes:prompt:${input.attemptId}`;
          const admitted = yield* repository.getMutationIntent(operationId);
          assert.equal(
            Option.getOrNull(Option.map(admitted, (intent) => intent.state)),
            "admitted",
          );

          yield* Effect.promise(() => fake.emit("message.start", { text: "" }));
          yield* Effect.promise(() => fake.emit("message.delta", { text: "hello " }));
          yield* Effect.promise(() => fake.emit("future.event", { ignored: true }));
          yield* Effect.promise(() => fake.emit("message.delta", { text: "world" }));
          yield* Effect.promise(() => fake.emit("message.complete", { text: "hello world" }));
          yield* Effect.promise(() => fake.emit("message.complete", { text: "duplicate" }));

          const projected = yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          const terminalCount = [...projected].filter(
            (event) => event.type === "turn.terminal",
          ).length;
          const messages = [...projected].filter((event) => event.type === "message.updated");
          const confirmed = yield* repository.getMutationIntent(operationId);

          assert.equal(terminalCount, 1);
          assert.equal(
            messages.at(-1)?.type === "message.updated" ? messages.at(-1)!.message.text : "",
            "hello world",
          );
          assert.equal(
            Option.getOrNull(Option.map(confirmed, (intent) => intent.state)),
            "confirmed",
          );
          assert.equal(fake.prompts[0]!.options.mutationId, hermesWireMutationId(operationId));
        }),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not duplicate repeated interim message snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));

        const interim = "Spawned the subagent; I'll report its answer when it returns.";
        yield* Effect.promise(() => fake.emit("message.interim", { text: interim }));
        yield* Effect.promise(() => fake.emit("message.interim", { text: interim }));
        // Deltas re-stream the message from the beginning after a snapshot.
        yield* Effect.promise(() => fake.emit("message.delta", { text: interim }));
        yield* Effect.promise(() => fake.emit("message.complete", { text: interim }));

        const projected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const messages = [...projected].filter((event) => event.type === "message.updated");
        assert.equal(
          messages.at(-1)?.type === "message.updated" ? messages.at(-1)!.message.text : "",
          interim,
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("turns completed assistant MEDIA output into attachments without exposing paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const mediaPath = "/Users/maria/Downloads/rendered.jpg";
        const runtime = yield* makeRuntime(fake, true, undefined, false, ({ sourcePath }) =>
          Effect.succeed(
            sourcePath === mediaPath
              ? {
                  type: "image" as const,
                  id: ChatAttachmentId.make("hermes-media-output"),
                  name: "rendered.jpg",
                  mimeType: "image/jpeg",
                  sizeBytes: 128,
                }
              : null,
          ),
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("message.start", {
            text: `Here is the result.\nMEDIA:${mediaPath}`,
          }),
        );
        yield* Effect.promise(() =>
          fake.emit("message.complete", {
            text: `Here is the result.\nMEDIA:${mediaPath}`,
          }),
        );

        const projected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const messages = [...projected].filter((event) => event.type === "message.updated");
        const finalMessage = messages.at(-1);
        assert.equal(
          finalMessage?.type === "message.updated" ? finalMessage.message.text : "",
          "Here is the result.",
        );
        assert.deepEqual(
          finalMessage?.type === "message.updated" ? finalMessage.message.attachments : [],
          [
            {
              type: "image",
              id: "hermes-media-output",
              name: "rendered.jpg",
              mimeType: "image/jpeg",
              sizeBytes: 128,
            },
          ],
        );
        assert.isFalse(
          messages.some(
            (event) => event.type === "message.updated" && event.message.text.includes(mediaPath),
          ),
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "projects every Hermes tool lifecycle with stable identities, ordering, and sanitized data",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = new FakeHermesGatewayClient();
          const runtime = yield* makeRuntime(fake);
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          yield* runtime.startTurn(turnInput(providerThread));

          yield* Effect.promise(() => fake.emit("tool.generating", { name: "terminal" }));
          yield* Effect.promise(() => fake.emit("tool.generating", { name: "terminal" }));
          yield* Effect.promise(() =>
            fake.emit("tool.progress", { name: "terminal", preview: "preparing first command" }),
          );
          yield* Effect.promise(() =>
            fake.emit("tool.start", {
              tool_id: "tool-1",
              name: "terminal",
              context: "first command",
              args_text: '{ "command": "echo one" }',
            }),
          );
          yield* Effect.promise(() =>
            fake.emit("tool.start", {
              tool_id: "tool-2",
              name: "terminal",
              context: "second command",
              args_text: '{ "command": "echo two" }',
            }),
          );
          yield* Effect.promise(() =>
            fake.emit("tool.complete", {
              tool_id: "tool-2",
              name: "terminal",
              args: { command: "echo two", api_key: "secret-two" },
              result: { output: "two", exit_code: 0 },
              duration_s: 0.2,
              summary: "Ran second command",
            }),
          );
          yield* Effect.promise(() =>
            fake.emit("tool.complete", {
              tool_id: "tool-1",
              name: "terminal",
              args: {
                command: "curl https://example.test/?token=secret-one",
                password: "secret-password",
              },
              result: {
                output: "Authorization: Bearer secret-result",
                exit_code: 0,
              },
              result_text: "command completed",
              duration_s: 0.1,
              summary: "Ran first command",
            }),
          );
          yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));

          const projected = yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          const toolItems = [...projected].flatMap((event) =>
            event.type === "turn_item.updated" &&
            (event.turnItem.type === "dynamic_tool" || event.turnItem.type === "command_execution")
              ? [event.turnItem]
              : [],
          );
          const toolNodes = [...projected].flatMap((event) =>
            event.type === "node.updated" && event.node.kind === "tool_call" ? [event.node] : [],
          );
          const firstCompleted = toolItems.find(
            (item) => item.nativeItemRef?.nativeId === "tool-1" && item.status === "completed",
          );
          const secondCompleted = toolItems.find(
            (item) => item.nativeItemRef?.nativeId === "tool-2" && item.status === "completed",
          );
          const first = toolItems.filter((item) => item.id === firstCompleted?.id);
          const second = toolItems.filter((item) => item.id === secondCompleted?.id);
          const assistant = [...projected].find(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
          );

          assert.deepEqual(
            first.map((item) => item.status),
            ["pending", "running", "running", "completed"],
          );
          assert.deepEqual(
            second.map((item) => item.status),
            ["pending", "running", "completed"],
          );
          assert.equal(new Set(first.map((item) => item.id)).size, 1);
          assert.equal(new Set(second.map((item) => item.id)).size, 1);
          assert.deepEqual(
            toolNodes
              .filter((node) => node.id === firstCompleted?.nodeId)
              .map((node) => node.status),
            ["pending", "running", "running", "completed"],
          );
          assert.equal(
            new Set(
              toolNodes
                .filter((node) => node.id === secondCompleted?.nodeId)
                .map((node) => node.id),
            ).size,
            1,
          );
          assert.equal(firstCompleted?.ordinal, 101);
          assert.equal(secondCompleted?.ordinal, 102);
          assert.equal(
            assistant?.type === "turn_item.updated" ? assistant.turnItem.ordinal : null,
            103,
          );
          // Completed terminal tools project as native command cards with the
          // sanitized command and extracted output/exit code.
          assert.equal(firstCompleted?.type, "command_execution");
          assert.equal(
            firstCompleted?.type === "command_execution" ? firstCompleted.input : null,
            "curl https://example.test/?token=[REDACTED]",
          );
          assert.equal(
            firstCompleted?.type === "command_execution" ? firstCompleted.output : null,
            "Authorization: Bearer [REDACTED]",
          );
          assert.equal(
            firstCompleted?.type === "command_execution" ? firstCompleted.exitCode : null,
            0,
          );
          assert.equal(
            secondCompleted?.type === "command_execution" ? secondCompleted.input : null,
            "echo two",
          );
        }),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("projects start-less completions and failed tool results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("tool.start", {
            tool_id: "failed-tool",
            name: "terminal",
            arguments: { command: "false" },
          }),
        );
        yield* Effect.promise(() =>
          fake.emit("tool.complete", {
            tool_id: "failed-tool",
            name: "terminal",
            result: "Error executing tool 'terminal': permission denied",
          }),
        );
        yield* Effect.promise(() =>
          fake.emit("tool.complete", {
            tool_id: "completion-only",
            name: "web_search",
            args: { query: "Hermes" },
            result: { results: ["one"] },
          }),
        );
        yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));

        const items = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((events) =>
            [...events].flatMap((event) =>
              event.type === "turn_item.updated" &&
              (event.turnItem.type === "dynamic_tool" ||
                event.turnItem.type === "command_execution" ||
                event.turnItem.type === "web_search")
                ? [event.turnItem]
                : [],
            ),
          ),
        );
        const byNativeId = (nativeId: string): OrchestrationV2TurnItem | undefined =>
          items.findLast((item) => item.nativeItemRef?.nativeId === nativeId);
        const completionOnly = byNativeId("completion-only");

        assert.equal(byNativeId("failed-tool")?.status, "failed");
        assert.equal(byNativeId("failed-tool")?.type, "command_execution");
        assert.equal(completionOnly?.status, "completed");
        assert.equal(completionOnly?.type, "web_search");
        assert.deepEqual(
          completionOnly?.type === "web_search" ? completionOnly.patterns : undefined,
          ["Hermes"],
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores stale and duplicate events while enriching tool risk output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));

        yield* Effect.promise(() =>
          fake.emit(
            "tool.start",
            { tool_id: "stale-tool", name: "terminal", args: { command: "stale" } },
            { runId: "prior-hermes-run" },
          ),
        );
        yield* Effect.promise(() =>
          fake.emit(
            "tool.start",
            { tool_id: "risk-tool", name: "web_extract", args: { url: "https://example.test" } },
            { eventId: "dedupe-tool-start" },
          ),
        );
        yield* Effect.promise(() =>
          fake.emit(
            "tool.start",
            { tool_id: "risk-tool", name: "web_extract", args: { url: "https://example.test" } },
            { eventId: "dedupe-tool-start" },
          ),
        );
        yield* Effect.promise(() =>
          fake.emit("tool.complete", {
            tool_id: "risk-tool",
            name: "web_extract",
            result: "untrusted page contents",
          }),
        );
        yield* Effect.promise(() =>
          fake.emit("tool.output_risk", {
            tool_id: "risk-tool",
            name: "web_extract",
            risk: "high",
            findings: ["prompt injection"],
            redacted: true,
          }),
        );
        yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));

        const items = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((events) =>
            [...events].flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
                ? [event.turnItem]
                : [],
            ),
          ),
        );
        const staleItems = items.filter((item) => item.nativeItemRef?.nativeId === "stale-tool");
        const riskItems = items.filter((item) => item.nativeItemRef?.nativeId === "risk-tool");
        const runningRiskItems = riskItems.filter((item) => item.status === "running");
        const finalRiskItem = riskItems.at(-1);

        assert.equal(staleItems.length, 0);
        assert.equal(runningRiskItems.length, 1);
        assert.deepEqual(
          finalRiskItem?.type === "dynamic_tool" ? finalRiskItem.output : undefined,
          {
            result: "[REDACTED BY HERMES]",
            outputRisk: {
              risk: "high",
              findings: ["prompt injection"],
              redacted: true,
            },
          },
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("skips assistant projection for a tool-only turn with no assistant text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("tool.start", {
            tool_id: "silent-tool",
            name: "terminal",
            args: { command: "echo one" },
          }),
        );
        yield* Effect.promise(() =>
          fake.emit("tool.complete", {
            tool_id: "silent-tool",
            name: "terminal",
            result: { output: "one", exit_code: 0 },
          }),
        );
        yield* Effect.promise(() => fake.emit("status.update", { status: "idle" }));

        const projected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const assistantItems = [...projected].filter(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        );
        const assistantMessages = [...projected].filter(
          (event) => event.type === "message.updated",
        );
        const toolItems = [...projected].filter(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );

        assert.equal(assistantItems.length, 0);
        assert.equal(assistantMessages.length, 0);
        assert.ok(toolItems.length > 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "keeps the output-risk annotation flat across repeated risk and completion events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = new FakeHermesGatewayClient();
          const runtime = yield* makeRuntime(fake);
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          yield* runtime.startTurn(turnInput(providerThread));
          yield* Effect.promise(() =>
            fake.emit("tool.start", {
              tool_id: "risky-tool",
              name: "terminal",
              args: { command: "curl https://example.test" },
            }),
          );
          yield* Effect.promise(() =>
            fake.emit("tool.output_risk", {
              tool_id: "risky-tool",
              risk: "medium",
              findings: ["suspicious url"],
            }),
          );
          yield* Effect.promise(() =>
            fake.emit("tool.output_risk", {
              tool_id: "risky-tool",
              risk: "high",
              findings: ["prompt injection"],
            }),
          );
          yield* Effect.promise(() =>
            fake.emit("tool.complete", {
              tool_id: "risky-tool",
              name: "terminal",
              result: { output: "body", exit_code: 0 },
            }),
          );
          yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));

          const items = yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
            Effect.map((events) =>
              [...events].flatMap((event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
                  ? [event.turnItem]
                  : [],
              ),
            ),
          );
          const finalItem = items
            .filter((item) => item.nativeItemRef?.nativeId === "risky-tool")
            .at(-1);

          // The raw output survives tool.complete and the annotation is stored
          // once, never nested inside a previous wrapper.
          assert.deepEqual(finalItem?.type === "dynamic_tool" ? finalItem.output : undefined, {
            result: { output: "body", exit_code: 0 },
            outputRisk: { risk: "high", findings: ["prompt injection"] },
          });
        }),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("closes a tool without a completion event conservatively", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("tool.start", {
            tool_id: "incomplete-tool",
            name: "terminal",
            args: { command: "sleep 1" },
          }),
        );
        yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));

        const finalToolItem = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((events) =>
            [...events]
              .flatMap((event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
                  ? [event.turnItem]
                  : [],
              )
              .at(-1),
          ),
        );

        assert.equal(finalToolItem?.status, "cancelled");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("projects Hermes todo payloads as a live todo list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("tool.complete", {
            tool_id: "todo-1",
            name: "todo_write",
            result: "ok",
            todos: [
              { content: "outline", status: "completed" },
              { content: "implement", status: "in_progress" },
              { content: "verify", status: "pending" },
            ],
          }),
        );
        yield* Effect.promise(() =>
          fake.emit("tool.complete", {
            tool_id: "todo-2",
            name: "todo_write",
            result: "ok",
            todos: [
              { content: "outline", status: "completed" },
              { content: "implement", status: "completed" },
              { content: "verify", status: "completed" },
            ],
          }),
        );
        yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));

        const projected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const todoItems = [...projected].flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "todo_list"
            ? [event.turnItem]
            : [],
        );
        const plans = [...projected].flatMap((event) =>
          event.type === "plan.updated" ? [event.plan] : [],
        );

        // Both payloads update the same todo list in place.
        assert.equal(new Set(todoItems.map((item) => String(item.id))).size, 1);
        assert.deepEqual(
          todoItems.at(0)?.steps.map((step) => step.status),
          ["completed", "running", "pending"],
        );
        assert.equal(todoItems.at(0)?.status, "running");
        assert.equal(todoItems.at(-1)?.status, "completed");
        const finalPlan = plans.at(-1);
        assert.equal(finalPlan?.status, "completed");
        assert.deepEqual(
          finalPlan?.kind === "todo_list" ? finalPlan.steps.map((step) => step.text) : [],
          ["outline", "implement", "verify"],
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("projects file edits as file-change cards carrying the inline diff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("tool.start", {
            tool_id: "edit-1",
            name: "edit_file",
            args: { path: "src/app.ts" },
          }),
        );
        yield* Effect.promise(() =>
          fake.emit("tool.complete", {
            tool_id: "edit-1",
            name: "edit_file",
            result: "edited",
            inline_diff: "--- a/src/app.ts\n+++ b/src/app.ts\n-old line\n+new line\n+second line",
          }),
        );
        yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));

        const fileItems = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((events) =>
            [...events].flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "file_change"
                ? [event.turnItem]
                : [],
            ),
          ),
        );
        const finalItem = fileItems.at(-1);

        assert.equal(finalItem?.status, "completed");
        assert.equal(finalItem?.fileName, "src/app.ts");
        assert.equal(
          finalItem?.diffStr,
          "--- a/src/app.ts\n+++ b/src/app.ts\n-old line\n+new line\n+second line",
        );
        assert.equal(finalItem?.additions, 2);
        assert.equal(finalItem?.deletions, 1);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("switches the session model through the /model command before the prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn({
          ...turnInput(providerThread),
          modelSelection: { instanceId, model: "openai/gpt-6" },
        });
        yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));

        const projected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const sessionUpdates = [...projected].flatMap((event) =>
          event.type === "provider_session.updated" ? [event.providerSession] : [],
        );

        assert.deepEqual(
          fake.prompts.map((entry) => entry.params.text),
          ["/model openai/gpt-6 --session", "hello Hermes"],
        );
        assert.equal(sessionUpdates.at(-1)?.model, "openai/gpt-6");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("carries the T3 orchestration instructions in the first MCP-leased prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.compatibility = {
          ...compatibility,
          capabilities: [...compatibility.capabilities, "session_mcp"],
        };
        McpProviderSession.setMcpProviderSession({
          credentialId: "credential-hermes-instructions",
          environmentId: EnvironmentId.make("environment-hermes-test"),
          threadId,
          providerSessionId: "mcp-provider-session-hermes-instructions",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer scoped-hermes-token",
          capabilities: ["orchestration"],
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        const runtime = yield* makeRuntime(fake, true, undefined, true);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() => fake.emit("message.complete", { text: "done" }));
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );

        const promptText = fake.prompts.at(0)?.params.text ?? "";
        assert.ok(promptText.includes("<t3_code_orchestration_instructions>"));
        assert.ok(promptText.includes("t3-html"));
        assert.ok(promptText.includes("<user_request>\nhello Hermes\n</user_request>"));
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "routes repeated turns through the projected thread id while retaining native identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = new FakeHermesGatewayClient();
          const runtime = yield* makeRuntime(fake);
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const projectedThread = {
            ...providerThread,
            id: ProviderThreadId.make("provider-thread:hermes-placeholder"),
          };

          yield* runtime.startTurn(turnInput(projectedThread));
          assert.equal(fake.prompts.length, 1);

          yield* Effect.promise(() => fake.emit("message.complete", { text: "routed" }));
          const firstEvents = yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          const firstProviderTurn = [...firstEvents].find(
            (event) => event.type === "provider_turn.updated",
          );
          assert.equal(
            firstProviderTurn?.type === "provider_turn.updated"
              ? firstProviderTurn.providerTurn.providerThreadId
              : null,
            projectedThread.id,
          );

          fake.promptResult = {
            status: "streaming",
            run_id: "hermes-run-2",
            user_message_id: "hermes-user-2",
            assistant_message_id: "hermes-assistant-2",
            mutation_id: "mutation-2",
          };
          yield* runtime.startTurn({
            ...turnInput(projectedThread),
            runId: RunId.make("run:hermes-test:2"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
            attemptId: RunAttemptId.make("attempt:hermes-test:2"),
          });
          yield* Effect.promise(() =>
            fake.emit("message.complete", { text: "again" }, { runId: "hermes-run-2" }),
          );
          const secondEvents = yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          const secondProviderTurn = [...secondEvents].find(
            (event) => event.type === "provider_turn.updated",
          );
          assert.equal(
            secondProviderTurn?.type === "provider_turn.updated"
              ? secondProviderTurn.providerTurn.providerThreadId
              : null,
            projectedThread.id,
          );
          assert.equal(
            secondProviderTurn?.type === "provider_turn.updated"
              ? secondProviderTurn.providerTurn.ordinal
              : null,
            2,
          );
          assert.equal(fake.prompts.length, 2);
        }),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("continues the default model after Hermes reports its resolved concrete model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() => fake.emit("session.info", { model: "openai/gpt-5.6-sol" }));
        assert.equal(runtime.providerSession.model, "openai/gpt-5.6-sol");
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "first response", status: "complete" }),
        );

        fake.promptResult = {
          status: "streaming",
          run_id: "hermes-run-2",
          user_message_id: "hermes-user-2",
          assistant_message_id: "hermes-assistant-2",
          mutation_id: "mutation-2",
        };
        yield* runtime.startTurn({
          ...turnInput(providerThread),
          runId: RunId.make("run:hermes-test:2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("attempt:hermes-test:2"),
        });

        assert.equal(fake.prompts.length, 2);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("continues the first prompt when Hermes rejects a duplicate session title", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.compatibility = {
          ...compatibility,
          capabilities: [...compatibility.capabilities, "session.title"],
        };
        fake.titleError = new HermesGatewayRpcError(4022, "session.title", "fatal");
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "first response", status: "complete" }),
        );
        yield* runtime.startTurn({
          ...turnInput(providerThread),
          runId: RunId.make("run:hermes-title-conflict:2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("attempt:hermes-title-conflict:2"),
        });

        assert.equal(fake.prompts.length, 2);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reacquires an expired same-generation lease before terminal settlement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* runtime.startTurn(input);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE hermes_session_bindings
          SET lease_expires_at = '2000-01-01T00:00:00.000Z'
          WHERE thread_id = ${String(threadId)}
        `;
        yield* Effect.promise(() => fake.emit("message.complete", { text: "late result" }));
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        const repository = yield* HermesSessionBindingRepository;
        const intent = yield* repository.getMutationIntent(`hermes:prompt:${input.attemptId}`);

        assert.isTrue(Option.isSome(terminal));
        assert.equal(Option.getOrNull(Option.map(intent, (value) => value.state)), "confirmed");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("prompts again after the owner lease lapsed while the thread sat idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* runtime.startTurn(input);
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "first response", status: "complete" }),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE hermes_session_bindings
          SET lease_expires_at = '2000-01-01T00:00:00.000Z'
          WHERE thread_id = ${String(threadId)}
        `;

        yield* runtime.startTurn({
          ...input,
          runId: RunId.make("run:hermes-lapsed-lease:2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("attempt:hermes-lapsed-lease:2"),
        });

        const bindings = yield* sql<{ readonly lease_expires_at: string }>`
          SELECT lease_expires_at
          FROM hermes_session_bindings
          WHERE thread_id = ${String(threadId)}
        `;
        assert.equal(fake.prompts.length, 2);
        assert.isTrue(
          (bindings[0]?.lease_expires_at ?? "") > DateTime.formatIso(DateTime.nowUnsafe()),
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("waits for the terminal event when interrupting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* runtime.startTurn(input);
        const providerTurn = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "provider_turn.updated"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(providerTurn));
        if (Option.isNone(providerTurn) || providerTurn.value.type !== "provider_turn.updated")
          return;

        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: providerTurn.value.providerTurn.id,
        });
        assert.equal(fake.interrupts.length, 1);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("treats an interrupt with no active turn as already satisfied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: ProviderTurnId.make("provider-turn:hermes-stale"),
        });
        assert.equal(fake.interrupts.length, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("finalizes locally when an interrupt never observes a terminal event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.interruptEmitsTerminal = false;
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));
        const providerTurn = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "provider_turn.updated"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(providerTurn));
        if (Option.isNone(providerTurn) || providerTurn.value.type !== "provider_turn.updated")
          return;

        const fiber = yield* runtime
          .interruptTurn({
            providerThread,
            providerTurnId: providerTurn.value.providerTurn.id,
          })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust(Duration.seconds(16));
        yield* Fiber.join(fiber);

        assert.equal(fake.interrupts.length, 1);
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(terminal));
        if (Option.isSome(terminal) && terminal.value.type === "turn.terminal") {
          assert.equal(terminal.value.status, "interrupted");
        }
      }),
    ).pipe(Effect.provide(Layer.merge(TestLayer, TestClock.layer()))),
  );

  it.effect("steers the active turn through prompt.submit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* runtime.startTurn(input);
        const providerTurn = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "provider_turn.updated"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(providerTurn));
        if (Option.isNone(providerTurn) || providerTurn.value.type !== "provider_turn.updated")
          return;

        fake.promptResult = { status: "steered", run_id: "hermes-run-1" };
        yield* runtime.steerTurn({
          threadId,
          runId: input.runId,
          providerThread,
          providerTurnId: providerTurn.value.providerTurn.id,
          message: {
            messageId: MessageId.make("message:hermes-steer"),
            text: "actually, focus on the tests",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });

        assert.equal(fake.prompts.length, 2);
        assert.equal(fake.prompts[1]!.params.text, "actually, focus on the tests");
        assert.equal(fake.prompts[1]!.options.operationId, "hermes:steer:message:hermes-steer");

        yield* Effect.promise(() => fake.emit("message.complete", { text: "steered answer" }));
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(terminal));
        if (Option.isSome(terminal) && terminal.value.type === "turn.terminal") {
          assert.equal(terminal.value.status, "completed");
        }
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps the provider turn open across a Hermes-side queued steering prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* runtime.startTurn(input);
        const providerTurn = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "provider_turn.updated"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(providerTurn));
        if (Option.isNone(providerTurn) || providerTurn.value.type !== "provider_turn.updated")
          return;

        fake.promptResult = { status: "queued", run_id: "hermes-run-2" };
        yield* runtime.steerTurn({
          threadId,
          runId: input.runId,
          providerThread,
          providerTurnId: providerTurn.value.providerTurn.id,
          message: {
            messageId: MessageId.make("message:hermes-steer-queued"),
            text: "and after that, run the linter",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });

        // First run completes: absorbed, the turn stays open for the queued
        // steering prompt's follow-up run.
        yield* Effect.promise(() => fake.emit("message.complete", { text: "first answer" }));
        yield* Effect.promise(() =>
          fake.emit(
            "message.delta",
            { text: "second answer" },
            { runId: "hermes-run-2", messageId: "hermes-assistant-2" },
          ),
        );
        yield* Effect.promise(() =>
          fake.emit(
            "message.complete",
            { text: "second answer" },
            { runId: "hermes-run-2", messageId: "hermes-assistant-2" },
          ),
        );

        const collected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const events = [...collected];
        const last = events[events.length - 1];
        assert.equal(last?.type, "turn.terminal");
        if (last?.type === "turn.terminal") {
          assert.equal(last.status, "completed");
        }
        assert.isTrue(
          events.some(
            (event) => event.type === "message.updated" && event.message.text === "second answer",
          ),
          "the queued steering run's output must project into the same provider turn",
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not resubmit an indeterminate prompt mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.promptError = new HermesGatewayMutationIndeterminateError(
          "hermes:prompt:attempt:hermes-test",
          "prompt.submit",
        );
        fake.mutationStatus = {
          mutation_id: "hermes:prompt:attempt:hermes-test",
          mutation_status: "indeterminate",
          run_id: "hermes-run-1",
          replayed: true,
        };
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* Effect.result(runtime.startTurn(input));
        yield* Effect.result(runtime.startTurn(input));
        const repository = yield* HermesSessionBindingRepository;
        const intent = yield* repository.getMutationIntent(`hermes:prompt:${input.attemptId}`);

        assert.equal(fake.prompts.length, 1);
        assert.equal(Option.getOrNull(Option.map(intent, (value) => value.state)), "indeterminate");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("recovers a completed prompt replay without waiting for message events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.promptError = new HermesGatewayMutationIndeterminateError(
          "hermes:prompt:attempt:hermes-test",
          "prompt.submit",
        );
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* Effect.result(runtime.startTurn(input));

        fake.promptError = null;
        fake.mutationStatus = { mutation_status: "completed" };
        fake.promptResult = {
          status: "complete",
          mutation_id: `hermes:prompt:${input.attemptId}`,
          mutation_status: "completed",
          run_id: "hermes-run-1",
          message_id: "hermes-assistant-1",
          replayed: true,
        };
        yield* runtime.startTurn(input);
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        const repository = yield* HermesSessionBindingRepository;
        const intent = yield* repository.getMutationIntent(`hermes:prompt:${input.attemptId}`);

        assert.isTrue(Option.isSome(terminal));
        assert.equal(Option.getOrNull(Option.map(intent, (value) => value.state)), "reconciled");
        assert.equal(fake.prompts.length, 2);
        assert.deepEqual(fake.reconciliations, [`hermes:prompt:${input.attemptId}`]);
        assert.deepEqual(fake.reconciliationMutationIds, [
          hermesWireMutationId(`hermes:prompt:${input.attemptId}`),
        ]);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("blocks an indeterminate replay and any different prompt behind it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.promptError = new HermesGatewayMutationIndeterminateError(
          "hermes:prompt:attempt:hermes-test",
          "prompt.submit",
        );
        fake.mutationStatus = {
          mutation_id: "hermes:prompt:attempt:hermes-test",
          mutation_status: "indeterminate",
          run_id: "hermes-run-1",
          replayed: true,
        };
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* Effect.result(runtime.startTurn(input));
        yield* Effect.result(runtime.startTurn(input));
        yield* Effect.result(
          runtime.startTurn({
            ...input,
            attemptId: RunAttemptId.make("attempt:hermes-other"),
          }),
        );

        assert.equal(fake.prompts.length, 1);
        assert.deepEqual(fake.reconciliations, [`hermes:prompt:${input.attemptId}`]);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("recovers an indeterminate session create through completed stable replay", () =>
    Effect.gen(function* () {
      const first = new FakeHermesGatewayClient();
      first.createError = new HermesGatewayMutationIndeterminateError(
        `hermes:create:${instanceId}:${threadId}`,
        "session.create",
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(first);
          yield* Effect.result(runtime.ensureThread({ threadId, modelSelection, runtimePolicy }));
        }),
      );

      const recovered = new FakeHermesGatewayClient();
      recovered.mutationStatus = { mutation_status: "completed" };
      const providerThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(recovered);
          return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );

      assert.equal(providerThread.status, "idle");
      assert.equal(recovered.creates.length, 1);
      assert.deepEqual(recovered.reconciliations, [`hermes:create:${instanceId}:${threadId}`]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fences a recovered external run until an authoritative terminal event", () =>
    Effect.gen(function* () {
      const createdThread = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(new FakeHermesGatewayClient());
          return yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );
      const recovered = new FakeHermesGatewayClient();
      recovered.resumeRunning = true;
      recovered.resumeInflight = { run_id: "external-run" };
      recovered.resumeStatus = "running";
      recovered.statusOutput = "Hermes TUI Status\n\nAgent Running: Yes";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(recovered);
          const providerThread = yield* runtime.resumeThread({
            providerThread: createdThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });

          assert.equal(providerThread.status, "active");
          assert.equal(runtime.providerSession.status, "running");
          yield* Effect.result(runtime.startTurn(turnInput(providerThread)));
          assert.equal(recovered.prompts.length, 0);

          yield* Effect.promise(() => recovered.emit("message.complete", { status: "complete" }));
          assert.equal(runtime.providerSession.status, "ready");
          recovered.statusOutput = "Hermes TUI Status\n\nAgent Running: No";
          yield* runtime.startTurn(turnInput(providerThread));
          assert.equal(recovered.prompts.length, 1);
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("projects interrupted and error message.complete statuses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const firstInput = turnInput(providerThread);
        yield* runtime.startTurn(firstInput);
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "interrupted", status: "interrupted" }),
        );
        const interrupted = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(interrupted));
        if (Option.isSome(interrupted) && interrupted.value.type === "turn.terminal") {
          assert.equal(interrupted.value.status, "interrupted");
        }

        yield* runtime.startTurn({
          ...firstInput,
          attemptId: RunAttemptId.make("attempt:hermes-error"),
          providerTurnOrdinal: 2,
        });
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "failed", status: "error" }),
        );
        const failed = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(failed));
        if (Option.isSome(failed) && failed.value.type === "turn.terminal") {
          assert.equal(failed.value.status, "failed");
          assert.isNotNull(failed.value.failure);
          assert.equal(failed.value.threadDisposition, "broken");
        }
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("publishes a broken failure and poisons the stale owner after generation loss", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = turnInput(providerThread);
        yield* runtime.startTurn(input);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE hermes_session_bindings
          SET
            lease_owner_key = 'competing-owner',
            lease_generation = lease_generation + 1,
            lease_expires_at = '2999-01-01T00:00:00.000Z'
          WHERE thread_id = ${String(threadId)}
        `;
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "stale success", status: "complete" }),
        );
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        yield* Effect.result(
          runtime.startTurn({
            ...input,
            attemptId: RunAttemptId.make("attempt:after-generation-loss"),
          }),
        );

        assert.isTrue(Option.isSome(terminal));
        if (Option.isSome(terminal) && terminal.value.type === "turn.terminal") {
          assert.equal(terminal.value.status, "failed");
          assert.equal(terminal.value.threadDisposition, "broken");
        }
        assert.equal(fake.prompts.length, 1);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects opening a disabled instance without connecting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const exit = yield* Effect.exit(makeRuntime(fake, false));
        assert.equal(exit._tag, "Failure");
        assert.equal(fake.creates.length, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("closes the Hermes client when provider open cannot connect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.connectError = new Error("gateway unavailable");

        const exit = yield* Effect.exit(makeRuntime(fake));

        assert.equal(exit._tag, "Failure");
        assert.equal(fake.closeCount, 1);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a fully configured remote gateway before constructing a client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const idAllocator = yield* IdAllocatorV2;
        const repository = yield* HermesSessionBindingRepository;
        let clientCreations = 0;
        const adapter = makeHermesServeAdapterV2({
          instanceId,
          settings: {
            enabled: true,
            endpoint: "wss://gateway.example.com/api/ws",
            remoteAccessEnabled: true,
            profileKey: "remote-profile",
            managedServerEnabled: false,
            customModels: [],
            importEnabled: false,
            mcpEnabled: false,
            attachmentsEnabled: false,
            proactiveEnabled: false,
            voiceEnabled: false,
          },
          enabled: true,
          authToken: "local-token",
          remotePairingToken: "dedicated-pairing-token",
          remoteTlsCertificateSha256: "ab".repeat(32),
          idAllocator,
          repository,
          clientFactory: () => {
            clientCreations += 1;
            return new FakeHermesGatewayClient();
          },
        });

        const exit = yield* Effect.exit(
          adapter.openSession({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          }),
        );
        assert.equal(exit._tag, "Failure");
        assert.equal(clientCreations, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});

describe("HermesServeAdapterV2 runtime requests", () => {
  it.effect("fails a turn parked on an approval this gateway cannot answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.interruptEmitsTerminal = false;
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));

        yield* Effect.promise(() => fake.emit("approval.request", { command: "rm -rf /tmp/x" }));

        const projected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const events = [...projected];
        const requests = events.flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        );

        // Recorded so the user can see what was asked, then closed out rather
        // than left waiting on a decision the gateway has no method to receive.
        const opened = requests.at(0);
        assert.equal(opened?.status, "pending");
        assert.equal(opened?.responseCapability.type, "not_resumable");
        assert.include(
          opened?.responseCapability.type === "not_resumable"
            ? opened.responseCapability.reason
            : "",
          "events.approvals",
        );
        assert.equal(requests.at(-1)?.status, "cancelled");

        const approvalItem = events.findLast(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.equal(
          approvalItem?.type === "turn_item.updated" &&
            approvalItem.turnItem.type === "approval_request"
            ? approvalItem.turnItem.prompt
            : null,
          "rm -rf /tmp/x",
        );

        // The gateway holds the run open until someone answers, so walking away
        // without stopping it would strand the session.
        assert.lengthOf(fake.interrupts, 1);

        const terminal = events.findLast((event) => event.type === "turn.terminal");
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : null, "failed");
        assert.include(
          terminal?.type === "turn.terminal" ? (terminal.failure?.message ?? "") : "",
          "events.approvals",
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not advertise approvals a gateway cannot accept a response to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unanswering = new FakeHermesGatewayClient();
        const unansweringRuntime = yield* makeRuntime(unanswering);
        assert.isFalse(
          unansweringRuntime.providerSession.capabilities.approvals.supportsCommandApproval,
        );
        assert.isFalse(
          unansweringRuntime.providerSession.capabilities.planning.supportsStructuredQuestions,
        );

        const capable = new FakeHermesGatewayClient();
        capable.compatibility = answering("events.approvals", "events.clarification");
        const capableRuntime = yield* makeRuntime(capable);
        assert.isTrue(
          capableRuntime.providerSession.capabilities.approvals.supportsCommandApproval,
        );
        assert.isTrue(
          capableRuntime.providerSession.capabilities.planning.supportsStructuredQuestions,
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps an approval live and answerable when the gateway negotiated it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.compatibility = answering("events.approvals");
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));

        yield* Effect.promise(() => fake.emit("approval.request", { command: "ls" }));

        const projected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "runtime_request.updated"),
          Stream.runCollect,
        );
        const request = [...projected].flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        )[0];
        assert.equal(request?.status, "pending");
        assert.equal(request?.responseCapability.type, "live");
        assert.lengthOf(fake.interrupts, 0);

        yield* runtime.respondToRuntimeRequest({
          requestId: request!.id,
          decision: "accept",
        });
        assert.deepEqual(fake.approvalResponses, [{ session_id: "live-create-1", choice: "once" }]);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses to answer while several approvals are outstanding on one session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.compatibility = answering("events.approvals");
        const runtime = yield* makeRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(turnInput(providerThread));

        yield* Effect.promise(() => fake.emit("approval.request", { command: "first" }));
        yield* Effect.promise(() => fake.emit("approval.request", { command: "second" }));

        const projected = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.take(2),
          Stream.runCollect,
        );
        const requests = [...projected].flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        );
        assert.lengthOf(requests, 2);

        // approval.respond names a session, not a request, so answering one of
        // two would resolve whichever the gateway happens to consider current.
        const exit = yield* Effect.exit(
          runtime.respondToRuntimeRequest({ requestId: requests[0]!.id, decision: "accept" }),
        );
        assert.equal(exit._tag, "Failure");
        assert.lengthOf(fake.approvalResponses, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stops a run parked on an approval when the session is released", () =>
    Effect.gen(function* () {
      const fake = new FakeHermesGatewayClient();
      fake.compatibility = answering("events.approvals");
      fake.interruptEmitsTerminal = false;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(fake);
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          yield* runtime.startTurn(turnInput(providerThread));
          yield* Effect.promise(() => fake.emit("approval.request", { command: "deploy" }));
          assert.lengthOf(fake.interrupts, 0);
        }),
      );

      assert.lengthOf(fake.interrupts, 1);
      assert.equal(fake.closeCount, 1);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("HermesServeAdapterV2 proactive runs", () => {
  const recordContinuations = () => {
    const offers: Array<ProviderContinuationRequest> = [];
    return {
      offers,
      sink: {
        offer: (request: ProviderContinuationRequest) =>
          Effect.sync(() => {
            offers.push(request);
          }),
      },
    };
  };

  function continuationTurnInput(
    providerThread: OrchestrationV2ProviderThread,
    ordinal = 2,
  ): ProviderAdapterV2TurnInput {
    return {
      ...turnInput(providerThread),
      runId: RunId.make(`run:hermes-continuation-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt:hermes-continuation-${ordinal}`),
      message: {
        messageId: MessageId.make(`message:hermes-continuation-${ordinal}`),
        text: HERMES_EXTERNAL_RUN_CONTINUATION_DETAIL,
        attachments: [],
        createdBy: "agent",
        creationSource: "provider",
      },
    };
  }

  it.effect("offers a continuation for a gateway run T3 never submitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          true,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        yield* Effect.promise(() => fake.emit("message.delta", { text: "cron report" }));

        assert.equal(continuations.offers.length, 1);
        assert.equal(continuations.offers[0]?.threadId, threadId);
        assert.equal(String(continuations.offers[0]?.providerThreadId), String(providerThread.id));
        assert.equal(continuations.offers[0]?.driver, "hermes");
        assert.equal(continuations.offers[0]?.detail, HERMES_EXTERNAL_RUN_CONTINUATION_DETAIL);
        // A second event of the same run must not queue a second turn.
        yield* Effect.promise(() => fake.emit("message.delta", { text: " continued" }));
        assert.equal(continuations.offers.length, 1);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stays passive while proactive mode is switched off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          false,
        );
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });

        yield* Effect.promise(() => fake.emit("message.delta", { text: "cron report" }));

        assert.equal(continuations.offers.length, 0);
        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores status-only traffic that carries no transcript content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          true,
        );
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });

        yield* Effect.promise(() => fake.emit("session.status", { status: "idle" }));
        yield* Effect.promise(() => fake.emit("title.changed", { title: "x", revision: 1 }));

        assert.equal(continuations.offers.length, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("streams the external run into the continuation turn without prompting Hermes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          true,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        yield* Effect.promise(() => fake.emit("message.delta", { text: "inbox report" }));
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "inbox report", status: "complete" }),
        );
        assert.equal(continuations.offers.length, 1);

        yield* runtime.startTurn(continuationTurnInput(providerThread));

        const collected = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((events) => [...events]),
        );
        const assistantText = collected.flatMap((event) =>
          event.type === "message.updated" && event.message.role === "assistant"
            ? [event.message.text]
            : [],
        );
        const terminal = collected.findLast((event) => event.type === "turn.terminal");

        assert.equal(fake.prompts.length, 0);
        assert.include(assistantText.at(-1) ?? "", "inbox report");
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("offers again for the next external run once a continuation has drained", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          true,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        yield* Effect.promise(() => fake.emit("message.delta", { text: "first" }));
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "first", status: "complete" }),
        );
        yield* runtime.startTurn(continuationTurnInput(providerThread));
        // A genuinely new gateway run, not a trailing artifact of the first.
        yield* Effect.promise(() =>
          fake.emit("message.delta", { text: "second" }, { runId: "hermes-run-2" }),
        );

        assert.equal(continuations.offers.length, 2);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores trailing artifacts of a run T3 itself just finished", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          true,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        yield* runtime.startTurn(turnInput(providerThread));
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "answer", status: "complete" }),
        );
        // Hermes re-announces the settled message on the same run id.
        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "answer", status: "complete" }),
        );

        assert.equal(continuations.offers.length, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("holds session release while an external run waits for its turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          true,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        yield* Effect.promise(() => fake.emit("message.delta", { text: "pending" }));
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);

        yield* Effect.promise(() =>
          fake.emit("message.complete", { text: "pending", status: "complete" }),
        );
        yield* runtime.startTurn(continuationTurnInput(providerThread));
        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("buffers an external approval past the transcript trimming limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.compatibility = answering("events.approvals");
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          true,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        // Trimming the tail of a long external run is deliberate for content.
        for (let index = 0; index <= HERMES_EXTERNAL_EVENT_BUFFER_LIMIT; index += 1) {
          yield* Effect.promise(() => fake.emit("message.delta", { text: "." }));
        }
        // The request is the exception: dropped, the continuation turn opens
        // with nothing to answer and the gateway stays parked on it forever.
        yield* Effect.promise(() => fake.emit("approval.request", { command: "cron deploy" }));

        yield* runtime.startTurn(continuationTurnInput(providerThread));
        const projected = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const item = [...projected][0];
        assert.equal(
          item?.type === "turn_item.updated" && item.turnItem.type === "approval_request"
            ? item.turnItem.prompt
            : null,
          "cron deploy",
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores an external approval while proactive mode is switched off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = new FakeHermesGatewayClient();
        fake.compatibility = answering("events.approvals");
        const continuations = recordContinuations();
        const runtime = yield* makeRuntime(
          fake,
          true,
          undefined,
          false,
          undefined,
          continuations.sink,
          false,
        );
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });

        yield* Effect.promise(() => fake.emit("approval.request", { command: "cron deploy" }));

        // The run belongs to whoever started it, so T3 neither answers it nor
        // stops it on their behalf.
        assert.equal(continuations.offers.length, 0);
        assert.lengthOf(fake.interrupts, 0);
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});

describe("sanitizeHermesToolValue", () => {
  it("redacts Basic credentials and OAuth parameters", () => {
    assert.deepEqual(
      sanitizeHermesToolValue({
        header: "Authorization: Basic dXNlcjpwYXNz",
        digest: "Digest username=abc",
        url: "https://example.test/cb?client_secret=abc&refresh_token=def&id_token=ghi",
        body: "client_secret: s3cret refresh_token=r3fresh",
      }),
      {
        header: "Authorization: Basic [REDACTED]",
        digest: "Digest [REDACTED]",
        url: "https://example.test/cb?client_secret=[REDACTED]",
        body: "client_secret: [REDACTED] refresh_token=[REDACTED]",
      },
    );
  });

  it("bounds oversized property names against the sanitized size budget", () => {
    const longKey = "k".repeat(100_000);
    const sanitized = sanitizeHermesToolValue({ [longKey]: "value", after: "kept" }) as Record<
      string,
      unknown
    >;
    const keys = Object.keys(sanitized);
    assert.isBelow(keys[0]?.length ?? 0, 300);
    assert.isTrue(keys[0]?.endsWith("[TRUNCATED 99744 CHARS]"));
    assert.equal(sanitized["after"], "kept");
    assert.isBelow(JSON.stringify(sanitized).length, 40_000);
  });

  it("stops emitting object entries once the size budget is exhausted", () => {
    const value = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`key-${index}-${"x".repeat(200)}`, "v"]),
    );
    const sanitized = sanitizeHermesToolValue(value, { maxChars: 1_000 }) as Record<
      string,
      unknown
    >;
    assert.isBelow(JSON.stringify(sanitized).length, 2_000);
    assert.isAbove(Number(sanitized["[TRUNCATED_KEYS]"]), 0);
  });

  it("stops emitting array entries once the size budget is exhausted", () => {
    const value = Array.from({ length: 100 }, () => "y".repeat(200));
    const sanitized = sanitizeHermesToolValue(value, { maxChars: 1_000 }) as Array<unknown>;
    assert.isBelow(JSON.stringify(sanitized).length, 2_000);
    assert.include(sanitized, "[TRUNCATED]");
  });
});
