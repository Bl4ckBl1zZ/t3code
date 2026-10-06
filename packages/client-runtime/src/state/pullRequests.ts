import {
  WS_METHODS,
  type PullRequestActionInput,
  type PullRequestDetail,
  type PullRequestDiffInput,
  type PullRequestMergeMethod,
  PullRequestOperationError,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentQueryAtomFamily,
} from "./runtime.ts";
import { PullRequestDiffLoader } from "./pullRequestDiffHttp.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";

export {
  type PullRequestDiffLoadError,
  PullRequestDiffCredentialRejectedError,
  PullRequestDiffLoader,
  pullRequestDiffLoaderLayer,
} from "./pullRequestDiffHttp.ts";

export class EnvironmentHttpConnectionNotReadyError extends Data.TaggedError(
  "EnvironmentHttpConnectionNotReadyError",
)<{ readonly message: string }> {}

/**
 * A merge pressed from a surface that knows too little to merge with — whether this viewer may,
 * which methods the repository allows, whether the pull request sits in a stack. The host's
 * current answer settles it inside the action's lane.
 */
export interface PullRequestMergePreparation {
  /** The environment reads GitHub stacks, so a pull request inside one is refused here. */
  readonly stackActions: boolean;
  /** Throwing refuses the merge with that error's sentence. */
  readonly resolveMergeMethod: (detail: PullRequestDetail) => PullRequestMergeMethod;
}

export type PullRequestRunActionInput = PullRequestActionInput & {
  readonly prepareMerge?: PullRequestMergePreparation;
};

const refuseMerge = (detail: string) =>
  new PullRequestOperationError({ operation: "runAction", detail });

/** Refresh a linked PR while its thread is visible so merges update the sidebar. */
export function createLinkedPullRequestDetailAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:linked-detail",
    tag: WS_METHODS.pullRequestsDetail,
    staleTimeMs: 15_000,
    refreshIntervalMs: 30_000,
  });
}

export function pullRequestDetailToVcsStatus(
  detail: PullRequestDetail,
): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: detail.number,
    title: detail.title,
    url: detail.url,
    baseRef: detail.baseBranch,
    headRef: detail.headBranch,
    state: detail.state,
    ...(detail.isDraft === true ? { isDraft: true } : {}),
    updatedAt: detail.updatedAt,
  };
}

/**
 * Every read shells out to the GitHub CLI, so results are reused for a short while and
 * refreshed explicitly. Mutations run serially per environment: `gh` actions on the same
 * pull request are order-sensitive, and the detail view refetches after each one.
 */
