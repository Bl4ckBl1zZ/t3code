import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GrokSettings,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as EffectAcpErrors from "effect-acp/errors";
import { xAiRateLimitedErrorCode } from "../../provider/acp/XAiAcpExtension.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { buildInitialGrokProviderSnapshot } from "../../provider/Layers/GrokProvider.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  layerFromProjectRepository as runtimePolicyLayerFromProjectRepository,
  RuntimePolicyV2,
} from "../RuntimePolicy.ts";
import {
  AcpProviderCapabilitiesV2,
  acpCompletedTurnShouldTerminalizeTool,
  acpPermissionDisposition,
  acpRootSessionUpdateIngestsOutput,
  acpRootTurnCompletionDrainMs,
  acpRootTurnHasIngestedOutput,
  acpRootTurnIsIdle,
  acpRootTurnSettleDebounceMs,
  acpRootTurnShouldRearmRecoveryTimers,
  acpSupportsImagePrompts,
} from "./AcpAdapterV2.ts";
import {
  makeGrokAcpAdapterFlavor,
  makeGrokAdapterV2,
  GrokProviderCapabilitiesV2,
  type GrokAdapterV2Options,
} from "./GrokAdapterV2.ts";

const LAUNCH_TEST_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({
  binaryPath: "grok-launch-test",
});

function permissionRequest(
  kind: EffectAcpSchema.ToolKind,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "tool-1",
      title: "Test tool",
      kind,
    },
  };
}

function runtimePolicy(input: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}) {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  });
}

describe("acpRootTurnSettleDebounceMs", () => {
  it("keeps the historical debounce constant for re-enable experiments", () => {
    assert.equal(acpRootTurnSettleDebounceMs, 2_000);
  });
});

describe("acpRootTurnCompletionDrainMs", () => {
  it("gives trailing root chunks a short landing window", () => {
    assert.equal(acpRootTurnCompletionDrainMs, 100);
  });
});

describe("acpRootSessionUpdateIngestsOutput", () => {
  const sessionId = "session-1";

  it("ignores empty assistant chunks used as Grok keepalives", () => {
    assert.isFalse(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        },
      }),
    );
  });

  it("accepts non-empty assistant and reasoning chunks", () => {
    assert.isTrue(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      }),
    );
    assert.isTrue(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      }),
    );
  });

  it("accepts tool and plan updates", () => {
    assert.isTrue(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read",
          kind: "read",
          status: "pending",
        },
      }),
    );
    assert.isTrue(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "Step 1", status: "pending", priority: "medium" }],
        },
      }),
    );
  });
});

describe("acpRootTurnHasIngestedOutput", () => {
  const empty = {
    assistant: { current: null, nextSegment: 0 },
    reasoning: { current: null, nextSegment: 0 },
    tools: new Map(),
    plan: null,
  } as const;

  it("is false before any root turn items land", () => {
    assert.isFalse(acpRootTurnHasIngestedOutput(empty));
  });

  it("is true once assistant segments have streamed", () => {
    assert.isTrue(
      acpRootTurnHasIngestedOutput({
        ...empty,
        assistant: { current: null, nextSegment: 1 },
      }),
    );
  });
});

describe("acpRootTurn recovery timer re-arm", () => {
  it("re-arms idle settle after pending clears on active turns", () => {
    assert.isTrue(acpRootTurnShouldRearmRecoveryTimers({ finalized: false, interrupted: false }));
  });

  it("skips re-arm when the turn is already terminal", () => {
    assert.isFalse(acpRootTurnShouldRearmRecoveryTimers({ finalized: true, interrupted: false }));
    assert.isFalse(acpRootTurnShouldRearmRecoveryTimers({ finalized: false, interrupted: true }));
  });
});

