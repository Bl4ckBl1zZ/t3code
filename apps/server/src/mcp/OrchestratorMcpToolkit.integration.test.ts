import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpCreatedThread,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  ProviderThreadId,
  ProviderTurnId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2, type OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import { layer as threadManagementServiceLayer } from "../orchestration-v2/ThreadManagementService.ts";
import { threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import {
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "../orchestration-v2/ProviderContinuationRequests.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadSearchQuery } from "../orchestration-v2/ThreadSearchQuery.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

/** A declared tool failure: an error result whose text is the failure's JSON. */
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const foreignProjectId = ProjectId.make("project:mcp-foreign");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexModel = "gpt-5.4";
const claudeModel = "claude-sonnet-4-6";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const createdThreadPrompt = "Complete the newly created ordinary thread.";

const decodeCreateThreadsResult = Schema.decodeUnknownEffect(OrchestratorMcpCreateThreadsResult);
const decodeCreatedThread = Schema.decodeUnknownEffect(OrchestratorMcpCreatedThread);
const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeTaskCancelResult = Schema.decodeUnknownEffect(OrchestratorMcpTaskCancelResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeThreadWaitResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const claudeSelection = {
  instanceId: claudeInstanceId,
  model: claudeModel,
} satisfies ModelSelection;

interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
}

function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));
}

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly shouldComplete: (turn: ProviderAdapterV2TurnInput) => boolean;
  readonly response: (turn: ProviderAdapterV2TurnInput) => string;
}): ProviderAdapterV2Shape {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  instanceId: input.instanceId,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              if (!input.shouldComplete(turnInput)) {
                return;
              }
              const response = input.response(turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            PubSub.publish(events, {
              type: "turn.terminal",
              driver: input.driver,
              providerThreadId: providerThread.id,
              providerTurnId,
              runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            }).pipe(Effect.asVoid),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unsupported(input.driver, "readThreadSnapshot is unused in this test"),
          rollbackThread: () => unsupported(input.driver, "rollbackThread is unused in this test"),
          forkThread: () => unsupported(input.driver, "forkThread is unused in this test"),
        };
      }),
  };
}

