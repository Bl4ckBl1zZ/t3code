import {
  CommandId,
  pullRequestHostOf,
  McpPullRequestCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestThreadNotFoundError,
  PullRequestThreadRequiredError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestNotOpenError,
  PullRequestWatchFailedError,
  type ListThreadPullRequestsInput,
  PullRequestWatchFromSubagentError,
  PullRequestGuideFailedError,
  PullRequestProjectNotFoundError,
  type Project,
  type PullRequestGuideTarget,
  type ReadPullRequestGuideResult,
  type WritePullRequestGuidesInput,
  type WritePullRequestGuidesResult,
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
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
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
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { pullRequestSyncKey } from "../pullRequest/pullRequestSyncKey.ts";
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
      input: ListThreadPullRequestsInput,
    ) => Effect.Effect<ListThreadPullRequestsResult, PullRequestToolError>;
    /** Starts or stops the server watching a pull request, linking an unlinked one first. */
    readonly setWatching: (
      scope: McpInvocationScope,
      input: PullRequestTargetInput,
      watching: boolean,
    ) => Effect.Effect<WatchPullRequestResult, PullRequestToolError>;
    /**
     * Starts review guides for each pull request, each read through the project here whose
     * checkout is its repository. One that cannot be guided reports why without failing the rest.
     */
    readonly writeGuides: (
      scope: McpInvocationScope,
      input: WritePullRequestGuidesInput,
    ) => Effect.Effect<WritePullRequestGuidesResult, PullRequestToolError>;
    /** A pull request's stored guide and its run. Never starts one. */
    readonly readGuide: (
      scope: McpInvocationScope,
      input: PullRequestGuideTarget,
    ) => Effect.Effect<ReadPullRequestGuideResult, PullRequestToolError>;
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

/**
 * The project a pull request is read through: the caller's own when its checkout is that
 * repository, else the first project here whose checkout is. Host reads are scoped to a project,
 * so a repository with no checkout in this environment cannot be guided from it.
 */
export function projectForPullRequest(
  projects: ReadonlyArray<Project>,
  target: { readonly host: string; readonly repository: string },
  preferred: Project | undefined,
): Project | undefined {
  // The same rule the guide service uses: a pull request reads through a project whose checkout
  // names it with the same host-level key, which also maps Azure DevOps' org/project/_git/repo.
  const matches = (project: Project) => {
    const identity = project.repositoryIdentity ?? undefined;
    if (identity === undefined) return false;
    const own = pullRequestSyncKey(
      { projectId: project.id, host: target.host, repository: target.repository, number: 1 },
      identity,
    );
    const projectKey = pullRequestSyncKey(
      {
        projectId: project.id,
        repository: sourceControlRepositorySelector(identity) ?? "",
        number: 1,
      },
      identity,
    );
    return (
      own !== null &&
      projectKey !== null &&
      own.host === projectKey.host &&
      own.repository === projectKey.repository
    );
  };
  if (preferred !== undefined && matches(preferred)) return preferred;
  return projects.find(matches);
}

