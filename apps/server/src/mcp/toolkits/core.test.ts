import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import { OrchestratorProjectionError } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "../McpInvocationContext.ts";
import * as EnvironmentHandlers from "./environment/handlers.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
  resolveT3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";

it("publishes unique tool names with reference-free object-root inputs", () => {
  const names = new Set<string>();
  for (const toolkit of [
    OrchestratorToolkit,
    PreviewToolkit,
    WorktreeToolkit,
    ThreadToolkit,
    EnvironmentToolkit,
    PreviewControlsToolkit,
    PullRequestsToolkit,
  ]) {
    for (const tool of Object.values(toolkit.tools)) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      // The published tool catalog must also work with providers without $ref support.
      expect(JSON.stringify(schema), tool.name).not.toContain('"$ref"');
      // Every published tool must have labels for its lifecycle, branding, and a summary.
      const definition = resolveT3McpToolDefinition(tool.name);
      expect(definition, tool.name).not.toBeNull();
      expect(
        definition?.labels.every((label) => label.trim().length > 0),
        tool.name,
      ).toBe(true);
      // Providers prefix the injected server differently, and the loose
      // matcher has to recognise every published tool under each spelling.
      // Upstream brands them all "t3-code"; we brand by tool family instead.
      for (const name of [tool.name, `mcp__t3-code__${tool.name}`, `T3-code.${tool.name}`]) {
        expect(resolveT3McpToolPresentation(name)?.logo, name).toBe(definition?.icon);
        expect(resolveT3McpToolSummaryAction(name), name).not.toBeNull();
      }
    }
  }
  expect(names.has("t3_thread_launch")).toBe(true);
  expect(names.has("t3_thread_start")).toBe(false);
});

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationScope = {
  credentialId: "mcp-core-credential",
  audience: "mcp-core",
  environmentId: EnvironmentId.make("mcp-core-environment"),
  threadId,
  providerSessionId: "mcp-core-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("checks capability before accessing services through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.some(({ tool }) => tool.name === "t3_thread_organize")).toBe(true);
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext, { ...scope, capabilities: new Set<never>() }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.structuredContent).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      McpHttpServer.ThreadToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      ),
    ),
  ),
);

it.effect("returns a bounded public failure without serializing storage causes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.structuredContent).toEqual({
      _tag: "OrchestratorMcpFailure",
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.ThreadToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.fail(
                new OrchestratorProjectionError({
                  threadId,
                  cause: new Error("private-storage-path"),
                }),
              ),
          }),
        ),
      ),
    ),
  ),
);

it("keeps MCP preference output allowlisted and Unicode-bounded", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    privateCredential: "must-not-escape",
    sourceControlWritingStyle: {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      customInstructions: "🙂".repeat(4001),
    },
  };
  const result = EnvironmentHandlers.preferences(settings);
  expect(result).not.toHaveProperty("privateCredential");
  expect(result).not.toHaveProperty("providers");
  // Truncation counts code points, so an emoji is not cut in half.
  expect(result.sourceControlWritingStyle).toMatchObject({
    customInstructions: "🙂".repeat(4000),
    truncated: true,
  });
});

it("reports pull request merge defaults through MCP preferences", () => {
  const result = EnvironmentHandlers.preferences({
    ...DEFAULT_SERVER_SETTINGS,
    pullRequestMergeMethod: "squash",
    projectPullRequestMergeMethodOverrides: { [ProjectId.make("project")]: "rebase" },
    removeAgentCreditsOnMerge: true,
    projectRemoveAgentCreditsOnMergeOverrides: { [ProjectId.make("project")]: false },
  });
  expect(result.pullRequestMergeMethod).toBe("squash");
  expect(result.projectPullRequestMergeMethodOverrides).toEqual({ project: "rebase" });
  expect(result.removeAgentCreditsOnMerge).toBe(true);
  expect(result.projectRemoveAgentCreditsOnMergeOverrides).toEqual({ project: false });
});

const callerThreadShell = (runtimeMode: "auto" | "full-access") =>
  ({
    id: threadId,
    projectId: ProjectId.make("project-a"),
    runtimeMode,
    interactionMode: "default",
    activeRunId: "run-live",
    archivedAt: null,
    providerInstanceId: "codex",
    deletedAt: null,
  }) as never;

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("targets a thread in another project within the caller's modes", () =>
  Effect.gen(function* () {
    const pinned = yield* callTool("t3_thread_organize", {
      action: "pin",
      threadId: "other-project-thread",
    });
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toMatchObject({ sequence: 7 });

    const aboveModes = yield* callTool("t3_thread_organize", {
      action: "pin",
      threadId: "full-access-thread",
    });
    expect(aboveModes.structuredContent).toMatchObject({
      code: "runtime_mode_escalation_denied",
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.ThreadToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(
                id === threadId
                  ? callerThreadShell("auto")
                  : ({ id, projectId: "other-project", deletedAt: null } as never),
              ),
            getProjectThreadRecords: (input) =>
              Effect.succeed({
                thread: {
                  id: input.threadId,
                  projectId: input.projectId,
                  runtimeMode: input.threadId === "full-access-thread" ? "full-access" : "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () => Effect.succeed({ sequence: 7 } as never),
          }),
        ),
      ),
    ),
  ),
);

const callerProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-a"),
    runtimeMode: "auto",
    interactionMode: "default",
    archivedAt: null,
  },
  runs: [{ id: "run-live", ordinal: 1, status: "running", providerInstanceId: "codex" }],
} as never;

function scheduledTask(id: string, runtimeMode: "auto" | "full-access"): never {
  return {
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as never;
}

it.effect("a caller cannot rewrite a scheduled task that runs above its own modes", () =>
  Effect.gen(function* () {
    const update = yield* callTool("update_scheduled_task", {
      scheduledTaskId: "task-full-access",
      prompt: "Run something else",
    });
    expect(update.structuredContent).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const remove = yield* callTool("delete_scheduled_task", {
      scheduledTaskId: "task-full-access",
    });
    expect(remove.structuredContent).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const allowed = yield* callTool("update_scheduled_task", {
      scheduledTaskId: "task-auto",
      enabled: false,
    });
    expect(allowed.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.OrchestratorToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(callerProjection),
          }),
        ),
        Layer.provide(Layer.mock(ThreadLaunchService)({})),
        Layer.provide(Layer.mock(ProviderRegistry)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [
                  scheduledTask("task-full-access", "full-access"),
                  scheduledTask("task-auto", "auto"),
                ],
              }),
            upsert: (input) =>
              Effect.succeed({
                task: { ...(scheduledTask(input.id ?? "task-auto", "auto") as object), ...input },
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

it.effect("a caller cannot interrupt a thread that runs above its own modes", () =>
  Effect.gen(function* () {
    const result = yield* callTool("t3_thread_interrupt", { threadId: "full-access-thread" });
    expect(result.structuredContent).toMatchObject({ code: "runtime_mode_escalation_denied" });
  }).pipe(
    Effect.provide(
      McpHttpServer.OrchestratorToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(callerProjection),
            getThreadShell: () =>
              Effect.succeed({ projectId: "project-b", deletedAt: null } as never),
            getProjectThread: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("full-access-thread"),
                  projectId: "project-b",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  deletedAt: null,
                },
                runs: [],
              } as never),
            interruptThread: () =>
              Effect.die("interrupt must not dispatch above the caller's modes"),
          }),
        ),
        Layer.provide(Layer.mock(ThreadLaunchService)({})),
        Layer.provide(Layer.mock(ProviderRegistry)({})),
        Layer.provide(Layer.mock(ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);
