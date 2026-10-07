import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "pull-requests",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

/** A provider session T3 Code launched for one thread. */
export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

/** An agent T3 Code did not launch, signed in through MCP OAuth. */
export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  /** Read only, or the most the threads it starts or changes may run with. */
  readonly access: AuthMcpClientAccess;
}

/**
 * The runtime mode a client caller's writes are capped at. A read-only client
 * never reaches a write (`McpToolAccess` refuses it first), so it maps to the
 * lowest mode rather than to nothing.
 */
export const clientRuntimeModeCeiling = (client: McpClientCaller | undefined): RuntimeMode =>
  client === undefined || client.access === "read-only" ? "approval-required" : client.access;

/**
 * Who is calling and what they may do. Tool parameters choose the target
 * (thread, project); the caller sets the limits. A thread caller's omitted
 * target falls back to its own thread; a client caller has no own thread, so
 * tools that act as the caller (delegate_task, preview, worktree handoff)
 * need `thread`.
 */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  /** Namespaces idempotency keys so two callers reusing a clientRequestId cannot collide. */
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** A scope with a thread caller, for tools whose whole surface acts as the caller. */
export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.`,
  });

export const requireThreadScope = (
  scope: McpInvocationScope,
  operation: string,
): Effect.Effect<McpThreadInvocationScope, OrchestratorMcpFailure> =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);

/**
 * Preview tabs belong to the calling thread, so the preview capability only
 * ever works for a thread caller. `McpToolAccess` refuses a client caller
 * before a preview tool runs; this refuses it again, the same way.
 */
export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const scope = yield* McpInvocationContext;
  const invocation = yield* requireThreadScope(scope, "This browser tool");
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.thread.threadId,
      providerSessionId: invocation.thread.providerSessionId,
      providerInstanceId: invocation.thread.providerInstanceId,
    });
  }
  return invocation;
});