describe("acpRootTurnIsIdle", () => {
  const quiet = {
    finalized: false,
    interrupted: false,
    assistantStreamOpen: false,
    reasoningStreamOpen: false,
    hasRunningTool: false,
    hasPendingRuntimeRequest: false,
    hasToolHistory: false,
    hasRunningSubagent: false,
    hasOutput: true,
  } as const;

  it("is false while assistant text is still streaming", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, assistantStreamOpen: true }));
  });

  it("is false while a tool is running", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, hasRunningTool: true }));
  });

  it("is false after tool history (prompt RPC owns terminalization)", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, hasToolHistory: true }));
  });

  it("is false while a native subagent task is still running", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, hasRunningSubagent: true }));
  });

  it("is false when only reasoning or tools have streamed", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, hasOutput: false }));
  });

  it("is false for assistant-only quiet (preamble-before-tools must not settle)", () => {
    assert.isFalse(acpRootTurnIsIdle(quiet));
  });

  it("is false when tools finished and root is quiet (no speculative multi-wave settle)", () => {
    assert.isFalse(
      acpRootTurnIsIdle({
        ...quiet,
        hasToolHistory: true,
        hasRunningTool: false,
      }),
    );
  });
});

describe("GrokAdapterV2 capabilities", () => {
  it("preserves Grok's rate-limit stop and distinguishes other prompt failures", () => {
    const flavor = makeGrokAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as GrokAdapterV2Options);
    const limit = flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: xAiRateLimitedErrorCode,
        errorMessage: "Grok usage limit reached. Try again later.",
      }),
    );
    assert.equal(limit?.class, "usage_limit");
    assert.equal(limit?.code, String(xAiRateLimitedErrorCode));
    assert.equal(limit?.message, "Grok usage limit reached. Try again later.");
    assert.equal(
      flavor.promptFailure?.(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Internal error",
        }),
      ).class,
      "provider_error",
    );
    assert.equal(
      flavor.promptFailure?.(new Error("Rate limit mentioned in an ordinary error")).class,
      "provider_error",
    );
  });

  it("wires hard Stop teardown but soft non-Stop interrupts in the constructor flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as GrokAdapterV2Options);

    assert.isFalse(flavor.interruptPromptOnCancel);
    // User Stop (requestRuntimeRestart) keeps the hard process-group kill and
    // respawn: Grok cancel is detach-and-continue, so only a process kill
    // stops the work.
    assert.isTrue(flavor.restartRuntimeAfterInterrupt);
    assert.isTrue(flavor.terminateRuntimeProcessGroupOnInterrupt);
    // Non-Stop interrupts (steering, restart_active) reuse the process and
    // session; the cancelled work backgrounds and the model decides its fate.
    assert.isUndefined(flavor.restartRuntimeOnEveryInterrupt);
    assert.isTrue(flavor.preserveRuntimeOnSettledInterrupt);
  });

  it("terminalizes only foreground tools under the actual Grok flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as GrokAdapterV2Options);
    const foreground = {
      toolCallId: "foreground-1",
      title: "Terminal",
      status: "inProgress" as const,
      data: {
        rawInput: { command: "true" },
        rawOutput: { type: "Bash", exit_code: 0 },
      },
    };
    const monitor = {
      toolCallId: "monitor-1",
      title: "Monitor",
      status: "inProgress" as const,
      data: {
        rawInput: { variant: "Monitor", command: "sleep 30" },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
        },
      },
    };
    const subagent = {
      toolCallId: "subagent-1",
      title: "Task",
      status: "inProgress" as const,
      data: {
        rawInput: {
          description: "Inspect interrupt handling",
          prompt: "Review the adapter.",
          subagent_type: "generalPurpose",
        },
      },
    };

    assert.isTrue(acpCompletedTurnShouldTerminalizeTool(foreground, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(monitor, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(subagent, flavor));
  });

  it("keeps optional protocol features conservative until a flavor or handshake confirms them", () => {
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isFalse(AcpProviderCapabilitiesV2.tools.supportsMcpTools);
  });

  it("overrides ACP image capability false so screenshot attachments can prompt", () => {
    // Handshake alone would refuse attachments (Grok advertises image:false).
    assert.isFalse(
      acpSupportsImagePrompts({
        negotiatedImage: false,
      }),
    );
    // Flavor override unblocks image content blocks for Grok.
    assert.isTrue(
      acpSupportsImagePrompts({
        flavorSupportsImagePrompts: true,
        negotiatedImage: false,
      }),
    );
    assert.isTrue(
      acpSupportsImagePrompts({
        negotiatedImage: true,
      }),
    );
  });

  it("declares Grok Task envelopes as native subagents", () => {
    assert.isFalse(GrokProviderCapabilitiesV2.threads.canForkThread);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.emitsSubagentLifecycle);
    assert.isFalse(GrokProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.isTrue(GrokProviderCapabilitiesV2.turns.supportsInterrupt);
    assert.isTrue(GrokProviderCapabilitiesV2.turns.supportsSteeringByInterruptRestart);
    assert.isTrue(GrokProviderCapabilitiesV2.context.supportsFullThreadHandoff);
  });

  it("declares the optional ACP features verified by the Grok handshake", () => {
    assert.isTrue(GrokProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isTrue(GrokProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isTrue(GrokProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(GrokProviderCapabilitiesV2.checkpointing.providerCanReadConversationSnapshot);
  });
});

describe("ACP permission policy", () => {
  it("honors explicit on-request approval over full-access runtime mode", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly" },
        }),
        permissionRequest("execute"),
      ),
      "ask",
    );
  });

  it("rejects mutating escalation under a non-interactive read-only policy", () => {
    const policy = runtimePolicy({
      runtimeMode: "full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(acpPermissionDisposition(policy, permissionRequest("execute")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("edit")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("read")), "allow");
  });

  it("auto-approves requests only when the resolved policy permits them", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
        permissionRequest("execute"),
      ),
      "allow",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("edit"),
      ),
      "ask",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("read"),
      ),
      "allow",
    );
  });

  it("auto-accept-edits approves file changes without locations and asks for the rest", () => {
    // Grok's session/request_permission carries no locations.
    const autoAcceptEdits = runtimePolicy({ runtimeMode: "auto-accept-edits" });
    for (const kind of ["edit", "delete", "move"] as const) {
      assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind)), "allow");
    }
    for (const kind of ["execute", "fetch", "other"] as const) {
      assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest(kind)), "ask");
    }
    assert.equal(acpPermissionDisposition(autoAcceptEdits, permissionRequest("read")), "allow");
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "auto-accept-edits", approvalPolicy: "on-request" }),
        permissionRequest("edit"),
      ),
      "ask",
    );
  });
});

