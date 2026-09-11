import {
  CommandId,
  pullRequestHostOf,
  McpPullRequestCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestThreadNotFoundError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  type Project,
  type PullRequestTargetInput,
  type PullRequestToolError,
  type LinkPullRequestResult,
  type UnlinkPullRequestResult,
  type ListThreadPullRequestsResult,
  type ThreadPullRequestEntry,
  type OrchestrationV2ThreadShell,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { changeRequestUrlFor, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { allThreadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequestChains";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class PullRequestMcpService extends Context.Service<
  PullRequestMcpService,
  {
    readonly link: (
      scope: McpInvocationScope,
      input: PullRequestTargetInput,
    ) => Effect.Effect<LinkPullRequestResult, PullRequestToolError>;
    readonly unlink: (
      scope: McpInvocationScope,
      input: PullRequestTargetInput,
    ) => Effect.Effect<UnlinkPullRequestResult, PullRequestToolError>;
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<ListThreadPullRequestsResult, PullRequestToolError>;
  }
>()("t3/mcp/PullRequestMcpService") {}

export const resolvePullRequestTarget = Effect.fn("PullRequestMcpService.resolveTarget")(function* (
  input: PullRequestTargetInput,
  project: Project | undefined,
) {
  if (input.url !== undefined) {
    const parsed = parseChangeRequestUrl(input.url);
    if (parsed === null) return yield* new PullRequestUrlInvalidError({});
    return { ...parsed, url: input.url };
  }
  if (input.repository === undefined || input.number === undefined)
    return yield* new PullRequestTargetIncompleteError({});
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider as SourceControlProviderKind | undefined;
  const projectHost = identity && kind ? pullRequestHostOf(identity, kind) : undefined;
  const host = (input.host ?? projectHost)?.toLowerCase();
  if (!host) return yield* new PullRequestHostRequiredError({});
  const repository = input.repository.toLowerCase();
  const url =
    changeRequestUrlFor(host === projectHost ? kind : null, host, repository, input.number) ??
    `https://${host}/${repository}/pull/${input.number}`;
  return { host, repository, number: input.number, url };
});

export function listV2ThreadPullRequests(
  thread: OrchestrationV2ThreadShell,
): ListThreadPullRequestsResult {
  const links = visibleThreadPullRequests(allThreadPullRequestsOf(thread));
  const chains = resolveThreadPullRequestChains(links);
  return {
    pullRequests: links.map((link): ThreadPullRequestEntry => {
      const chain = chains.find(
        (candidate) =>
          candidate.layers.length > 1 &&
          candidate.layers.some(
            (layer) => threadPullRequestKeyOf(layer) === threadPullRequestKeyOf(link),
          ),
      );
      return {
        host: link.host,
        repository: link.repository,
        number: link.number,
        url: link.url,
        source: link.source,
        state: link.snapshot?.state ?? null,
        title: link.snapshot?.title ?? null,
        headBranch: link.snapshot?.headBranch ?? null,
        baseBranch: link.snapshot?.baseBranch ?? null,
        isDraft: link.snapshot?.isDraft ?? null,
        stack: chain
          ? {
              kind: chain.kind,
              position:
                chain.layers.findIndex(
                  (layer) => threadPullRequestKeyOf(layer) === threadPullRequestKeyOf(link),
                ) + 1,
              size: chain.layers.length,
            }
          : null,
      };
    }),
    chains: chains.map((chain) => ({
      kind: chain.kind,
      numbers: chain.layers.map((layer) => layer.number),
    })),
  };
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const crypto = yield* Crypto.Crypto;
  const requireThread = Effect.fn("PullRequestMcpService.requireThread")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("pull-requests"))
      return yield* new McpPullRequestCapabilityUnavailableError({});
    const thread = yield* threads
      .getThreadShell(scope.threadId)
      .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    if (!thread || thread.deletedAt !== null)
      return yield* new PullRequestThreadNotFoundError({ threadId: scope.threadId });
    return thread;
  });
  const mutate = (scope: McpInvocationScope, input: PullRequestTargetInput, unlink: boolean) =>
    Effect.gen(function* () {
      const thread = yield* requireThread(scope);
      const project = yield* projects.getById(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) => new PullRequestListFailedError({ cause })),
      );
      const target = yield* resolvePullRequestTarget(input, project);
      const key = threadPullRequestKeyOf(target);
      const wasLinked = visibleThreadPullRequests(allThreadPullRequestsOf(thread)).some(
        (link) => threadPullRequestKeyOf(link) === key,
      );
      if (unlink ? wasLinked : !wasLinked) {
        const reference = {
          projectId: thread.projectId,
          repository: target.repository,
          number: target.number,
          url: target.url,
        };
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`mcp:pr:${uuid}`),
            threadId: scope.threadId,
            ...(unlink
              ? { unlinkPullRequest: reference }
              : { linkPullRequest: reference, linkPullRequestSource: "agent" as const }),
          })
          .pipe(
            Effect.mapError((cause) =>
              unlink
                ? new PullRequestUnlinkFailedError({ cause })
                : new PullRequestLinkFailedError({ cause }),
            ),
          );
      }
      return { target, wasLinked };
    });
  return PullRequestMcpService.of({
    link: (scope, input) =>
      mutate(scope, input, false).pipe(
        Effect.map(({ target, wasLinked }) => ({ ...target, alreadyLinked: wasLinked })),
      ),
    unlink: (scope, input) =>
      mutate(scope, input, true).pipe(
        Effect.map(({ target, wasLinked }) => ({
          host: target.host,
          repository: target.repository,
          number: target.number,
          wasLinked,
        })),
      ),
    list: (scope) => requireThread(scope).pipe(Effect.map(listV2ThreadPullRequests)),
  });
});
export const layer = Layer.effect(PullRequestMcpService, make);