export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | PullRequestDiffLoader | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const activity = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:activity",
    tag: WS_METHODS.pullRequestsActivity,
    staleTimeMs: 15_000,
  });
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list",
      tag: WS_METHODS.pullRequestsList,
      staleTimeMs: 30_000,
    }),
    /**
     * The line counts for rows the listing has already handed over. Its own query because the
     * listing is quicker without them — measured over twelve repositories, ~4.0s against ~7.1s —
     * so the rows arrive first and their stats a moment later. Kept longer than the listing:
     * a change request's size only moves when somebody pushes to it.
     */
    listStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list-stats",
      tag: WS_METHODS.pullRequestsListStats,
      staleTimeMs: 60_000,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:detail",
      tag: WS_METHODS.pullRequestsDetail,
      staleTimeMs: 15_000,
    }),
    activity,
    stack: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:stack",
      tag: WS_METHODS.pullRequestsStack,
      staleTimeMs: 15_000,
    }),
    readDetail: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:read-detail",
      tag: WS_METHODS.pullRequestsDetail,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /** A one-off stack read for a click, without mounting the stack query. */
    readStack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:read-stack",
      tag: WS_METHODS.pullRequestsStack,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    threadComments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:thread-comments",
      tag: WS_METHODS.pullRequestsThreadComments,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.host?.toLowerCase() ?? null,
            input.repository,
            input.number,
            input.threadId,
            input.cursor,
          ]),
      },
    }),
    diff: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:diff",
      staleTimeMs: 60_000,
      execute: (input: PullRequestDiffInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const loader = yield* PullRequestDiffLoader;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return yield* new EnvironmentHttpConnectionNotReadyError({
              message: "The environment HTTP connection is not ready.",
            });
          }
          return yield* loader.load(prepared.value, input);
        }),
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:diff-file-contents",
      tag: WS_METHODS.pullRequestsDiffFileContents,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.host?.toLowerCase() ?? null,
            input.repository,
            input.number,
            input.commit ?? null,
            input.changeType,
            input.oldPath,
            input.newPath,
          ]),
      },
    }),
    runAction: createEnvironmentCommand(runtime, {
      label: "environment-data:pull-requests:run-action",
      // Preparation belongs to the write's lane: preparing outside it could let a later click
      // overtake this one.
      execute: (input: PullRequestRunActionInput) =>
        Effect.gen(function* () {
          const { prepareMerge, ...actionInput } = input;
          if (
            actionInput.action !== "merge" ||
            actionInput.mergeMethod !== undefined ||
            prepareMerge === undefined
          ) {
            return yield* request(WS_METHODS.pullRequestsRunAction, actionInput);
          }
          const { projectId, host, repository, number } = actionInput;
          const reference = {
            projectId,
            ...(host === undefined ? {} : { host }),
            repository,
            number,
          };
          const detail = yield* request(WS_METHODS.pullRequestsDetail, reference);
          if (
            detail.state !== "open" ||
            detail.isDraft ||
            !detail.capabilities.actions.includes("merge") ||
            !detail.viewerPermissions.actions.includes("merge")
          ) {
            return yield* refuseMerge("This pull request cannot be merged.");
          }
          if (detail.provider === "github" && prepareMerge.stackActions) {
            const stack = yield* request(WS_METHODS.pullRequestsStack, reference);
            if (stack !== null) {
              return yield* refuseMerge("Open this pull request to merge its stack.");
            }
          }
          const mergeMethod = yield* Effect.try({
            try: () => prepareMerge.resolveMergeMethod(detail),
            catch: (cause) =>
              refuseMerge(
                cause instanceof Error ? cause.message : "Could not choose a merge method.",
              ),
          });
          return yield* request(WS_METHODS.pullRequestsRunAction, { ...actionInput, mergeMethod });
        }),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update",
      tag: WS_METHODS.pullRequestsUpdate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:comment",
      tag: WS_METHODS.pullRequestsComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    updateComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update-comment",
      tag: WS_METHODS.pullRequestsUpdateComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: ({ environmentId, input: { projectId, host, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(
            activity({
              environmentId,
              input: { projectId, ...(host === undefined ? {} : { host }), repository, number },
            }),
          ),
        ),
    }),
    submitReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:submit-review",
      tag: WS_METHODS.pullRequestsSubmitReview,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    replyToThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:reply-to-thread",
      tag: WS_METHODS.pullRequestsReplyToThread,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * Its own query rather than part of the detail: the people who may be asked are only wanted
     * once somebody opens the reviewer menu, so this atom is read then and not before. Kept fresh
     * for a minute, because who has access to a repository changes far more slowly than the
     * change request it is being read for.
     */
    labelCandidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:label-candidates",
      tag: WS_METHODS.pullRequestsLabelCandidates,
      staleTimeMs: 15_000,
    }),
    setLabels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-labels",
      tag: WS_METHODS.pullRequestsSetLabels,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    reviewerCandidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:reviewer-candidates",
      tag: WS_METHODS.pullRequestsReviewerCandidates,
      staleTimeMs: 60_000,
    }),
    requestReviewers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:request-reviewers",
      tag: WS_METHODS.pullRequestsRequestReviewers,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setThreadResolution: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-thread-resolution",
      tag: WS_METHODS.pullRequestsSetThreadResolution,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-reaction",
      tag: WS_METHODS.pullRequestsSetReaction,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * Explicit refresh: forget the server's cached answers, then re-run the reads. A separate
     * request rather than a flag on a read, so only a person's refresh spends host requests
     * while every silent re-read shares the cache.
     */
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:invalidate",
      tag: WS_METHODS.pullRequestsInvalidate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