describe("Grok permission prompts", () => {
  const disposition = makeGrokAcpAdapterFlavor({
    makeRuntime: () => Effect.never,
  } as unknown as GrokAdapterV2Options).permissionDisposition;

  // Grok's Auto mode only asks about actions its classifier blocked. When an
  // explicit policy launches Grok asking instead, T3's policy still answers.
  it("leaves Auto prompts to the user unless an explicit policy launched Grok asking", () => {
    assert.equal(
      disposition?.(runtimePolicy({ runtimeMode: "auto" }), permissionRequest("read")),
      "ask",
    );
    const readOnly = runtimePolicy({
      runtimeMode: "auto",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(disposition?.(readOnly, permissionRequest("execute")), "deny");
    assert.equal(
      disposition?.(runtimePolicy({ runtimeMode: "approval-required" }), permissionRequest("edit")),
      "ask",
    );
  });
});

describe("Grok session approvals", () => {
  const flavor = makeGrokAcpAdapterFlavor({
    makeRuntime: () => Effect.never,
  } as unknown as GrokAdapterV2Options);
  const options = (request: EffectAcpSchema.RequestPermissionRequest) =>
    flavor.approvalOptions?.(request).map((option) => option.decision);
  const select = (
    request: EffectAcpSchema.RequestPermissionRequest,
    decision: ProviderApprovalDecision,
  ) => flavor.selectPermissionOption?.(request, decision);
  const editPrompt: EffectAcpSchema.RequestPermissionRequest = {
    ...permissionRequest("edit"),
    options: [
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      {
        optionId: "allow-edits-session",
        name: "Yes, allow all edits during this session",
        kind: "allow_always",
      },
      { optionId: "reject-once", name: "No", kind: "reject_once" },
    ],
  };
  // Grok saves a bash prompt's `always-allow` for the whole project.
  const bashPrompt = permissionRequest("execute");

  it("offers a session choice only where Grok's answer lasts for the session", () => {
    assert.deepEqual(options(editPrompt), ["cancel", "decline", "acceptForSession", "accept"]);
    assert.deepEqual(options(bashPrompt), ["cancel", "decline", "accept"]);
  });

  it("never answers with a project-wide grant, whatever the client sends", () => {
    assert.equal(select(editPrompt, "acceptForSession"), "allow-edits-session");
    assert.equal(select(bashPrompt, "acceptForSession"), "allow-once");
    assert.equal(select(bashPrompt, "acceptAlways"), "allow-once");
    assert.equal(select(bashPrompt, "decline"), "reject-once");
    assert.isUndefined(select(bashPrompt, "cancel"));
  });
});

describe("Grok launch permission mode", () => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-grok-v2-launch-",
  }).pipe(Layer.provide(NodeServices.layer));
  const testLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, serverConfigLayer);

  // Opens a session through the adapter's own Grok runtime factory and returns
  // the argv it tried to launch. The spawn fails after recording, so no
  // process starts.
  const launchArgs = (runtimePolicy: ProviderAdapterV2RuntimePolicy) =>
    Effect.gen(function* () {
      const launches: Array<ReadonlyArray<string>> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") launches.push(command.args);
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "grok-launch-test",
            method: "spawn",
          }),
        );
      });
      const instanceId = ProviderInstanceId.make("grok-launch-test");
      const adapter = makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        childProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocatorV2,
        serverConfig: yield* ServerConfig,
      });
      yield* adapter
        .openSession({
          threadId: ThreadId.make("grok-launch-test"),
          providerSessionId: ProviderSessionId.make("grok-launch-test"),
          modelSelection: { instanceId, model: "grok-build" },
          runtimePolicy,
        })
        .pipe(Effect.scoped, Effect.ignore);
      return launches;
    }).pipe(
      // Keep the launch argv unwrapped by the Linux cgroup shim.
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(testLayer),
    );

  const policy = (
    runtimeMode: RuntimeMode,
    override: Partial<ProviderAdapterV2RuntimePolicy> = {},
  ) =>
    ProviderAdapterV2RuntimePolicy.make({
      runtimeMode,
      interactionMode: "default",
      cwd: process.cwd(),
      ...override,
    });

  for (const [runtimeMode, args] of [
    ["approval-required", ["--permission-mode", "default", "agent", "stdio"]],
    ["auto", ["--permission-mode", "auto", "agent", "stdio"]],
    ["full-access", ["agent", "--always-approve", "stdio"]],
  ] as const) {
    it.effect(`launches ${runtimeMode} threads with ${args.join(" ")}`, () =>
      Effect.gen(function* () {
        assert.deepEqual(yield* launchArgs(policy(runtimeMode)), [args]);
      }),
    );
  }

  it.effect("launches a thread stored as Auto-accept edits asking", () =>
    Effect.gen(function* () {
      // The policy the orchestrator resolves from Grok's own provider snapshot.
      const snapshot = yield* buildInitialGrokProviderSnapshot(LAUNCH_TEST_GROK_SETTINGS);
      const instanceId = ProviderInstanceId.make("grok-launch-test");
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("grok-launch-test");
      const modelSelection = { instanceId, model: "grok-build" } as const;
      const resolved = yield* Effect.gen(function* () {
        const runtimePolicy = yield* RuntimePolicyV2;
        return yield* runtimePolicy.resolve({
          thread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("grok-launch-test"),
            title: "Grok launch test",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            branch: null,
            worktreePath: process.cwd(),
            activeProviderThreadId: null,
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
          modelSelection,
        });
      }).pipe(
        Effect.provide(
          runtimePolicyLayerFromProjectRepository.pipe(
            Layer.provide(
              Layer.mock(ProjectionProjectRepository)({
                getById: () => Effect.die("the thread has a worktree"),
              }),
            ),
            Layer.provide(
              Layer.mock(ProviderInstanceRegistry)({
                getInstance: () =>
                  Effect.succeed({
                    snapshot: { getSnapshot: Effect.succeed(snapshot) },
                  } as ProviderInstance),
              }),
            ),
          ),
        ),
      );
      assert.equal(resolved.runtimeMode, "approval-required");
      assert.deepEqual(yield* launchArgs(resolved), [
        ["--permission-mode", "default", "agent", "stdio"],
      ]);
    }),
  );

  it.effect("launches asking when an explicit approval or sandbox policy governs the thread", () =>
    Effect.gen(function* () {
      const asking = [["--permission-mode", "default", "agent", "stdio"]];
      assert.deepEqual(
        yield* launchArgs(
          policy("full-access", {
            approvalPolicy: "never",
            sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          }),
        ),
        asking,
      );
      assert.deepEqual(
        yield* launchArgs(policy("full-access", { approvalPolicy: "on-request" })),
        asking,
      );
    }),
  );
});
