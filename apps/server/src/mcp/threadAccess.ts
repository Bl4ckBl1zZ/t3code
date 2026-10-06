import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationMcp from "./OrchestratorMcpService.ts";
import { type McpInvocationScope, McpInvocationContext } from "./McpInvocationContext.ts";

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

/** The most a caller may hand to the threads it targets: its own thread's modes. */
export interface CallerLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const caller = yield* threads.getThreadShell(scope.threadId).pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return { scope, threads, caller };
});

/**
 * A caller may change another thread only if that thread runs within the
 * caller's own modes. Its own thread is always within them.
 */
export const assertTargetWithinLimits = (limits: CallerLimits, target: CallerLimits) =>
  OrchestrationMcp.resolveRuntimeMode(limits.runtimeMode, target.runtimeMode).pipe(
    Effect.andThen(
      OrchestrationMcp.resolveInteractionMode(limits.interactionMode, target.interactionMode),
    ),
    Effect.asVoid,
  );

/** Whether the calling thread still owns a live run, which every write needs. */
export const isLiveCaller = (caller: OrchestrationV2ThreadShell, scope: McpInvocationScope) =>
  caller.archivedAt === null &&
  caller.activeRunId !== null &&
  caller.providerInstanceId === scope.providerInstanceId;

function assertLiveCaller({
  caller,
  scope,
}: {
  caller: OrchestrationV2ThreadShell;
  scope: McpInvocationScope;
}) {
  return isLiveCaller(caller, scope)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      );
}

/** Mutations need the calling thread's live run, so an agent whose turn ended cannot keep acting. */
export const readMutationCaller = Effect.fn("mcp.readMutationCaller")(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  return context;
});

/**
 * Actions that change the environment itself (preferences, running any
 * scheduled task) need a live full-access/default calling thread.
 */
export const readFullAccessCaller = Effect.fn("mcp.readFullAccessCaller")(function* (
  message: string,
) {
  const context = yield* readMutationCaller();
  if (
    context.caller.runtimeMode !== "full-access" ||
    context.caller.interactionMode !== "default"
  ) {
    return yield* new OrchestratorMcpFailure({ code: "capability_denied", message });
  }
  return context;
});

/** Load a target thread anywhere in the environment; an omitted id means the calling thread. */
export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readCaller();
  const targetId = threadId ?? context.caller.id;
  const shell =
    targetId === context.caller.id
      ? context.caller
      : yield* context.threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The thread was not found.",
    });
  }
  const projection = yield* context.threads
    .getProjectThreadRecords({ projectId: shell.projectId, threadId: targetId }, fields, {
      turnItemTypes: ["user_input_request"],
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadManagementThreadNotFoundError"
          ? new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The thread was not found.",
            })
          : unavailable(),
      ),
    );
  return { ...context, projection };
});

export const readWritableThread = Effect.fn("mcp.readWritableThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readThread(threadId, fields);
  yield* assertLiveCaller(context);
  yield* assertTargetWithinLimits(context.caller, context.projection.thread);
  return context;
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
});
