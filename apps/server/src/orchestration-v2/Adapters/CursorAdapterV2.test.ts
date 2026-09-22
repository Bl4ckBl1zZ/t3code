import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CursorSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig, layerTest as serverConfigLayerTest } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  CursorProviderCapabilitiesV2,
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
  makeCursorAdapterV2,
  nestedToolCallFromEnvelope,
} from "./CursorAdapterV2.ts";
import { isCursorCancellationError, loggedCursorAgentOptions } from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

describe("CursorAdapterV2", () => {
  for (const status of ["finished", "cancelled", "error"] as const) {
    it.effect(`settles missing task completions when the Cursor run is ${status}`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cursor-v2-lifecycle-",
        });
        const instanceId = ProviderInstanceId.make("cursor");
        const threadId = ThreadId.make("cursor-lifecycle-thread");
        const modelSelection = { instanceId, model: "composer-2.5" };
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const adapter = makeCursorAdapterV2({
          instanceId,
          settings: yield* decodeCursorSettings({}),
          environment: { HOME: workspace },
          fileSystem,
          idAllocator: yield* IdAllocatorV2,
          serverConfig: yield* ServerConfig.pipe(
            Effect.provide(
              serverConfigLayerTest(workspace, { prefix: "cursor-v2-lifecycle-config-" }),
            ),
          ),
          runner: {
            assertComplete: Effect.void,
            open: () =>
              Effect.succeed({
                agentId: "native-cursor-lifecycle",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.gen(function* () {
                    yield* input.onDelta!({
                      type: "tool-call-started",
                      modelCallId: "model-call",
                      callId: "task-call",
                      toolCall: {
                        type: "task",
                        args: {
                          description: "Review",
                          prompt: "Review the code.",
                          subagentType: { kind: "generalPurpose" },
                        },
                      },
                    }).pipe(Effect.orDie);
                    return {
                      agentId: "native-cursor-lifecycle",
                      runId: "native-cursor-run",
                      wait: Effect.succeed({
                        id: "native-cursor-run",
                        requestId: "native-request",
                        status,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      }),
                      cancel: Effect.void,
                    };
                  }),
              }),
          },
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-lifecycle-session"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runId: RunId.make("cursor-lifecycle-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-lifecycle-attempt"),
          rootNodeId: NodeId.make("cursor-lifecycle-root"),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-lifecycle-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor lifecycle",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          message: {
            messageId: MessageId.make("cursor-lifecycle-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Review the code.",
            attachments: [],
          },
        });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const rows = events.filter((event) => event.type === "subagent.updated");
        assert.equal(rows[0]?.subagent.status, "running");
        assert.equal(
          rows.at(-1)?.subagent.status,
          status === "finished" ? "idle" : status === "cancelled" ? "cancelled" : "failed",
        );
        assert.isNotNull(rows.at(-1)?.subagent.completedAt);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, idAllocatorLayer))),
    );
  }

  it("maps Cursor auto and model parameters to SDK selections", () => {
    assert.deepEqual(
      cursorSdkModelSelection({
        instanceId: ProviderInstanceId.make("cursor"),
        model: "auto",
        options: [
          { id: "thinking", value: "high" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
      }),
      {
        id: "default",
        params: [
          { id: "thinking", value: "high" },
          { id: "context", value: "1m" },
          { id: "fast", value: "true" },
        ],
      },
    );
  });

  it("maps runtime modes to the SDK sandbox and auto-review controls", () => {
    const base = {
      interactionMode: "default" as const,
      cwd: "/tmp/cursor-adapter",
    };
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "full-access",
      }),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "auto-accept-edits",
      }),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "approval-required",
      }),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "full-access",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      }),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "approval-required",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
  });

  it("advertises only capabilities exposed by the official SDK adapter", () => {
    assert.isTrue(CursorProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isFalse(CursorProviderCapabilitiesV2.threads.canForkThread);
    assert.isFalse(CursorProviderCapabilitiesV2.threads.canRollbackThread);
    assert.isTrue(CursorProviderCapabilitiesV2.turns.supportsInterrupt);
    assert.isFalse(CursorProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.isTrue(CursorProviderCapabilitiesV2.turns.supportsSteeringByInterruptRestart);
    assert.isTrue(CursorProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(CursorProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isFalse(CursorProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.equal(CursorProviderCapabilitiesV2.identity.nativeItemIds, "weak");
    assert.isFalse(CursorProviderCapabilitiesV2.approvals.supportsCommandApproval);
  });

  it("injects thread-scoped MCP credentials without logging them", () => {
    const threadId = ThreadId.make("thread-cursor-mcp");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-cursor-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-cursor-mcp-token",
    });

    try {
      assert.deepEqual(cursorMcpServers(threadId), {
        "t3-code": {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: {
            Authorization: "Bearer secret-cursor-mcp-token",
          },
        },
      });

      const options = makeCursorAgentOptions({
        apiKey: "secret-cursor-api-key",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2.5",
        },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
        threadId,
      });
      assert.deepEqual(options.mcpServers, cursorMcpServers(threadId));

      const logged = JSON.stringify(loggedCursorAgentOptions(options));
      assert.notInclude(logged, "secret-cursor-api-key");
      assert.notInclude(logged, "secret-cursor-mcp-token");
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it("recognizes direct and SDK-wrapped abort failures as cancellation", () => {
    assert.isTrue(isCursorCancellationError({ name: "AbortError" }));
    assert.isTrue(
      isCursorCancellationError({
        name: "ConnectError",
        cause: {
          name: "ConnectError",
          cause: { name: "AbortError" },
        },
      }),
    );
    assert.isFalse(isCursorCancellationError(new Error("request failed")));
    assert.isFalse(isCursorCancellationError(null));
  });

  it("preserves failed nested read calls when Cursor omits their path", () => {
    assert.deepEqual(
      nestedToolCallFromEnvelope({
        toolCallId: "tool:failed-read",
        readToolCall: {
          args: {},
          result: { error: "File path was not provided." },
        },
      }),
      {
        callId: "tool:failed-read",
        toolCall: {
          type: "read",
          args: { path: "<unknown path>" },
          result: {
            status: "error",
            error: "File path was not provided.",
          },
        },
      },
    );
  });
});
