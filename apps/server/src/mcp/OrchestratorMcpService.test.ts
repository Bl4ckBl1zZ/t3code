import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, ordinal: 1, status: "completed" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ThreadLaunchService)({}),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        credentialId: "credential:mcp-test",
        audience: "t3-code",
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-ack",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("does not dispose delivery when a nonterminal task has no active child run", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-child");
      const taskId = NodeId.make("node:mcp-cancel-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ThreadLaunchService)({}),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        credentialId: "credential:mcp-test",
        audience: "t3-code",
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-cancel",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-unstarted-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("does not dispose delivery when the child interrupt fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated interrupt failure") as never)),
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ThreadLaunchService)({}),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        credentialId: "credential:mcp-test",
        audience: "t3-code",
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-cancel-failed",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["run.interrupt"],
        );
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("returns cancel requested when post-interrupt disposal fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ThreadLaunchService)({}),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        credentialId: "credential:mcp-test",
        audience: "t3-code",
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-cancel-dispose-failed",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId,
          clientRequestId: "cancel-dispose-failed-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["run.interrupt", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );
  const launchScope = (threadId: ThreadId): McpInvocationScope => ({
    credentialId: "credential:mcp-test",
    audience: "t3-code",
    environmentId: EnvironmentId.make("environment:mcp-launch"),
    threadId,
    providerSessionId: "provider-session:mcp-launch",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });

  const launchParent = (overrides: Record<string, unknown> = {}) =>
    ({
      thread: {
        id: ThreadId.make("thread:mcp-launch-parent"),
        projectId: ProjectId.make("project:mcp-launch"),
        runtimeMode: "full-access",
        interactionMode: "default",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-terra" },
        branch: "main",
        worktreePath: "/tmp/parent-worktree",
        ...overrides,
      },
      runs: [],
      contextTransfers: [],
      messages: [],
      subagents: [],
    }) as unknown as OrchestrationV2ThreadProjection;

  const launchDependencies = (
    parentProjection: OrchestrationV2ThreadProjection,
    launches: Array<Record<string, unknown>>,
  ) =>
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService)({
        getThreadProjection: () => Effect.succeed(parentProjection),
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            models: [{ id: "gpt-5.6-terra" }],
          },
        ] as never),
      }),
      Layer.mock(ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            launches.push(input as unknown as Record<string, unknown>);
          }).pipe(
            Effect.as({
              threadId: input.threadId!,
              resumed: false,
              projection: {
                thread: {
                  id: input.threadId,
                  projectId: input.projectId,
                  modelSelection: input.modelSelection,
                  branch: "feature/child",
                  worktreePath: "/tmp/child-worktree",
                },
                runs: [
                  {
                    id: RunId.make("run:mcp-launch"),
                    status: "queued",
                    userMessageId: input.initialMessage?.messageId,
                  },
                ],
              },
            } as never),
          ),
      }),
      Layer.mock(ScheduledTaskService)({}),
    );

  it.effect("launches a thread into its own worktree and reports where it landed", () =>
    Effect.gen(function* () {
      const parentProjection = launchParent();
      const launches: Array<Record<string, unknown>> = [];

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.launchThread(launchScope(parentProjection.thread.id), {
          title: "Stack part two",
          workspaceStrategy: { type: "worktree", baseRef: "feature/part-one" },
          message: "Add the second migration.",
        });

        assert.equal(launches.length, 1);
        assert.deepEqual(launches[0]?.workspaceStrategy, {
          type: "worktree",
          baseRef: "feature/part-one",
        });
        // The thread inherits the caller's project and modes without being told.
        assert.equal(launches[0]?.projectId, parentProjection.thread.projectId);
        assert.equal(launches[0]?.runtimeMode, "full-access");
        assert.equal(launches[0]?.createdBy, "agent");
        assert.equal(result.branch, "feature/child");
        assert.equal(result.worktreePath, "/tmp/child-worktree");
        assert.equal(result.status, "queued");
      }).pipe(
        Effect.provide(
          OrchestratorMcpService.layer.pipe(
            Layer.provide(launchDependencies(parentProjection, launches)),
          ),
        ),
      );
    }),
  );

  it.effect("binds the project root when no workspace strategy is given", () =>
    Effect.gen(function* () {
      const parentProjection = launchParent();
      const launches: Array<Record<string, unknown>> = [];

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        // Not the caller's worktree: an unbound launch belongs to the project.
        yield* service.launchThread(launchScope(parentProjection.thread.id), { title: "Root" });
        assert.deepEqual(launches[0]?.workspaceStrategy, { type: "root" });
        assert.isUndefined(launches[0]?.initialMessage);
      }).pipe(
        Effect.provide(
          OrchestratorMcpService.layer.pipe(
            Layer.provide(launchDependencies(parentProjection, launches)),
          ),
        ),
      );
    }),
  );

  it.effect("refuses to launch from a restricted or planning caller", () =>
    Effect.gen(function* () {
      for (const overrides of [{ runtimeMode: "approval-required" }, { interactionMode: "plan" }]) {
        const parentProjection = launchParent(overrides);
        const launches: Array<Record<string, unknown>> = [];

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const failure = yield* service
            .launchThread(launchScope(parentProjection.thread.id), { title: "Denied" })
            .pipe(Effect.flip);
          assert.equal(failure.code, "capability_denied");
          assert.equal(launches.length, 0);
        }).pipe(
          Effect.provide(
            OrchestratorMcpService.layer.pipe(
              Layer.provide(launchDependencies(parentProjection, launches)),
            ),
          ),
        );
      }
    }),
  );
});