/** A host or service error, said as its own detail rather than its operation's wrapper. */
const guideFailureDetail = (error: { readonly message: string }) =>
  "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

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
  const reviewGuides = yield* PullRequestReviewGuideService;
  const crypto = yield* Crypto.Crypto;
  /** The target thread, anywhere in the environment; an omitted id means the calling thread. */
  const requireThread = Effect.fn("PullRequestMcpService.requireThread")(function* (
    scope: McpInvocationScope,
    requested: ThreadId | undefined,
  ) {
    if (!scope.capabilities.has("pull-requests"))
      return yield* new McpPullRequestCapabilityUnavailableError({});
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new PullRequestThreadRequiredError();
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    if (!thread || thread.deletedAt !== null)
      return yield* new PullRequestThreadNotFoundError({ threadId });
    return thread;
  });
  const mutate = (scope: McpInvocationScope, input: PullRequestTargetInput, unlink: boolean) =>
    Effect.gen(function* () {
      const thread = yield* requireThread(scope, input.threadId);
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
    const thread = yield* requireThread(scope, input.threadId);
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
  /**
   * Resolves each requested pull request and the project it is read through. The caller's own
   * project wins where it is a checkout of that repository; with no thread, any project here may.
   */
  const locateAll = Effect.fn("PullRequestMcpService.locateAll")(function* (
    scope: McpInvocationScope,
    targets: ReadonlyArray<PullRequestGuideTarget>,
  ) {
    if (!scope.capabilities.has("pull-requests"))
      return yield* new McpPullRequestCapabilityUnavailableError({});
    const callerThread =
      scope.thread === undefined
        ? undefined
        : yield* threads.getThreadShell(scope.thread.threadId).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((shell) => shell ?? undefined),
          );
    const known = yield* projects.snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects.filter((project) => project.deletedAt === null)),
      Effect.mapError((cause) => new PullRequestListFailedError({ cause })),
    );
    const callerProject = known.find((project) => project.id === callerThread?.projectId);
    // Each target resolves on its own, so one bad URL in a batch is that entry's failure only.
    return yield* Effect.forEach(targets, (input) =>
      resolvePullRequestTarget(input, callerProject).pipe(
        Effect.map((target) => ({
          input,
          target,
          project: projectForPullRequest(known, target, callerProject),
          failure: null,
        })),
        Effect.catch((error) =>
          Effect.succeed({ input, target: null, project: undefined, failure: error.message }),
        ),
      ),
    );
  });

  /** The service reads a pull request through one project's checkout and credentials. */
  const guideReference = (
    project: Project,
    target: { readonly host: string; readonly repository: string; readonly number: number },
  ) => ({
    projectId: project.id,
    host: target.host,
    repository: target.repository,
    number: target.number,
  });

  const writeGuides = Effect.fn("PullRequestMcpService.writeGuides")(function* (
    scope: McpInvocationScope,
    input: WritePullRequestGuidesInput,
  ) {
    const located = yield* locateAll(scope, input.pullRequests);
    // One pull request that cannot be guided does not stop the rest; it reports why.
    const guides = yield* Effect.forEach(
      located,
      (entry) =>
        Effect.gen(function* () {
          if (entry.target === null) {
            return {
              host: entry.input.host ?? "",
              repository: entry.input.repository ?? "",
              number: entry.input.number ?? 0,
              url: entry.input.url ?? "",
              outcome: "failed" as const,
              detail: entry.failure,
            };
          }
          const identity = {
            host: entry.target.host,
            repository: entry.target.repository,
            number: entry.target.number,
            url: entry.target.url,
          };
          if (entry.project === undefined) {
            return {
              ...identity,
              outcome: "failed" as const,
              detail: new PullRequestProjectNotFoundError({
                repository: entry.target.repository,
              }).message,
            };
          }
          return yield* reviewGuides.generate(guideReference(entry.project, entry.target)).pipe(
            Effect.map((result) => ({
              ...identity,
              outcome: result.started ? ("started" as const) : ("running" as const),
              detail: null,
            })),
            Effect.catch((error) =>
              Effect.succeed({
                ...identity,
                outcome: "failed" as const,
                detail: guideFailureDetail(error),
              }),
            ),
          );
        }),
      { concurrency: 4 },
    );
    return { guides };
  });

  const readGuide = Effect.fn("PullRequestMcpService.readGuide")(function* (
    scope: McpInvocationScope,
    input: PullRequestGuideTarget,
  ) {
    const [entry] = yield* locateAll(scope, [input]);
    if (entry !== undefined && entry.target === null) {
      return yield* new PullRequestGuideFailedError({ detail: entry.failure ?? "" });
    }
    if (entry === undefined || entry.target === null || entry.project === undefined) {
      return yield* new PullRequestProjectNotFoundError({
        repository: entry?.target.repository ?? input.repository ?? "",
      });
    }
    const result = yield* reviewGuides.get(guideReference(entry.project, entry.target)).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestGuideFailedError({
            detail: guideFailureDetail(error),
            cause: error,
          }),
      ),
    );
    return {
      host: entry.target.host,
      repository: entry.target.repository,
      number: entry.target.number,
      url: entry.target.url,
      guide: result.guide,
      run: result.run,
      currentHeadSha: result.currentHeadSha,
      stale:
        result.guide !== null &&
        result.currentHeadSha !== null &&
        result.guide.headSha !== result.currentHeadSha,
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
    writeGuides,
    readGuide,
  });
});
export const layer = Layer.effect(PullRequestMcpService, make);
