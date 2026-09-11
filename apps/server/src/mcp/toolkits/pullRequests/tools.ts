import {
  PullRequestTargetInput,
  LinkPullRequestResult,
  UnlinkPullRequestResult,
  ListThreadPullRequestsResult,
  PullRequestToolError,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { PullRequestMcpService } from "../../PullRequestMcpService.ts";

const dependencies = [McpInvocationContext, PullRequestMcpService];
const REGISTER_EVERY_PR =
  "Register every pull request you open for this thread, including each layer of a stack, right after creating it.";

const LinkPullRequestTool = Tool.make("link_pull_request", {
  description: `${REGISTER_EVERY_PR} Links a pull request to this thread so T3 Code tracks it, shows its status beside the thread. Pass the URL, or repository plus number. Linking an already-linked pull request succeeds with alreadyLinked=true.`,
  parameters: PullRequestTargetInput,
  success: LinkPullRequestResult,
  failure: PullRequestToolError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Link pull request to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkPullRequestTool = Tool.make("unlink_pull_request", {
  description:
    "Remove a pull request link from this thread, for example after closing a pull request you opened by mistake. Pass the URL, or repository plus number. Unlinking a pull request that is not linked succeeds with wasLinked=false.",
  parameters: PullRequestTargetInput,
  success: UnlinkPullRequestResult,
  failure: PullRequestToolError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Unlink pull request from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadPullRequestsTool = Tool.make("list_thread_pull_requests", {
  description: `List the pull requests linked to this thread with their last known host state, and how they chain into stacks (bottom to top). ${REGISTER_EVERY_PR}`,
  success: ListThreadPullRequestsResult,
  failure: PullRequestToolError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List thread pull requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PullRequestsToolkit = Toolkit.make(
  LinkPullRequestTool,
  UnlinkPullRequestTool,
  ListThreadPullRequestsTool,
);
