import {
  CommandId,
  pullRequestHostOf,
  McpPullRequestCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestThreadNotFoundError,
  PullRequestThreadAboveLimitsError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestNotOpenError,
  PullRequestWatchFailedError,
  type ListThreadPullRequestsInput,
  PullRequestWatchFromSubagentError,
  type Project,
  type PullRequestTargetInput,
  type PullRequestToolError,
  type LinkPullRequestResult,
  type UnlinkPullRequestResult,
  type ListThreadPullRequestsResult,
  type ThreadPullRequestEntry,
  type WatchPullRequestResult,
  type OrchestrationV2ThreadShell,
  type SourceControlProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { changeRequestUrlFor, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { allThreadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
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
import { assertTargetWithinLimits, isLiveCaller } from "./threadAccess.ts";

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
      input: ListThreadPullRequestsInput,
    ) => Effect.Effect<ListThreadPullRequestsResult, PullRequestToolError>;
    /** Starts or stops the server watching a pull request, linking an unlinked one first. */
    readonly setWatching: (
      scope: McpInvocationScope,
      input: PullRequestTargetInput,
      watching: boolean,
    ) => Effect.Effect<WatchPullRequestResult, PullRequestToolError>;
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
        watching: link.watch !== undefined,
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
  /** The target thread, anywhere in the environment; an omitted id means the calling thread. */
  const requireThread = Effect.fn("PullRequestMcpService.requireThread")(function* (
    scope: McpInvocationScope,
    requested: ThreadId | undefined,
  ) {
    if (!scope.capabilities.has("pull-requests"))
      return yield* new McpPullRequestCapabilityUnavailableError({});
    const threadId = requested ?? scope.threadId;
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    if (!thread || thread.deletedAt !== null)
      return yield* new PullRequestThreadNotFoundError({ threadId });
    return thread;
  });
  /**
   * A thread whose pull requests the caller may change: its own, or one that
   * runs within the caller's modes while the caller's run is live.
   */
  const requireWritableThread = Effect.fn("PullRequestMcpService.requireWritableThread")(function* (
    scope: McpInvocationScope,
    requested: ThreadId | undefined,
  ) {
    const thread = yield* requireThread(scope, requested);
    if (thread.id === scope.threadId) return thread;
    const caller = yield* requireThread(scope, scope.threadId);
    if (!isLiveCaller(caller, scope)) {
      return yield* new PullRequestThreadAboveLimitsError({ threadId: thread.id });
    }
    yield* assertTargetWithinLimits(caller, thread).pipe(
      Effect.mapError(() => new PullRequestThreadAboveLimitsError({ threadId: thread.id })),
    );
    return thread;
  });
  const mutate = (scope: McpInvocationScope, input: PullRequestTargetInput, unlink: boolean) =>
    Effect.gen(function* () {
      const thread = yield* requireWritableThread(scope, input.threadId);
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
            threadId: thread.id,
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
  /**
   * One command links an unlinked pull request and watches it, and the result reports the
   * state the thread holds afterwards.
   */
  const setWatching = Effect.fn("PullRequestMcpService.setWatching")(function* (
    scope: McpInvocationScope,
    input: PullRequestTargetInput,
    watching: boolean,
  ) {
    const thread = yield* requireWritableThread(scope, input.threadId);
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })),
    );
    const target = yield* resolvePullRequestTarget(input, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      visibleThreadPullRequests(allThreadPullRequestsOf(shell)).find((link) =>
        threadPullRequestKeysEqual(link, target),
      );
    if (watching && thread.lineage.relationshipToParent === "subagent") {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchedLink(thread);
    // A merged pull request cannot reopen. A closed one can, and its saved state may be stale,
    // so the watch starts and its first read ends it if the host still says closed.
    if (watching && before?.snapshot?.state === "merged") {
      return yield* new PullRequestNotOpenError({ state: "merged" });
    }
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* threads
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`mcp:pr-watch:${uuid}`),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        watching,
        ...(watching ? { link: { url: target.url, source: "agent" as const } } : {}),
      })
      .pipe(Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })));
    const after = yield* requireThread(scope, thread.id);
    return {
      host: target.host,
      repository: target.repository,
      number: target.number,
      url: target.url,
      watching: watchedLink(after)?.watch !== undefined,
      wasWatching: before?.watch !== undefined,
    };
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
    list: (scope, input) =>
      requireThread(scope, input.threadId).pipe(Effect.map(listV2ThreadPullRequests)),
    setWatching,
  });
});
export const layer = Layer.effect(PullRequestMcpService, make);
