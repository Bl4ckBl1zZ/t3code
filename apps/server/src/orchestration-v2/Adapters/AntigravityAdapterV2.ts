import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as AcpErrors from "effect-acp/errors";
import type {
  AcpSessionRuntime,
  AcpSessionRuntimeStartResult,
} from "../../provider/acp/AcpSessionRuntime.ts";
import type { AntigravityAcpRuntimeInput } from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  antigravityPermissionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  antigravityApprovalOptions,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  isAntigravityUserInputRequest,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
  selectAntigravityPermissionOptionId,
} from "../../provider/acp/AntigravityProtocol.ts";
import {
  readAntigravityClientTextFile,
  writeAntigravityClientTextFile,
} from "../../provider/acp/AntigravityClientFiles.ts";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type { ProviderSetupError } from "@t3tools/contracts";
import type * as AcpSchema from "effect-acp/schema";
import {
  makeAcpAdapterV2,
  AcpProviderCapabilitiesV2,
  type AcpAdapterV2Options,
  type AcpAdapterV2Flavor,
} from "./AcpAdapterV2.ts";

export interface AntigravityAdapterV2Options extends Omit<AcpAdapterV2Options, "flavor"> {
  readonly path: Path.Path;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner" | "onAuthorizationUrl">,
  ) => Effect.Effect<
    AcpSessionRuntime["Service"],
    AcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly onSessionStarted: (
    started: AcpSessionRuntimeStartResult,
    cwd?: string,
  ) => Effect.Effect<void>;
  readonly onConfigOptionsUpdated: (
    options: ReadonlyArray<AcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands: (
    commands: ReadonlyArray<AcpSchema.AvailableCommand>,
    cwd?: string,
  ) => Effect.Effect<void>;
}

/** Reuses V2's request receipts, interruption quarantine and durable thread identity. */
export function makeAntigravityAdapterV2(options: AntigravityAdapterV2Options) {
  const flavor: AcpAdapterV2Flavor = {
    driver: ProviderDriverKind.make("antigravity"),
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsModelSwitchInSession: true,
        supportsRuntimeModeSwitchInSession: true,
      },
      tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
    },
    preferResumeSession: true,
    supportsImagePrompts: true,
    isPermissionQuestion: isAntigravityUserInputRequest,
    permissionQuestion: extractAntigravityUserInputQuestion,
    permissionQuestionResponse: makeAntigravityUserInputResponse,
    approvalOptions: antigravityApprovalOptions,
    selectPermissionOption: selectAntigravityPermissionOptionId,
    normalizeToolCall: normalizeAntigravityToolCall,
    preserveBackgroundToolUpdates: true,
    extractBackgroundTaskId: (toolCall) =>
      toolCall.kind === "execute" ? toolCall.toolCallId : undefined,
    configureSession: (runtime, selection, policy) =>
      Effect.gen(function* () {
        yield* applyAntigravityAcpModelSelection({
          runtime,
          model: selection.model,
          defaultModel: yield* options.defaultModel,
          mapError: (error) => error,
        });
        yield* runtime.setMode(antigravityPermissionMode(policy.runtimeMode));
        for (const option of selection.options ?? [])
          yield* runtime.setConfigOption(option.id, option.value);
      }),
    buildPrompt: (text, attachments) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        attachmentsDir: options.serverConfig.attachmentsDir,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
        Effect.map((blocks) => [...blocks]),
      ),
    makeRuntime: (input) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        return yield* options
          .withProcess(
            Scope.close(scope, Exit.void),
            Effect.gen(function* () {
              const runtime = yield* options.makeRuntime({ ...input, clientFileSystem: true });
              const subagentBatches = new Set<string>();
              const mcpTools = new Set<string>();
              const allowedRoots = [input.cwd, options.serverConfig.attachmentsDir];
              yield* runtime.handleReadTextFile((request) =>
                readAntigravityClientTextFile({
                  fileSystem: options.fileSystem,
                  path: options.path,
                  allowedRoots,
                  request,
                }),
              );
              yield* runtime.handleWriteTextFile((request) =>
                writeAntigravityClientTextFile({
                  fileSystem: options.fileSystem,
                  path: options.path,
                  allowedRoots,
                  request,
                }),
              );
              const publish = (started: AcpSessionRuntimeStartResult) =>
                options.onSessionStarted(started, input.cwd);
              return {
                ...runtime,
                start: () => runtime.start().pipe(Effect.tap(publish)),
                resumeSession: (id, activation) =>
                  runtime.resumeSession(id, activation).pipe(Effect.tap(publish)),
                handleSessionUpdate: (handler) =>
                  runtime.handleSessionUpdate((notification) =>
                    Effect.gen(function* () {
                      const update = notification.update;
                      if (update.sessionUpdate === "config_option_update")
                        yield* options.onConfigOptionsUpdated(update.configOptions);
                      if (update.sessionUpdate === "available_commands_update")
                        yield* options.onAvailableCommands(update.availableCommands, input.cwd);
                      if (
                        update.sessionUpdate !== "tool_call" &&
                        update.sessionUpdate !== "tool_call_update"
                      )
                        return yield* handler(notification);
                      const kind = classifyAntigravitySubagentToolCall(
                        {
                          toolCallId: update.toolCallId,
                          ...(update.kind ? { kind: update.kind } : {}),
                          ...(update.title ? { title: update.title } : {}),
                          data: {},
                        },
                        notification,
                      );
                      if (kind === "mcp") mcpTools.add(update.toolCallId);
                      if (kind === "subagent" && !mcpTools.has(update.toolCallId))
                        subagentBatches.add(update.toolCallId);
                      if (
                        !subagentBatches.has(update.toolCallId) ||
                        mcpTools.has(update.toolCallId)
                      )
                        return yield* handler(notification);
                      // Launch acknowledgement is not an individual agent's completion.
                      // The V2 foreground-tool terminalizer ends the batch with its parent.
                      return yield* handler({
                        ...notification,
                        update: {
                          ...update,
                          title: "Antigravity subagent batch",
                          ...(update.status === "completed"
                            ? { status: "in_progress" as const }
                            : {}),
                        },
                      });
                    }),
                  ),
              } satisfies typeof runtime;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "ProviderSetupError"
                ? new AcpErrors.AcpTransportError({ detail: cause.detail, cause })
                : cause,
            ),
          );
      }),
  };
  return makeAcpAdapterV2({ ...options, flavor });
}