function waitForProjection(
  orchestrator: OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (predicate(projection)) {
        return projection;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(
      new Error(`Timed out waiting for orchestration projection ${threadId}.`),
    );
  });
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** Build a persisted-looking ScheduledTask from an upsert input for the in-memory stub. */
function scheduledTaskFromUpsert(input: ScheduledTaskUpsertInput): ScheduledTask {
  const timestamp = IsoDateTime.make("2026-07-01T09:00:00.000Z");
  return {
    id: input.id ?? ScheduledTaskId.make(`scheduled-task:${input.commandId ?? "stub"}`),
    title: input.title,
    prompt: input.prompt,
    enabled: input.enabled,
    schedule:
      input.schedule.type === "webhook"
        ? {
            type: "webhook",
            signature:
              input.schedule.signature == null
                ? null
                : {
                    header: input.schedule.signature.header,
                    encoding: input.schedule.signature.encoding,
                    prefix: input.schedule.signature.prefix,
                  },
          }
        : input.schedule,
    projectId: input.projectId,
    threadId: input.threadId ?? null,
    workspaceStrategy: input.workspaceStrategy,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
}

/** In-memory server secret store for tests that exercise secret requests. */
const memorySecretStoreLayer = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

describe("orchestrator MCP toolkit", () => {
  it.live(
    "delegates cross-provider tasks, polls and cancels children, and creates ordinary threads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("orchestrator-mcp-toolkit");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const registryLayer = makeProviderAdapterRegistryLayer([
            makeDeterministicAdapter({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              capabilities: CodexProviderCapabilitiesV2,
              capturedTurns,
              shouldComplete: (turn) =>
                turn.threadId !== parentThreadId && turn.message.text !== cancellationPrompt,
              response: (turn) => `Codex completed: ${turn.message.text}`,
            }),
            makeDeterministicAdapter({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              capabilities: ClaudeProviderCapabilitiesV2,
              capturedTurns,
              shouldComplete: (turn) => turn.message.text !== cancellationPrompt,
              response: (turn) =>
                turn.message.text === delegatedPrompt
                  ? delegatedResult
                  : `Claude completed: ${turn.message.text}`,
            }),
          ]);
          // Captures parent-wake offers made when a delegated child
          // terminalizes after the parent run settled.
          const continuationOffers = yield* Ref.make<ReadonlyArray<ProviderContinuationRequest>>(
            [],
          );
          const continuationProbeLayer = Layer.succeed(ProviderContinuationRequests, {
            offer: (request) =>
              Ref.update(continuationOffers, (existing) => [...existing, request]),
            take: Effect.never,
          });
          // Absence has no event to await, so sample repeatedly instead of
          // trusting a single sleep to outlast a late offer.
          const expectOffersToStay = (count: number) =>
            Effect.gen(function* () {
              for (let sample = 0; sample < 4; sample += 1) {
                yield* Effect.sleep("50 millis");
                expect(yield* Ref.get(continuationOffers)).toHaveLength(count);
              }
            });
          const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
            {
              name: "orchestrator-mcp-toolkit",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            registryLayer,
          ).pipe(Layer.provide(continuationProbeLayer));
          const orchestrationLayer = Layer.merge(
            orchestratorLayer,
            threadManagementServiceLayer.pipe(Layer.provide(orchestratorLayer)),
          );
          const providerRegistryLayer = makeProviderRegistryLayer([
            makeProviderSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: codexModel,
              optionDescriptors: [
                {
                  id: "reasoning",
                  label: "Reasoning effort",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            }),
            makeProviderSnapshot({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              model: claudeModel,
            }),
            makeProviderSnapshot({
              instanceId: ProviderInstanceId.make("opencode"),
              driver: ProviderDriverKind.make("opencode"),
              model: "opencode/test",
            }),
          ]);
          // In-memory ScheduledTaskService stub so the schedule/list/update/
          // delete tools can be exercised without SQL/launch wiring.
          const scheduledStore = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
          const scheduledTaskStubLayer = Layer.succeed(
            ScheduledTaskService,
            ScheduledTaskService.of({
              list: () => Ref.get(scheduledStore).pipe(Effect.map((tasks) => ({ tasks }))),
              subscribeList: () => Stream.empty,
              upsert: (input) =>
                Effect.gen(function* () {
                  const task = scheduledTaskFromUpsert(input);
                  yield* Ref.update(scheduledStore, (all) => [
                    ...all.filter((candidate) => candidate.id !== task.id),
                    task,
                  ]);
                  return { task };
                }),
              setEnabled: () =>
                Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
              delete: (input) =>
                Ref.update(scheduledStore, (all) =>
                  all.filter((candidate) => candidate.id !== input.id),
                ).pipe(Effect.as({ id: input.id })),
              runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
              rotateWebhookToken: () => Effect.die("unused in this test"),
              listWebhookDeliveries: () => Effect.die("unused in this test"),
              getWebhookDelivery: () => Effect.die("unused in this test"),
              triggerWebhook: () => Effect.die("unused in this test"),
            }),
          );
          const testLayer = Layer.merge(
            McpHttpServer.OrchestratorToolkitRegistrationLive,
            McpHttpServer.ThreadToolkitRegistrationLive,
          ).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provideMerge(orchestrationLayer),
            Layer.provide(providerRegistryLayer),
            Layer.provide(scheduledTaskStubLayer),
            Layer.provide(
              Layer.mock(ProjectService)({
                getById: (id) =>
                  Effect.succeed(
                    id === projectId || id === foreignProjectId
                      ? Option.some({ id } as never)
                      : Option.none(),
                  ),
              }),
            ),
            // t3_thread_launch provisions real workspaces; this test covers the
            // tools that share this thread's checkout instead.
            Layer.provide(Layer.mock(ThreadLaunchService)({})),
            Layer.provide(Layer.mock(GitVcsDriver)({})),
            Layer.provide(Layer.mock(ThreadSearchQuery)({})),
            Layer.provideMerge(
              SecretRequests.layer.pipe(
                Layer.provide(memorySecretStoreLayer),
                Layer.provide(orchestrationLayer),
              ),
            ),
            Layer.provide(NodeServices.layer),
          );

          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const server = yield* McpServer.McpServer;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("message:mcp-parent:start"),
              text: parentPrompt,
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const parent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some((run) =>
                  ["starting", "running", "waiting"].includes(run.status),
                ) && projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const parentRun = parent.runs[0];
            expect(parentRun?.status).toBe("running");

            const invocation: McpInvocationContext.McpInvocationScope = {
              environmentId: EnvironmentId.make("environment:mcp-orchestrator"),
              requestNamespace: "mcp-provider-session-parent",
              thread: {
                threadId: parentThreadId,
                providerSessionId: "mcp-provider-session-parent",
                providerInstanceId: codexInstanceId,
              },
              client: undefined,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
            };
            const invoke = (name: string, args: Record<string, unknown>) =>
              server
                .callTool({ name, arguments: args })
                .pipe(
                  Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );

            const capabilitiesTool = server.tools.find(
              ({ tool }) => tool.name === "orchestrator_capabilities",
            );
            expect(capabilitiesTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(capabilitiesTool?.tool.annotations?.idempotentHint).toBe(true);
            const delegateTool = server.tools.find(({ tool }) => tool.name === "delegate_task");
            expect(delegateTool?.tool.annotations?.destructiveHint).toBe(true);
            expect(delegateTool?.tool.annotations?.openWorldHint).toBe(true);
            const createThreadsTool = server.tools.find(
              ({ tool }) => tool.name === "create_threads",
            );
            expect(createThreadsTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadListTool = server.tools.find(({ tool }) => tool.name === "t3_thread_list");
            expect(threadListTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(threadListTool?.tool.annotations?.idempotentHint).toBe(true);
            const threadReadTool = server.tools.find(({ tool }) => tool.name === "t3_thread_read");
            expect(threadReadTool?.tool.annotations?.readOnlyHint).toBe(true);
            const threadSendTool = server.tools.find(({ tool }) => tool.name === "t3_thread_send");
            expect(threadSendTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadWaitTool = server.tools.find(({ tool }) => tool.name === "t3_thread_wait");
            expect(threadWaitTool?.tool.annotations?.readOnlyHint).toBe(true);
            const threadInterruptTool = server.tools.find(
              ({ tool }) => tool.name === "t3_thread_interrupt",
            );
            expect(threadInterruptTool?.tool.annotations?.destructiveHint).toBe(true);

            const refusedSettle = yield* invoke("t3_thread_organize", { action: "settle" });
            expect(refusedSettle.isError).toBe(true);
            expect(refusedSettle.structuredContent).toBeUndefined();
            expect(declaredFailure(refusedSettle)).toEqual({
              _tag: "OrchestratorMcpFailure",
              code: "orchestration_error",
              message: `Thread ${parentThreadId} has active or blocked work and cannot be settled.`,
            });
            const afterRefusedSettle = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(afterRefusedSettle.thread.settledOverride).not.toBe("settled");
            expect(afterRefusedSettle.runs.find((run) => run.id === parentRun?.id)?.status).toBe(
              "running",
            );

            const pinned = yield* invoke("t3_thread_organize", { action: "pin" });
            expect(pinned.isError).toBe(false);
            expect(pinned.structuredContent).toHaveProperty("sequence");
            expect((yield* orchestrator.getThreadShell(parentThreadId))?.pinnedAt).not.toBeNull();
            yield* invoke("t3_thread_organize", { action: "unpin" });
            expect((yield* orchestrator.getThreadShell(parentThreadId))?.pinnedAt).toBeNull();

            if (parentRun === undefined) {
              return yield* Effect.die(new Error("Parent run missing."));
            }
            for (const name of ["t3_queue_edit", "t3_queue_cancel"]) {
              const refusedQueueMutation = yield* invoke(name, {
                queuedRunId: parentRun.id,
                ...(name === "t3_queue_edit" ? { text: "Keep the active turn." } : {}),
              });
              expect(refusedQueueMutation.isError).toBe(true);
              expect(refusedQueueMutation.structuredContent).toBeUndefined();
              expect(declaredFailure(refusedQueueMutation)).toEqual({
                _tag: "OrchestratorMcpFailure",
                code: "orchestration_error",
                message: `Run ${parentRun.id} is not queued.`,
              });
            }

            const queuePage = yield* invoke("t3_queue_list", { limit: 1 });
            expect(queuePage.isError).toBe(false);
            const queueDefinition = server.tools.find(({ tool }) => tool.name === "t3_queue_list");
            const validateQueue = new AjvJsonSchemaValidator().getValidator(
              queueDefinition!.tool.outputSchema! as JsonSchemaType,
            );
            expect(validateQueue(queuePage.structuredContent).valid).toBe(true);
            expect(validateQueue({ items: "invalid", nextCursor: null }).valid).toBe(false);
            const missingThreadId = ThreadId.make("00000000-0000-4000-8000-000000000000");
            const missingThreadQueue = yield* invoke("t3_queue_list", {
              threadId: missingThreadId,
              limit: 1,
            });
            expect(missingThreadQueue.isError).toBe(true);
            expect(declaredFailure(missingThreadQueue)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "thread_not_found",
              message: "The thread was not found.",
            });
            expect(missingThreadQueue.structuredContent).toBeUndefined();
            const missingThreadRead = yield* invoke("t3_thread_read", {
              threadId: missingThreadId,
            });
            expect(missingThreadRead.isError).toBe(true);
            expect(declaredFailure(missingThreadRead)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
            });

            const capabilities = yield* invoke("orchestrator_capabilities", {});
            expect(capabilities.isError).toBe(false);
            expect(capabilities.structuredContent).toMatchObject({
              inheritedProviderInstanceId: codexInstanceId,
              inheritedModel: codexModel,
              features: {
                appOwnedSubagents: true,
                asyncPolling: true,
                cancellation: true,
                batchThreadCreation: true,
                threadManagement: true,
                incrementalThreadRead: true,
              },
              providers: expect.arrayContaining([
                expect.objectContaining({
                  providerInstanceId: claudeInstanceId,
                  canRunCrossProviderChildTask: true,
                }),
                expect.objectContaining({
                  providerInstanceId: "opencode",
                  canRunChildTask: true,
                }),
                // Models advertise their option descriptors so agents can
                // discover valid target.options ids and values.
                expect.objectContaining({
                  providerInstanceId: codexInstanceId,
                  models: [
                    expect.objectContaining({
                      id: codexModel,
                      options: [expect.objectContaining({ id: "reasoning", type: "select" })],
                    }),
                  ],
                }),
              ]),
            });

            const scheduleTool = server.tools.find(({ tool }) => tool.name === "schedule_task");
            expect(scheduleTool?.tool.annotations?.destructiveHint).toBe(true);
            const scheduleCall = yield* invoke("schedule_task", {
              prompt: "wake up in this thread and say hello",
              schedule: { type: "interval", everyMs: 60_000 },
              clientRequestId: "schedule-hello-1",
            });
            expect(scheduleCall.isError).toBe(false);
            expect(scheduleCall.structuredContent).toMatchObject({
              // Defaults to binding the calling thread.
              boundThreadId: parentThreadId,
              projectId,
              enabled: true,
              schedule: { type: "interval", everyMs: 60_000 },
              // Title is derived from the prompt when omitted.
              title: "wake up in this thread and say hello",
            });
            const scheduledTaskId = (scheduleCall.structuredContent as { scheduledTaskId: string })
              .scheduledTaskId;
            const storedAfterCreate = yield* Ref.get(scheduledStore);
            expect(storedAfterCreate).toHaveLength(1);
            expect(storedAfterCreate[0]).toMatchObject({
              threadId: parentThreadId,
              projectId,
              createdBy: "agent",
              creationSource: "mcp",
              // Inherits the parent thread's model selection.
              modelSelection: codexSelection,
            });

            // list_scheduled_tasks returns the task scoped to this project.
            const scheduledListCall = yield* invoke("list_scheduled_tasks", {});
            expect(scheduledListCall.isError).toBe(false);
            expect(scheduledListCall.structuredContent).toMatchObject({
              tasks: [{ scheduledTaskId, boundThreadId: parentThreadId }],
            });

            // update_scheduled_task pauses without deleting.
            const scheduledUpdateCall = yield* invoke("update_scheduled_task", {
              scheduledTaskId,
              enabled: false,
            });
            expect(scheduledUpdateCall.isError).toBe(false);
            expect(scheduledUpdateCall.structuredContent).toMatchObject({
              scheduledTaskId,
              enabled: false,
            });

            // delete_scheduled_task removes it entirely.
            const scheduledDeleteCall = yield* invoke("delete_scheduled_task", { scheduledTaskId });
            expect(scheduledDeleteCall.isError).toBe(false);
            expect(scheduledDeleteCall.structuredContent).toMatchObject({
              scheduledTaskId,
              deleted: true,
            });
            expect(yield* Ref.get(scheduledStore)).toHaveLength(0);

            // OpenCode 1.15 has emitted this exact nested-object-as-JSON-string
            // shape. Decode it at the MCP boundary rather than failing a task
            // the model otherwise specified correctly.
            const serializedScheduleCall = yield* invoke("schedule_task", {
              prompt: "check for new pull requests",
              schedule: '{"type":"interval","everyMs":3600000}',
              clientRequestId: "schedule-opencode-compat-1",
            });
            expect(serializedScheduleCall.isError).toBe(false);
            expect(serializedScheduleCall.structuredContent).toMatchObject({
              schedule: { type: "interval", everyMs: 3_600_000 },
              boundThreadId: parentThreadId,
            });
            const serializedScheduledTaskId = (
              serializedScheduleCall.structuredContent as { scheduledTaskId: string }
            ).scheduledTaskId;
            yield* invoke("delete_scheduled_task", {
              scheduledTaskId: serializedScheduledTaskId,
            });
            expect(yield* Ref.get(scheduledStore)).toHaveLength(0);

            // The agent asks for a secret; the tool waits for the user and
            // returns a one-use ref, never the value, which a signed webhook
            // task then consumes.
            const secretRequests = yield* SecretRequests.SecretRequests;
            const secretFiber = yield* invoke("request_secret", {
              label: "GitHub webhook secret",
              reason: "Signs release webhooks. Enter the same value in GitHub's webhook settings.",
              placeholder: "Paste the webhook secret",
              clientRequestId: "release-webhook-secret",
            }).pipe(Effect.forkChild);
            // Polled without the helper's short budget: under load the tool's
            // own reads come first.
            const asked = yield* Effect.gen(function* () {
              while (true) {
                const projection = yield* orchestrator.getThreadProjection(parentThreadId);
                if (
                  projection.turnItems.some(
                    (item) => item.type === "secret_request" && item.secretStatus === "pending",
                  )
                ) {
                  return projection;
                }
                yield* Effect.sleep("5 millis");
              }
            });
            const card = asked.turnItems.find((item) => item.type === "secret_request");
            if (card?.type !== "secret_request") {
              return yield* Effect.die(new Error("Secret request card missing."));
            }
            expect(card).toMatchObject({
              label: "GitHub webhook secret",
              placeholder: "Paste the webhook secret",
            });
            // Asking again with the same id leaves the open card exactly as it was.
            yield* orchestrator.dispatch({
              type: "secret_request.record",
              commandId: CommandId.make("command:test:secret-request-replay"),
              threadId: parentThreadId,
              runId: card.runId!,
              nodeId: card.nodeId!,
              turnItemId: card.id,
              label: "Something else",
              reason: "A different reason.",
              secretStatus: "pending",
            });
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).turnItems.find(
                (item) => item.id === card.id,
              ),
            ).toMatchObject({ label: "GitHub webhook secret", runId: card.runId });
            // The agent is blocked on the user, so the thread asks for input
            // like a question does, in both shell paths.
            expect(
              (yield* orchestrator.getThreadShell(parentThreadId))?.pendingRuntimeRequest,
            ).toMatchObject({ kind: "user_input" });
            expect(threadShellFromProjection(asked).pendingRuntimeRequest).toMatchObject({
              kind: "user_input",
            });
            // What the card's Save sends (secrets.answerRequest).
            yield* secretRequests.answer({
              threadId: parentThreadId,
              turnItemId: card.id,
              answer: { type: "save", secret: "github-webhook-secret" },
            });
            const secretCall = yield* Fiber.join(secretFiber);
            expect(secretCall.isError).toBe(false);
            const secretResult = secretCall.structuredContent as {
              status: string;
              secretRef?: string;
            };
            expect(secretResult.status).toBe("saved");
            expect(
              (yield* orchestrator.getThreadShell(parentThreadId))?.pendingRuntimeRequest ?? null,
            ).toBeNull();
            expect(secretResult.secretRef).toMatch(/^secret-ref:[0-9a-f]{32}$/);
            // The value appears nowhere in what the agent received.
            const received = [
              ...secretCall.content.map((part) => ("text" in part ? part.text : "")),
              ...Object.values(secretResult),
            ];
            expect(received.some((value) => value.includes("github-webhook-secret"))).toBe(false);

            // A retry that lost the first result gets the same answer, with no
            // second card for the user.
            const retried = yield* invoke("request_secret", {
              label: "GitHub webhook secret",
              reason: "Signs release webhooks. Enter the same value in GitHub's webhook settings.",
              clientRequestId: "release-webhook-secret",
            });
            expect(retried.structuredContent).toEqual(secretResult);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).turnItems.filter(
                (item) => item.type === "secret_request",
              ),
            ).toHaveLength(1);

            // The ref is the secret for exactly one consumer.
            expect(
              yield* secretRequests.consume({
                ref: secretResult.secretRef as never,
                projectId,
              }),
            ).toBe("github-webhook-secret");
            const reused = yield* secretRequests
              .consume({ ref: secretResult.secretRef as never, projectId })
              .pipe(Effect.flip);
            expect(reused.message).toContain("already used");

            const delegatedCall = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              target: {
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
              mode: "wait",
              timeoutMs: 10_000,
              clientRequestId: "delegate-claude-1",
            });
            expect(delegatedCall.isError).toBe(false);
            const delegated = yield* decodeDelegateTaskResult(delegatedCall.structuredContent).pipe(
              Effect.orDie,
            );
            const delegatedSource = yield* orchestrator.getThreadProjection(
              delegated.childThreadId,
            );
            expect(delegatedSource.messages[0]).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(
              delegatedSource.turnItems.find((item) => item.type === "user_message"),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(delegated.status).toBe("completed");
            expect(delegated.summary).toBe(delegatedResult);
            expect(delegated.providerInstanceId).toBe(claudeInstanceId);

            const completedParent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.subagents.some(
                  (task) =>
                    task.id === delegated.taskId &&
                    task.status === "completed" &&
                    task.result === delegatedResult,
                ) &&
                projection.contextTransfers.some(
                  (transfer) =>
                    transfer.type === "subagent_result" &&
                    transfer.sourceThreadId === delegated.childThreadId,
                ),
            );
            const completedTask = completedParent.subagents.find(
              (task) => task.id === delegated.taskId,
            );
            expect(completedTask).toMatchObject({
              origin: "app_owned",
              createdBy: "agent",
              childThreadId: delegated.childThreadId,
              status: "completed",
              result: delegatedResult,
            });
            const child = yield* orchestrator.getThreadProjection(delegated.childThreadId);
            expect(child.thread.lineage).toEqual({
              parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: parentThreadId,
            });
            expect(child.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(child.thread.modelSelection).toEqual(claudeSelection);
            expect(
              child.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual([delegatedPrompt]);
            expect(
              child.contextTransfers.some(
                (transfer) =>
                  transfer.type === "subagent_spawn" && transfer.sourceThreadId === parentThreadId,
              ),
            ).toBe(true);
            const capturedAfterDelegate = yield* Ref.get(capturedTurns);
            expect(
              capturedAfterDelegate.filter((turn) => turn.threadId === delegated.childThreadId),
            ).toEqual([
              {
                instanceId: claudeInstanceId,
                threadId: delegated.childThreadId,
                text: delegatedPrompt,
              },
            ]);
            expect(
              capturedAfterDelegate.some(
                (turn) =>
                  turn.threadId === delegated.childThreadId && turn.text.includes(parentPrompt),
              ),
            ).toBe(false);

            const delegatedStatusCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatus = yield* decodeDelegateTaskResult(
              delegatedStatusCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatus.status).toBe("completed");
            expect(delegatedStatus.resultContextTransferId).not.toBeNull();

            const childFollowupCall = yield* invoke("t3_thread_send", {
              threadId: delegated.childThreadId,
              message: "Confirm the delegated API boundary remains inspected.",
              clientRequestId: "delegated-child-followup-1",
            });
            const childFollowup = yield* decodeThreadSendResult(
              childFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            const childFollowupWaitCall = yield* invoke("t3_thread_wait", {
              threadId: delegated.childThreadId,
              runId: childFollowup.runId,
              timeoutMs: 10_000,
            });
            const childFollowupWait = yield* decodeThreadWaitResult(
              childFollowupWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(childFollowupWait).toMatchObject({
              runId: childFollowup.runId,
              status: "completed",
              timedOut: false,
            });
            const delegatedStatusAfterFollowupCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatusAfterFollowup = yield* decodeDelegateTaskResult(
              delegatedStatusAfterFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatusAfterFollowup).toMatchObject({
              childRunId: delegated.childRunId,
              status: "completed",
              summary: delegatedResult,
            });

            const activeChildFollowupCall = yield* invoke("t3_thread_send", {
              threadId: delegated.childThreadId,
              message: cancellationPrompt,
              clientRequestId: "delegated-child-active-followup-1",
            });
            const activeChildFollowup = yield* decodeThreadSendResult(
              activeChildFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            yield* waitForProjection(orchestrator, delegated.childThreadId, (projection) =>
              projection.runs.some(
                (run) => run.id === activeChildFollowup.runId && run.status === "running",
              ),
            );
            const completedTaskCancelCall = yield* invoke("task_cancel", {
              taskId: delegated.taskId,
              reason: "Stop the child's later work too.",
              clientRequestId: "cancel-completed-delegated-task-1",
            });
            const completedTaskCancel = yield* decodeTaskCancelResult(
              completedTaskCancelCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(completedTaskCancel).toEqual({
              taskId: delegated.taskId,
              status: "completed",
            });
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === delegated.taskId,
              ),
            ).toMatchObject({
              result: delegatedResult,
              completionDelivery: { state: "disposed" },
            });
            // Cancelling a finished task still stops the child thread's later work.
            yield* waitForProjection(orchestrator, delegated.childThreadId, (projection) =>
              projection.runs.some(
                (run) => run.id === activeChildFollowup.runId && run.status === "interrupted",
              ),
            );

            // A wait-mode child (completionWake settled_only) that completes
            // while the parent run is live does not offer a wake: the
            // blocking delegate_task call above already returned the result.
            yield* expectOffersToStay(0);

            const repeatedDelegatedCall = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              target: {
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
              mode: "async",
              clientRequestId: "delegate-claude-1",
            });
            const repeatedDelegated = yield* decodeDelegateTaskResult(
              repeatedDelegatedCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedDelegated.taskId).toBe(delegated.taskId);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
                (task) => task.id === delegated.taskId,
              ),
            ).toHaveLength(1);

            // Options outside the model's advertised descriptors are rejected
            // before any child thread is created.
            const rejectedOptionsCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: { reasoning: "extreme" },
              },
              mode: "async",
              clientRequestId: "delegate-rejected-options-1",
            });
            expect(rejectedOptionsCall.isError).toBe(true);
            expect(declaredFailure(rejectedOptionsCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining("rejected options"),
            });

            // Duplicate option ids fail fast: downstream consumers disagree on
            // whether the first or last value of a duplicated id wins.
            const duplicateOptionsCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: [
                  { id: "reasoning", value: "low" },
                  { id: "reasoning", value: "high" },
                ],
              },
              mode: "async",
              clientRequestId: "delegate-duplicate-options-1",
            });
            expect(duplicateOptionsCall.isError).toBe(true);
            expect(declaredFailure(duplicateOptionsCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining("more than once"),
            });

            const cancellableCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                // Shorthand record form; decodes to the canonical array.
                options: { reasoning: "low" },
              },
              mode: "async",
              clientRequestId: "delegate-cancel-1",
            });
            const cancellable = yield* decodeDelegateTaskResult(
              cancellableCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(cancellable.status).toBe("running");
            yield* waitForProjection(orchestrator, cancellable.childThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            // The requested model options reach the child thread's selection.
            const optionedChild = yield* orchestrator.getThreadProjection(
              cancellable.childThreadId,
            );
            expect(optionedChild.thread.modelSelection).toEqual({
              instanceId: codexInstanceId,
              model: codexModel,
              options: [{ id: "reasoning", value: "low" }],
            });
            const cancelCall = yield* invoke("task_cancel", {
              taskId: cancellable.taskId,
              reason: "Parent no longer needs this work.",
              clientRequestId: "cancel-1",
            });
            const cancelResult = yield* decodeTaskCancelResult(cancelCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(cancelResult.status).toBe("cancel_requested");
            yield* waitForProjection(orchestrator, cancellable.childThreadId, (projection) =>
              projection.runs.some((run) => run.status === "interrupted"),
            );
            const cancelledStatusCall = yield* invoke("task_status", {
              taskId: cancellable.taskId,
            });
            const cancelledStatus = yield* decodeDelegateTaskResult(
              cancelledStatusCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(cancelledStatus.status).toBe("interrupted");

            // Cancelling says the caller no longer wants this outcome, so
            // task_cancel disposes the task's completion delivery: the cohort
            // announces nothing and arms no successor, even though the child
            // carries completionWake "always".
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) =>
                  task.id === cancellable.taskId && task.completionDelivery?.state === "disposed",
              ),
            );
            yield* expectOffersToStay(0);
            const parentAfterCancel = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(
              parentAfterCancel.runs.filter(
                (run) =>
                  run.status === "queued" &&
                  parentAfterCancel.messages.some(
                    (message) =>
                      message.id === run.userMessageId && message.delegatedCompletion !== undefined,
                  ),
              ),
            ).toHaveLength(0);

            const createInput = {
              clientRequestId: "create-thread-batch-1",
              threads: [
                {
                  title: "Inherited empty thread",
                },
                {
                  title: "Claude ordinary thread",
                  prompt: createdThreadPrompt,
                  target: {
                    driverKind: "claudeAgent",
                  },
                },
              ],
            };
            const createCall = yield* invoke("create_threads", createInput);
            expect(createCall.isError).toBe(false);
            const created = yield* decodeCreateThreadsResult(createCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(created.threads).toHaveLength(2);
            const emptyThread = created.threads[0]!;
            const promptedThread = created.threads[1]!;
            expect(emptyThread).toMatchObject({
              status: "idle",
              createdBy: "agent",
              creationSource: "mcp",
              providerInstanceId: codexInstanceId,
              model: codexModel,
            });
            expect(promptedThread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
              providerInstanceId: claudeInstanceId,
              model: claudeModel,
            });
            const createdSource = yield* orchestrator.getThreadProjection(promptedThread.threadId);
            expect(createdSource.messages[0]).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(
              createdSource.turnItems.find((item) => item.type === "user_message"),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            const emptyProjection = yield* orchestrator.getThreadProjection(emptyThread.threadId);
            expect(emptyProjection.thread.lineage).toEqual({
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: emptyThread.threadId,
            });
            expect(emptyProjection.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(emptyProjection.thread.forkedFrom).toBeNull();
            expect(emptyProjection.runs).toEqual([]);
            const promptedProjection = yield* waitForProjection(
              orchestrator,
              promptedThread.threadId,
              (projection) => projection.runs.some((run) => run.status === "completed"),
            );
            expect(promptedProjection.thread.lineage.parentThreadId).toBeNull();
            expect(
              promptedProjection.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual([createdThreadPrompt]);
            const createdThreadItems = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).visibleTurnItems
              .map((row) => row.item)
              .filter((item) => item.type === "thread_created");
            expect(
              createdThreadItems.map((item) => ({
                targetThreadId: item.targetThreadId,
                targetRunId: item.targetRunId,
                title: item.title,
                providerInstanceId: item.targetProviderInstanceId,
                model: item.targetModel,
              })),
            ).toEqual([
              {
                targetThreadId: emptyThread.threadId,
                targetRunId: null,
                title: emptyThread.title,
                providerInstanceId: codexInstanceId,
                model: codexModel,
              },
              {
                targetThreadId: promptedThread.threadId,
                targetRunId: promptedThread.runId,
                title: promptedThread.title,
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
            ]);

            const repeatedCreateCall = yield* invoke("create_threads", createInput);
            const repeatedCreated = yield* decodeCreateThreadsResult(
              repeatedCreateCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedCreated.threads.map((thread) => thread.threadId)).toEqual(
              created.threads.map((thread) => thread.threadId),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).visibleTurnItems.filter(
                (row) => {
                  if (row.item.type !== "thread_created") return false;
                  const targetThreadId = row.item.targetThreadId;
                  return created.threads.some((thread) => thread.threadId === targetThreadId);
                },
              ),
            ).toHaveLength(2);

            const promptedReadCall = yield* invoke("t3_thread_read", {
              threadId: promptedThread.threadId,
              limit: 1,
            });
            const promptedRead = yield* decodeThreadReadResult(
              promptedReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(promptedRead.thread.status).toBe("completed");
            expect(promptedRead.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(promptedRead.items.map((item) => item.type)).toEqual(["user_message"]);
            expect(promptedRead.items[0]).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(promptedRead.hasMore).toBe(true);
            const promptedReadNextCall = yield* invoke("t3_thread_read", {
              threadId: promptedThread.threadId,
              afterPosition: promptedRead.nextPosition,
              limit: 1,
            });
            const promptedReadNext = yield* decodeThreadReadResult(
              promptedReadNextCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(promptedReadNext.items.map((item) => item.type)).toEqual(["assistant_message"]);
            expect(promptedReadNext.items[0]?.text).toBe(
              `Claude completed: ${createdThreadPrompt}`,
            );

            const forkedThreadId = ThreadId.make("thread:mcp-orchestrator-inherited-read");
            yield* orchestrator.dispatch({
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-orchestrator-inherited-read"),
              sourceThreadId: promptedThread.threadId,
              targetThreadId: forkedThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Inherited read thread",
            });
            const forkedProjection = yield* orchestrator.getThreadProjection(forkedThreadId);
            expect(forkedProjection.messages).toEqual([]);
            expect(
              forkedProjection.visibleTurnItems.some(
                (row) =>
                  row.sourceThreadId === promptedThread.threadId &&
                  row.item.type === "user_message",
              ),
            ).toBe(true);

            const forkedReadCall = yield* invoke("t3_thread_read", {
              threadId: forkedThreadId,
            });
            const forkedRead = yield* decodeThreadReadResult(forkedReadCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(
              forkedRead.items.find((item) => item.text === createdThreadPrompt),
            ).toMatchObject({
              sourceThreadId: promptedThread.threadId,
              createdBy: "agent",
              creationSource: "mcp",
            });

            const ordinaryLoopPrompt = "Run an ordinary thread loop iteration.";
            const sendCall = yield* invoke("t3_thread_send", {
              threadId: emptyThread.threadId,
              message: ordinaryLoopPrompt,
              clientRequestId: "ordinary-loop-send-1",
            });
            const sent = yield* decodeThreadSendResult(sendCall.structuredContent).pipe(
              Effect.orDie,
            );
            const sentSource = yield* orchestrator.getThreadProjection(emptyThread.threadId);
            expect(
              sentSource.messages.find((message) => message.id === sent.messageId),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(
              sentSource.turnItems.find(
                (item) => item.type === "user_message" && item.messageId === sent.messageId,
              ),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(sent.delivery).toBe("started");
            const waitCall = yield* invoke("t3_thread_wait", {
              threadId: emptyThread.threadId,
              runId: sent.runId,
              timeoutMs: 10_000,
            });
            const waited = yield* decodeThreadWaitResult(waitCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(waited).toMatchObject({
              runId: sent.runId,
              status: "completed",
              timedOut: false,
            });
            const repeatedSendCall = yield* invoke("t3_thread_send", {
              threadId: emptyThread.threadId,
              message: ordinaryLoopPrompt,
              clientRequestId: "ordinary-loop-send-1",
            });
            const repeatedSend = yield* decodeThreadSendResult(
              repeatedSendCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedSend.runId).toBe(sent.runId);
            expect(
              (yield* orchestrator.getThreadProjection(emptyThread.threadId)).runs,
            ).toHaveLength(1);

            const activeThreadCall = yield* invoke("create_threads", {
              threads: [{ prompt: cancellationPrompt, title: "Managed active thread" }],
              clientRequestId: "managed-active-thread-1",
            });
            const activeThread = (yield* decodeCreateThreadsResult(
              activeThreadCall.structuredContent,
            ).pipe(Effect.orDie)).threads[0]!;
            const activeThreadItem = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).visibleTurnItems
              .map((row) => row.item)
              .find(
                (item) =>
                  item.type === "thread_created" && item.targetThreadId === activeThread.threadId,
              );
            expect(activeThreadItem).toMatchObject({
              type: "thread_created",
              title: "Managed active thread",
              targetThreadId: activeThread.threadId,
              targetRunId: activeThread.runId,
              targetProviderInstanceId: codexInstanceId,
              targetModel: codexModel,
            });
            const activeProjection = yield* waitForProjection(
              orchestrator,
              activeThread.threadId,
              (projection) =>
                projection.runs.some((run) => run.status === "running") &&
                projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const activeRun = activeProjection.runs[0]!;
            const activeTimeoutCall = yield* invoke("t3_thread_wait", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
              timeoutMs: 1,
            });
            const activeTimeout = yield* decodeThreadWaitResult(
              activeTimeoutCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(activeTimeout).toMatchObject({
              runId: activeRun.id,
              status: "running",
              timedOut: true,
            });
            const steerCall = yield* invoke("t3_thread_send", {
              threadId: activeThread.threadId,
              message: "Include the latest parent guidance before finishing.",
              mode: "steer",
              clientRequestId: "managed-active-steer-1",
            });
            const steered = yield* decodeThreadSendResult(steerCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(steered).toMatchObject({
              runId: activeRun.id,
              delivery: "steered",
            });
            const steeredSource = yield* orchestrator.getThreadProjection(activeThread.threadId);
            expect(
              steeredSource.messages.find((message) => message.id === steered.messageId),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            expect(
              steeredSource.turnItems.find(
                (item) => item.type === "user_message" && item.messageId === steered.messageId,
              ),
            ).toMatchObject({
              senderThreadId: parentThreadId,
            });
            const interruptCall = yield* invoke("t3_thread_interrupt", {
              threadId: activeThread.threadId,
              reason: "The orchestration loop has enough evidence.",
              clientRequestId: "managed-active-interrupt-1",
            });
            const interrupted = yield* decodeThreadInterruptResult(
              interruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(interrupted).toMatchObject({
              runId: activeRun.id,
              status: "interrupt_requested",
            });
            const interruptedWaitCall = yield* invoke("t3_thread_wait", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
              timeoutMs: 10_000,
            });
            const interruptedWait = yield* decodeThreadWaitResult(
              interruptedWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(interruptedWait.status).toBe("interrupted");
            const repeatedInterruptCall = yield* invoke("t3_thread_interrupt", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
            });
            const repeatedInterrupt = yield* decodeThreadInterruptResult(
              repeatedInterruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedInterrupt.status).toBe("interrupted");

            const foreignThreadId = ThreadId.make("thread:mcp-foreign-project");
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-foreign-project:create"),
              threadId: foreignThreadId,
              projectId: foreignProjectId,
              title: "Foreign project thread",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            const foreignReadCall = yield* invoke("t3_thread_read", {
              threadId: foreignThreadId,
            });
            // Targets reach the whole environment; the caller's modes still cap writes.
            expect(foreignReadCall.structuredContent).toMatchObject({
              thread: { threadId: foreignThreadId, projectId: foreignProjectId },
            });
            const foreignUpdateCall = yield* invoke("t3_thread_update", {
              threadId: foreignThreadId,
              action: "rename",
              title: "Renamed from another project",
            });
            expect(foreignUpdateCall.structuredContent).toMatchObject({
              threadId: foreignThreadId,
              title: "Renamed from another project",
            });
            const foreignListCall = yield* invoke("t3_thread_list", {
              projectId: foreignProjectId,
            });
            const foreignListed = yield* decodeThreadListResult(
              foreignListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(foreignListed.projectId).toBe(foreignProjectId);
            expect(foreignListed.threads.map((thread) => thread.threadId)).toEqual([
              foreignThreadId,
            ]);
            // Scheduled work in another project launches fresh threads there; it
            // cannot bind to the calling thread, which lives elsewhere.
            const foreignScheduleCall = yield* invoke("schedule_task", {
              projectId: foreignProjectId,
              prompt: "check the foreign project",
              schedule: { type: "interval", everyMs: 60_000 },
            });
            expect(foreignScheduleCall.structuredContent).toMatchObject({
              projectId: foreignProjectId,
              boundThreadId: null,
            });
            const foreignScheduledListCall = yield* invoke("list_scheduled_tasks", {
              projectId: foreignProjectId,
            });
            expect(foreignScheduledListCall.structuredContent).toMatchObject({
              tasks: [{ projectId: foreignProjectId, boundThreadId: null }],
            });
            const boundForeignScheduleCall = yield* invoke("schedule_task", {
              projectId: foreignProjectId,
              prompt: "check the foreign project from here",
              schedule: { type: "interval", everyMs: 60_000 },
              bindToCurrentThread: true,
            });
            expect(boundForeignScheduleCall.isError).toBe(true);
            expect(declaredFailure(boundForeignScheduleCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
            });
            const missingProjectScheduleCall = yield* invoke("schedule_task", {
              projectId: "project:mcp-missing",
              prompt: "check a project that does not exist",
              schedule: { type: "interval", everyMs: 60_000 },
            });
            expect(missingProjectScheduleCall.isError).toBe(true);
            expect(declaredFailure(missingProjectScheduleCall)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
            });
            const listCall = yield* invoke("t3_thread_list", {
              includeSubagents: false,
              limit: 100,
            });
            const listed = yield* decodeThreadListResult(listCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(listed.projectId).toBe(projectId);
            expect(listed.threads.map((thread) => thread.threadId)).toEqual(
              expect.arrayContaining([
                parentThreadId,
                emptyThread.threadId,
                promptedThread.threadId,
                activeThread.threadId,
              ]),
            );
            expect(
              listed.threads.find((thread) => thread.threadId === emptyThread.threadId),
            ).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(listed.threads.some((thread) => thread.threadId === foreignThreadId)).toBe(
              false,
            );
            expect(
              listed.threads.some((thread) => thread.relationshipToParent === "subagent"),
            ).toBe(false);
            expect(
              listed.threads.find((thread) => thread.threadId === emptyThread.threadId),
            ).toMatchObject({ settled: false, settledAt: null });

            yield* orchestrator.dispatch({
              type: "thread.settle",
              commandId: CommandId.make("command:mcp-empty:settle"),
              threadId: emptyThread.threadId,
              settledAt: "2026-01-01T00:00:00.000Z",
            });
            const settledReadCall = yield* invoke("t3_thread_read", {
              threadId: emptyThread.threadId,
            });
            const settledRead = yield* decodeThreadReadResult(
              settledReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(settledRead.thread).toMatchObject({
              settled: true,
              settledAt: "2026-01-01T00:00:00.000Z",
            });
            const settledListCall = yield* invoke("t3_thread_list", { settled: true, limit: 100 });
            const settledList = yield* decodeThreadListResult(
              settledListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(settledList.threads.map((thread) => thread.threadId)).toEqual([
              emptyThread.threadId,
            ]);
            expect(settledList.threads[0]).toMatchObject({
              settled: true,
              settledAt: "2026-01-01T00:00:00.000Z",
            });
            const activeListCall = yield* invoke("t3_thread_list", { settled: false, limit: 100 });
            const activeList = yield* decodeThreadListResult(activeListCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(
              activeList.threads.some((thread) => thread.threadId === emptyThread.threadId),
            ).toBe(false);
            yield* orchestrator.dispatch({
              type: "thread.unsettle",
              commandId: CommandId.make("command:mcp-empty:unsettle"),
              threadId: emptyThread.threadId,
              reason: "user",
            });

            expect(
              listed.threads.find((thread) => thread.threadId === emptyThread.threadId),
            ).toMatchObject({ snoozed: false, snoozedUntil: null });
            yield* orchestrator.dispatch({
              type: "thread.snooze",
              commandId: CommandId.make("command:mcp-empty:snooze"),
              threadId: emptyThread.threadId,
              snoozedUntil: "2099-01-01T00:00:00.000Z",
            });
            const snoozedListCall = yield* invoke("t3_thread_list", { snoozed: true, limit: 100 });
            const snoozedList = yield* decodeThreadListResult(
              snoozedListCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(snoozedList.threads.map((thread) => thread.threadId)).toEqual([
              emptyThread.threadId,
            ]);
            expect(snoozedList.threads[0]).toMatchObject({
              snoozed: true,
              snoozedUntil: "2099-01-01T00:00:00.000Z",
            });
            const snoozedReadCall = yield* invoke("t3_thread_read", {
              threadId: emptyThread.threadId,
            });
            const snoozedRead = yield* decodeThreadReadResult(
              snoozedReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(snoozedRead.thread).toMatchObject({
              snoozed: true,
              snoozedUntil: "2099-01-01T00:00:00.000Z",
            });
            yield* orchestrator.dispatch({
              type: "thread.unsnooze",
              commandId: CommandId.make("command:mcp-empty:unsnooze"),
              threadId: emptyThread.threadId,
              reason: "user",
            });

            // A wait-mode delegation whose blocking wait times out no longer
            // owns delivery, so delegate_task upgrades the task to "always".
            // Its terminal then wakes the parent even mid-turn.
            const upgradedCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
              },
              mode: "wait",
              timeoutMs: 1,
              clientRequestId: "delegate-wait-upgrade-1",
            });
            const upgradedDelegated = yield* decodeDelegateTaskResult(
              upgradedCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(upgradedDelegated.status).toBe("running");
            yield* waitForProjection(orchestrator, upgradedDelegated.childThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === upgradedDelegated.taskId,
              )?.completionWake,
            ).toBe("always");
            const upgradeCancelCall = yield* invoke("task_cancel", {
              taskId: upgradedDelegated.taskId,
              reason: "Terminalize while the parent run is live.",
              clientRequestId: "cancel-wait-upgrade-1",
            });
            expect(upgradeCancelCall.isError).toBe(false);
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) => task.id === upgradedDelegated.taskId && task.status === "interrupted",
              ),
            );
            // Cancelled, so its delivery is disposed rather than announced.
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) =>
                  task.id === upgradedDelegated.taskId &&
                  task.completionDelivery?.state === "disposed",
              ),
            );
            yield* expectOffersToStay(0);

            // The MCP tool cannot force the reverse interleaving (child
            // terminal before the upgrade lands), so dispatch the command
            // directly. The first wait-mode delegation completed while the
            // parent run was live, so finalize skipped its offer under
            // settled_only; the upgrade must accept, persist the policy, and
            // deliver the wake finalize declined.
            const terminalUpgrade = yield* orchestrator.dispatch({
              type: "delegated_task.wake-policy",
              commandId: CommandId.make("command:mcp-parent:wake-policy-terminal"),
              parentThreadId,
              taskId: delegated.taskId,
              completionWake: "always",
            });
            expect(
              terminalUpgrade.storedEvents.some(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === delegated.taskId &&
                  stored.event.payload.completionWake === "always",
              ),
            ).toBe(true);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === delegated.taskId,
              )?.completionWake,
            ).toBe("always");
            // This is the redundancy the cohort model removes: the wait-mode
            // delegation already returned this result to the agent, and the
            // later task_status read acknowledged it. Upgrading the wake policy
            // must not resurrect a turn announcing what the agent has read.
            // task_status acknowledged this result and task_cancel then
            // dismissed it, so both suppression paths have run.
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === delegated.taskId,
              )?.completionDelivery?.state,
            ).toBe("disposed");
            yield* expectOffersToStay(0);

            // Legacy records omit completionWake and stay settled_only. The
            // MCP service always sets the field now, so dispatch the request
            // directly to cover the legacy shape.
            if (parentRun === undefined || parentRun.rootNodeId === null) {
              return yield* Effect.die(new Error("Parent run missing."));
            }
            const legacyDispatch = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-parent:delegate-legacy"),
              parentThreadId,
              parentRunId: parentRun.id,
              parentNodeId: parentRun.rootNodeId,
              task: cancellationPrompt,
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            });
            const legacyTaskEvent = legacyDispatch.storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (legacyTaskEvent?.event.type !== "subagent.updated") {
              return yield* Effect.die(new Error("Legacy delegated task projection missing."));
            }
            const legacyTask = legacyTaskEvent.event.payload;
            expect(legacyTask.completionWake).toBeUndefined();
            if (legacyTask.childThreadId === null) {
              return yield* Effect.die(new Error("Legacy delegated task child thread missing."));
            }
            const legacyChildThreadId = legacyTask.childThreadId;
            yield* waitForProjection(orchestrator, legacyChildThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            // Nothing terminalized here, so the offer count must hold.
            yield* expectOffersToStay(0);

            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-parent:interrupt-wake"),
              threadId: parentThreadId,
              runId: parentRun.id,
              reason: "Settle the parent before the legacy child terminalizes.",
            });
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.runs.every(
                (run) =>
                  run.status !== "preparing" &&
                  run.status !== "starting" &&
                  run.status !== "running",
              ),
            );
            // task_cancel acts as the calling thread, which has no live run
            // once it settled, so the parent's agent can no longer cancel.
            const legacyCancelCall = yield* invoke("task_cancel", {
              taskId: legacyTask.id,
              reason: "Terminalize the legacy child after the parent settled.",
              clientRequestId: "cancel-legacy-1",
            });
            expect(declaredFailure(legacyCancelCall)).toMatchObject({ code: "parent_not_active" });
            // The user stops the child and dismisses its delivery instead, as
            // task_cancel would have.
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("command:mcp-parent:stop-legacy-after-parent-settled"),
              threadId: legacyChildThreadId,
              reason: "Terminalize the legacy child after the parent settled.",
            });
            yield* waitForProjection(orchestrator, legacyChildThreadId, (projection) =>
              projection.runs.some((run) => run.status === "interrupted"),
            );
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.dispose",
              commandId: CommandId.make("command:mcp-parent:dispose-legacy-delivery"),
              parentThreadId,
              taskId: legacyTask.id,
            });
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) =>
                  task.id === legacyTask.id && task.completionDelivery?.state === "disposed",
              ),
            );
            yield* expectOffersToStay(0);

            // Same command against a terminal task whose delivery was already
            // disposed: the policy must persist without
            // reviving a wake the caller explicitly dismissed.
            const settledUpgrade = yield* orchestrator.dispatch({
              type: "delegated_task.wake-policy",
              commandId: CommandId.make("command:mcp-parent:wake-policy-settled"),
              parentThreadId,
              taskId: legacyTask.id,
              completionWake: "always",
            });
            expect(
              settledUpgrade.storedEvents.some(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === legacyTask.id &&
                  stored.event.payload.completionWake === "always",
              ),
            ).toBe(true);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === legacyTask.id,
              )?.completionWake,
            ).toBe("always");
            yield* expectOffersToStay(0);
          }).pipe(Effect.provide(testLayer));
        }),
      ),
  );
});
