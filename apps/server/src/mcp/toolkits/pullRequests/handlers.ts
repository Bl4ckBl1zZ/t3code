import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PullRequestMcpService } from "../../PullRequestMcpService.ts";
import { PullRequestsToolkit } from "./tools.ts";

/** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const PullRequestsToolkitHandlersLive = McpToolAccess.toLayer(PullRequestsToolkit, {
  link_pull_request: writesThread((input) =>
    Effect.gen(function* () {
      const service = yield* PullRequestMcpService;
      return yield* service.link(yield* McpInvocationContext, input);
    }),
  ),
  unlink_pull_request: writesThread((input) =>
    Effect.gen(function* () {
      const service = yield* PullRequestMcpService;
      return yield* service.unlink(yield* McpInvocationContext, input);
    }),
  ),
  list_thread_pull_requests: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* PullRequestMcpService;
      return yield* service.list(yield* McpInvocationContext, input);
    }),
  ),
  watch_pull_request: writesThread((input) =>
    Effect.gen(function* () {
      const service = yield* PullRequestMcpService;
      return yield* service.setWatching(yield* McpInvocationContext, input, true);
    }),
  ),
  unwatch_pull_request: writesThread((input) =>
    Effect.gen(function* () {
      const service = yield* PullRequestMcpService;
      return yield* service.setWatching(yield* McpInvocationContext, input, false);
    }),
  ),
});
