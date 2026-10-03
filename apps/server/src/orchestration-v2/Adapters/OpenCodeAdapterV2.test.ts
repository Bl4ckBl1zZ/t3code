import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  OpenCodeSettings,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import type { OpenCodeRuntimeShape } from "../../provider/opencodeRuntime.ts";

import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";

import {
  openCodeBoundaryAfterProviderTurn,
  openCodeChildPermissionRules,
  openCodePermissionRules,
  openCodePermissionRequestKind,
  openCodeToolProjectionKind,
  makeOpenCodeAdapterV2,
  makeOpenCodeProtocolLogger,
  OPENCODE_PROVIDER,
} from "./OpenCodeAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const OPENCODE_TEST_SETTINGS = Schema.decodeUnknownSync(OpenCodeSettings)({});

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opencode-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

/**
 * A native event stream the test feeds by hand. `push` resolves once the
 * adapter has finished handling the event and asked for the next one.
 */
function asyncEventStream() {
  const values: Array<{ value: unknown; handled: () => void }> = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let previousHandled: (() => void) | undefined;
  return {
    push(value: unknown) {
      return new Promise<void>((handled) => {
        const waiter = waiters.shift();
        if (waiter) {
          previousHandled = handled;
          waiter({ done: false, value });
        } else values.push({ value, handled });
      });
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            previousHandled?.();
            const entry = values.shift();
            if (entry !== undefined) {
              previousHandled = entry.handled;
              return Promise.resolve({ done: false as const, value: entry.value });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

function runtimePolicy(
  runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapterV2RuntimePolicy {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
    ...override,
  });
}

function permissionAction(rules: ReturnType<typeof openCodePermissionRules>, permission: string) {
  return rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)
    ?.action;
}

function providerTurn(input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(input.id),
    providerThreadId: ProviderThreadId.make("provider-thread:opencode-test"),
    nodeId: NodeId.make(`node:${input.id}`),
    runAttemptId: null,
    nativeTurnRef:
      input.nativeId === null
        ? null
        : { driver: OPENCODE_PROVIDER, nativeId: input.nativeId, strength: "weak" },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: null,
    completedAt: null,
  };
}

describe("OpenCodeAdapterV2", () => {
  it.effect("logs bounded structural protocol diagnostics without native payload values", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const records: Array<unknown> = [];
      const nativeEventLogger: EventNdjsonLogger = {
        filePath: "/tmp/provider-native.ndjson",
        write: (event) => Effect.sync(() => void records.push(event)),
        close: () => Effect.void,
      };
      const logProtocolEvent = makeOpenCodeProtocolLogger({
        nativeEventLogger,
        idAllocator,
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        providerSessionId: ProviderSessionId.make("provider-session-opencode-test"),
        threadId: ThreadId.make("thread-opencode-test"),
      });
      const secret = "secret-opencode-prompt";

      yield* logProtocolEvent({
        direction: "outgoing",
        messageKind: "request",
        method: "session.prompt",
        payload: { prompt: secret, nested: { token: secret } },
      });

      const serialized = encodeUnknownJson(records);
      assert.notInclude(serialized, secret);
      assert.include(serialized, '"protocol":"opencode-sdk.sse"');
      assert.include(serialized, '"method":"session.prompt"');
      assert.include(serialized, '"fieldCount":2');
    }).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("lets OpenCode title new sessions from their first prompt", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      const createInputs: Array<unknown> = [];
      const fakeClient = {
        event: {
          subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => ({
            // Emits nothing and ends when the pump's abort signal fires.
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<never>>((resolve) => {
                    const done = () => resolve({ done: true, value: undefined });
                    if (options?.signal?.aborted) return done();
                    options?.signal?.addEventListener("abort", done, { once: true });
                  }),
              }),
            },
          }),
        },
        session: {
          create: async (input: unknown) => {
            createInputs.push(input);
            return { data: { id: "ses_native_1", time: { created: 1, updated: 1 } } };
          },
        },
      } as unknown as OpencodeClient;
      const unused = (operation: string) => () => Effect.die(`${operation} is not used`);
      const runtime: OpenCodeRuntimeShape = {
        startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "test://opencode",
            version: "test",
            exitCode: null,
            external: true,
          }),
        runOpenCodeCommand: unused("runOpenCodeCommand"),
        createOpenCodeSdkClient: () => fakeClient,
        loadOpenCodeInventory: unused("loadOpenCodeInventory"),
        loadInventoryFromCli: unused("loadInventoryFromCli"),
      };
      const instanceId = ProviderInstanceId.make("opencode");
      const threadId = ThreadId.make("thread-opencode-title");
      const modelSelection = { instanceId, model: "default" };
      const adapter = makeOpenCodeAdapterV2({
        instanceId,
        settings: yield* Schema.decodeEffect(OpenCodeSettings)({}),
        environment: {},
        runtime,
        idAllocator,
        serverConfig,
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-opencode-title"),
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      // OpenCode names a session from its first prompt only when create
      // leaves the title unset, so the adapter never sends one.
      assert.lengthOf(createInputs, 1);
      assert.notProperty(createInputs[0], "title");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          idAllocatorLayer,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode-v2-adapter-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

  // Event order from a live OpenCode 1.18.32 run of a `task` call with
  // background=true: the task part completes at launch, the root session
  // settles, and the child session stays busy until its own work ends.
  it.effect("reports a background task child as pending work after the root turn settles", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      const nativeEvents = asyncEventStream();
      const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
      const root = "ses_root";
      const child = "ses_child";
      const client = {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
          get: async () => ({
            data: { id: child, parentID: root, permission: [], time: { created: 2, updated: 2 } },
          }),
          update: async () => ({ data: { id: child, parentID: root } }),
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
        },
      } as unknown as OpencodeClient;
      const unused = (operation: string) => () => Effect.die(`${operation} is not used`);
      const instanceId = ProviderInstanceId.make("opencode");
      const threadId = ThreadId.make("thread-opencode-background-child");
      const modelSelection = { instanceId, model: "anthropic/claude-sonnet" };
      const policy = runtimePolicy("full-access", { cwd: "/workspace" });
      const adapter = makeOpenCodeAdapterV2({
        instanceId,
        settings: OPENCODE_TEST_SETTINGS,
        environment: {},
        runtime: {
          startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
          connectToOpenCodeServer: () =>
            Effect.succeed({
              url: "test://opencode",
              version: "test",
              exitCode: null,
              external: true,
            }),
          runOpenCodeCommand: unused("runOpenCodeCommand"),
          createOpenCodeSdkClient: () => client,
          loadOpenCodeInventory: unused("loadOpenCodeInventory"),
          loadInventoryFromCli: unused("loadInventoryFromCli"),
        },
        idAllocator,
        serverConfig,
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-opencode-background-child"),
        modelSelection,
        runtimePolicy: policy,
      });
      const hasPendingBackgroundWork = session.hasPendingBackgroundWork;
      if (hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("OpenCode runtime must expose hasPendingBackgroundWork.");
      }
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          id: threadId,
          projectId: ProjectId.make("project-opencode-background-child"),
          title: "background child",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
        threadId,
        runId: RunId.make("run-opencode-background-child"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-opencode-background-child"),
        rootNodeId: NodeId.make("node-opencode-background-child"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-opencode-background-child"),
          text: "sleep in the background",
          attachments: [],
        },
        modelSelection,
        runtimePolicy: policy,
      });
      const terminal = yield* session.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
        Effect.forkScoped,
      );
      const taskPart = (status: "running" | "completed") => ({
        type: "message.part.updated",
        properties: {
          sessionID: root,
          part: {
            id: "prt_task",
            sessionID: root,
            messageID: "msg_root_assistant",
            type: "tool",
            tool: "task",
            callID: "call_task",
            state: {
              status,
              input: {
                description: "Background sleep task",
                prompt: "sleep",
                subagent_type: "general",
              },
              title: "Background sleep task",
              metadata: { parentSessionId: root, sessionId: child, background: true },
              time: { start: 3, ...(status === "completed" ? { end: 3 } : {}) },
              ...(status === "completed" ? { output: "Background task started" } : {}),
            },
          },
        },
      });
      const status = (sessionID: string, type: "busy" | "idle") => ({
        type: "session.status",
        properties: { sessionID, status: { type } },
      });

      yield* push(status(root, "busy"));
      yield* push(taskPart("running"));
      yield* push({
        type: "session.created",
        properties: {
          sessionID: child,
          info: { id: child, parentID: root, time: { created: 2, updated: 2 } },
        },
      });
      yield* push(status(child, "busy"));
      yield* push(taskPart("completed"));
      yield* push(status(root, "idle"));
      assert.equal(Option.getOrUndefined(yield* Fiber.join(terminal))?.status, "completed");
      assert.isTrue(yield* hasPendingBackgroundWork, "the running child must pin idle release");

      yield* push(status(child, "idle"));
      yield* push({ type: "session.idle", properties: { sessionID: child } });
      assert.isFalse(yield* hasPendingBackgroundWork, "an idle child must not pin idle release");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(idAllocatorLayer, serverConfigLayer))),
  );

  it("maps native permission families to orchestration request kinds", () => {
    assert.equal(openCodePermissionRequestKind("bash"), "command");
    assert.equal(openCodePermissionRequestKind("read"), "file-read");
    assert.equal(openCodePermissionRequestKind("grep"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory", "edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("apply_patch"), "file-change");
    assert.equal(openCodePermissionRequestKind("todowrite"), "command");
    assert.equal(openCodePermissionRequestKind("custom", "todowrite"), "command");
  });

  it("maps OpenCode tools to semantic turn-item families", () => {
    assert.equal(openCodeToolProjectionKind("bash"), "command_execution");
    assert.equal(openCodeToolProjectionKind("edit"), "file_change");
    assert.equal(openCodeToolProjectionKind("read"), "dynamic_tool");
    assert.equal(openCodeToolProjectionKind("lsp"), "file_search");
    assert.equal(openCodeToolProjectionKind("websearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("codesearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("todowrite"), "dynamic_tool");
    assert.equal(openCodeToolProjectionKind("custom_tool"), "dynamic_tool");
  });

  it("maps runtime modes to safe OpenCode permission rules", () => {
    const approvalRequired = openCodePermissionRules(runtimePolicy("approval-required"));
    assert.equal(permissionAction(approvalRequired, "read"), "allow");
    assert.equal(permissionAction(approvalRequired, "edit"), "ask");
    assert.equal(permissionAction(approvalRequired, "bash"), "ask");
    assert.equal(permissionAction(approvalRequired, "doom_loop"), "ask");
    assert.equal(permissionAction(approvalRequired, "unknown_plugin_tool"), "ask");
    assert.equal(permissionAction(approvalRequired, "question"), "allow");

    const autoAcceptEdits = openCodePermissionRules(runtimePolicy("auto-accept-edits"));
    assert.equal(permissionAction(autoAcceptEdits, "edit"), "allow");
    assert.equal(permissionAction(autoAcceptEdits, "bash"), "ask");

    const fullAccess = openCodePermissionRules(runtimePolicy("full-access"));
    assert.equal(permissionAction(fullAccess, "bash"), "allow");
    assert.equal(permissionAction(fullAccess, "edit"), "allow");

    const granularApproval = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: { granular: { request_permissions: true } },
      }),
    );
    assert.equal(permissionAction(granularApproval, "bash"), "ask");
    assert.equal(permissionAction(granularApproval, "read"), "allow");

    const approvalRequiredWorkspaceWrite = openCodePermissionRules(
      runtimePolicy("approval-required", {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(approvalRequiredWorkspaceWrite, "edit"), "ask");
  });

  it("enforces non-interactive sandbox policy through OpenCode permissions", () => {
    const readOnly = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(readOnly, "read"), "allow");
    assert.equal(permissionAction(readOnly, "edit"), "deny");
    assert.equal(permissionAction(readOnly, "bash"), "deny");
    assert.equal(permissionAction(readOnly, "webfetch"), "deny");
    assert.equal(permissionAction(readOnly, "doom_loop"), "deny");
    assert.equal(permissionAction(readOnly, "unknown_plugin_tool"), "deny");
    assert.equal(permissionAction(readOnly, "external_directory"), "allow");

    const workspaceWrite = openCodePermissionRules(
      runtimePolicy("auto-accept-edits", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: true,
        },
      }),
    );
    assert.equal(permissionAction(workspaceWrite, "edit"), "allow");
    assert.equal(permissionAction(workspaceWrite, "bash"), "deny");
    assert.equal(permissionAction(workspaceWrite, "webfetch"), "allow");
    assert.deepInclude(workspaceWrite, {
      permission: "external_directory",
      pattern: "/tmp/opencode-workspace/*",
      action: "allow",
    });
  });

  it("preserves OpenCode's recursion guard on task-created child sessions", () => {
    const childRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);

    assert.equal(permissionAction(childRules, "read"), "allow");
    assert.equal(permissionAction(childRules, "bash"), "allow");
    assert.equal(permissionAction(childRules, "task"), "deny");

    const approvalRequiredPolicy = runtimePolicy("approval-required");
    const parentRules = openCodePermissionRules(approvalRequiredPolicy);
    const childApprovalRules = openCodeChildPermissionRules(approvalRequiredPolicy, [
      ...parentRules.filter((rule) => rule.action === "deny"),
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    assert.equal(permissionAction(childApprovalRules, "bash"), "ask");
    assert.equal(permissionAction(childApprovalRules, "task"), "deny");
  });

  it("uses the next native user message as the exclusive fork and revert boundary", () => {
    const first = providerTurn({ id: "turn:first", ordinal: 1, nativeId: "msg-user-1" });
    const synthetic = providerTurn({ id: "turn:synthetic", ordinal: 2, nativeId: null });
    const third = providerTurn({ id: "turn:third", ordinal: 3, nativeId: "msg-user-3" });

    assert.equal(
      openCodeBoundaryAfterProviderTurn([third, first, synthetic], first.id),
      "msg-user-3",
    );
    assert.isUndefined(openCodeBoundaryAfterProviderTurn([first, synthetic, third], third.id));
  });
});
