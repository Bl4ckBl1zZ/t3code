import {
  canonicalRepositoryKey,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type Project,
  type ThreadId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class ThreadPullRequestReactor extends Context.Service<
  ThreadPullRequestReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadPullRequestReactor") {}

function samePullRequest(
  left: ThreadLinkedPullRequest | null | undefined,
  right: ThreadLinkedPullRequest | null,
): boolean {
  if (left == null || right === null) return left == null && right === null;
  return (
    left.projectId === right.projectId &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.number === right.number &&
    left.url === right.url
  );
}

/** Startup lookups per settled thread before discovery gives up on it. */
export const BACKFILL_ATTEMPTS = 5;

interface RefreshRequest {
  readonly threadId: ThreadId | null;
  readonly refresh: boolean;
  readonly backfill?: boolean;
}

export function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: Project,
): boolean {
  return (
    pullRequest.repositoryKey !== null &&
    project.repositoryIdentity != null &&
    canonicalRepositoryKey(pullRequest.repositoryKey) ===
      canonicalRepositoryKey(project.repositoryIdentity.canonicalKey)
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* ThreadManagementService;
  const projectService = yield* ProjectService.ProjectService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  // Settled threads get one link discovery at startup. Failed lookups retry on
  // the periodic pass a few times, then stop until the thread changes or the
  // server restarts, so a missing or logged-out CLI cannot loop forever.
  const pendingBackfill = new Map<ThreadId, number>();
  const finishBackfill = (threads: ReadonlyArray<{ readonly id: ThreadId }>) => {
    for (const thread of threads) pendingBackfill.delete(thread.id);
  };
  const failBackfill = (threads: ReadonlyArray<{ readonly id: ThreadId }>) => {
    for (const thread of threads) {
      const remaining = pendingBackfill.get(thread.id);
      if (remaining === undefined) continue;
      if (remaining <= 1) pendingBackfill.delete(thread.id);
      else pendingBackfill.set(thread.id, remaining - 1);
    }
  };

  const synchronize = Effect.fn("ThreadPullRequestReactor.synchronize")(function* (
    request: RefreshRequest,
  ) {
    const snapshot = yield* engine.getShellSnapshot({ location: "active" });
    const projectSnapshot = yield* projectService.snapshot;
    const projects = new Map(projectSnapshot.projects.map((project) => [project.id, project]));
    if (request.backfill) {
      for (const thread of snapshot.threads) {
        if (
          (thread.settledOverride === "settled" || thread.settledAt !== null) &&
          thread.branchPullRequest == null
        ) {
          pendingBackfill.set(thread.id, BACKFILL_ATTEMPTS);
        }
      }
    }
    const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
    for (const threadId of pendingBackfill.keys()) {
      if (!threadIds.has(threadId)) pendingBackfill.delete(threadId);
    }
    const threads = snapshot.threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        (request.threadId === null || thread.id === request.threadId) &&
        ((thread.settledOverride !== "settled" && thread.settledAt === null) ||
          request.threadId !== null ||
          pendingBackfill.has(thread.id)) &&
        (thread.branch !== null || thread.branchPullRequest != null),
    );
    const groups = Map.groupBy(threads, (thread) =>
      JSON.stringify([thread.projectId, thread.worktreePath, thread.branch]),
    );

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const first = group[0]!;
          const project = projects.get(first.projectId);
          if (project === undefined) return finishBackfill(group);
          const repository = sourceControlRepositorySelector(project.repositoryIdentity);
          if (first.branch !== null && repository === null) return finishBackfill(group);
          const worktreeExists =
            first.worktreePath !== null && (yield* fileSystem.exists(first.worktreePath));
          const cwd =
            worktreeExists && first.worktreePath !== null
              ? first.worktreePath
              : project.workspaceRoot;
          const detected =
            first.branch === null
              ? null
              : yield* git.branchPullRequest(
                  { cwd, branch: first.branch },
                  { refresh: request.refresh },
                );
          // A worktree can have different remotes, and the project identity
          // can lag a remote edit. Do not attach its PR to the wrong repository.
          if (detected !== null && !pullRequestMatchesProject(detected, project)) {
            return finishBackfill(group);
          }
          const detectedReference =
            detected !== null && repository !== null
              ? {
                  projectId: project.id,
                  repository,
                  number: detected.number,
                  url: detected.url,
                }
              : null;

          const plans = yield* Effect.forEach(group, (thread) =>
            Effect.gen(function* () {
              let branchPullRequest = detectedReference;
              // Shared checkouts often return to the default branch after
              // a merge. Keep that thread's terminal PR across the change.
              if (
                branchPullRequest === null &&
                thread.branch !== null &&
                thread.worktreePath === null &&
                thread.branchPullRequest != null
              ) {
                const previous = yield* pullRequests.summary(thread.branchPullRequest);
                if (previous.state === "merged" || previous.state === "closed") {
                  branchPullRequest = thread.branchPullRequest;
                }
              }

              if (samePullRequest(thread.branchPullRequest, branchPullRequest)) {
                pendingBackfill.delete(thread.id);
                return null;
              }
              return { thread, branchPullRequest };
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("thread pull request discovery failed", {
                      threadId: thread.id,
                      cause: Cause.pretty(cause),
                    }).pipe(
                      Effect.tap(() => Effect.sync(() => failBackfill([thread]))),
                      Effect.as(null),
                    ),
              ),
            ),
          );
          const updates = plans.filter((plan) => plan !== null);
          if (updates.length === 0) return;

          if (detected !== null && first.branch !== null) {
            // Summary reads can outlast a remote edit. Recheck the branch and
            // the project's primary remote before saving the group's links.
            const current = yield* git.branchPullRequest({ cwd, branch: first.branch });
            const currentIdentity = yield* repositoryIdentities.resolve(project.workspaceRoot, {
              refresh: true,
            });
            if (
              current === null ||
              current.number !== detected.number ||
              current.url !== detected.url ||
              current.state !== detected.state ||
              current.repositoryKey !== detected.repositoryKey ||
              !pullRequestMatchesProject(current, {
                ...project,
                repositoryIdentity: currentIdentity,
              })
            ) {
              return failBackfill(updates.map((update) => update.thread));
            }
          }

          yield* Effect.forEach(
            updates,
            ({ thread, branchPullRequest }) =>
              Effect.gen(function* () {
                const uuid = yield* crypto.randomUUIDv4;
                yield* engine.dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`server:thread-pull-request:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  expectedProjectId: project.id,
                  expectedBranch: thread.branch,
                  expectedWorktreePath: thread.worktreePath,
                  branchPullRequest,
                });
                pendingBackfill.delete(thread.id);
              }).pipe(
                // The thread changed since the lookup. Its own events requeue it.
                Effect.catchTags({
                  OrchestratorDispatchError: () => Effect.sync(() => finishBackfill([thread])),
                }),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("thread pull request update failed", {
                        threadId: thread.id,
                        cause: Cause.pretty(cause),
                      }).pipe(Effect.tap(() => Effect.sync(() => failBackfill([thread])))),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("thread branch pull request lookup failed", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }).pipe(Effect.tap(() => Effect.sync(() => failBackfill(group)))),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((request: RefreshRequest) =>
    synchronize(request).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("thread pull request refresh failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  // V2 metadata events carry the whole thread. Track lookup context so our own
  // branch-candidate updates (and background snapshot writes) do not trigger a loop.
  const contexts = new Map<ThreadId, string>();
  const processEvent = (event: OrchestrationV2DomainEvent) => {
    if (event.type === "thread.deleted" || event.type === "thread.archived") {
      contexts.delete(event.threadId);
      pendingBackfill.delete(event.threadId);
      return Effect.void;
    }
    if (
      event.type === "thread.created" ||
      event.type === "thread.unarchived" ||
      event.type === "thread.metadata-updated"
    ) {
      const thread = event.payload;
      const context = JSON.stringify([thread.projectId, thread.branch, thread.worktreePath]);
      if (contexts.get(thread.id) === context && event.type === "thread.metadata-updated")
        return Effect.void;
      contexts.set(thread.id, context);
      return worker.enqueue({ threadId: thread.id, refresh: false });
    }
    if (event.type === "checkpoint.captured" || event.type === "thread.unsettled") {
      return worker.enqueue({ threadId: event.threadId, refresh: true });
    }
    if (
      event.type === "run.updated" &&
      ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status)
    ) {
      return worker.enqueue({ threadId: event.threadId, refresh: false });
    }
    return Effect.void;
  };

  const start = Effect.fn("ThreadPullRequestReactor.start")(function* () {
    yield* forkParked(Stream.runForEach(engine.streamDomainEvents, processEvent));
    // Run without client demand. Saved branch lookups share GitManager's
    // provider cache and retry backoff with status and automatic settlement.
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue({ threadId: null, refresh: false, backfill: true });
        yield* worker.drain;
        yield* Effect.gen(function* () {
          yield* worker.enqueue({ threadId: null, refresh: false });
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.delay("1 minute"));
      }).pipe(Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadPullRequestReactor["Service"];
});

export const layer = Layer.effect(ThreadPullRequestReactor, make);
