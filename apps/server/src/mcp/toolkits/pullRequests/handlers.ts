import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { PullRequestMcpService } from "../../PullRequestMcpService.ts";
import { PullRequestsToolkit } from "./tools.ts";

export const PullRequestsToolkitHandlersLive = PullRequestsToolkit.toLayer({
  link_pull_request: (input) =>
    Effect.gen(function* () {
      const service = yield* PullRequestMcpService;
      return yield* service.link(yield* McpInvocationContext, input);
    }),
  unlink_pull_request: (input) =>
    Effect.gen(function* () {
      const service = yield* PullRequestMcpService;
      return yield* service.unlink(yield* McpInvocationContext, input);
    }),
  list_thread_pull_requests: () =>
    Effect.gen(function* () {
      const service = yield* PullRequestMcpService;
      return yield* service.list(yield* McpInvocationContext);
    }),
});
