import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import { isAutoDeleteDue } from "@t3tools/shared/threadAutoDelete";
import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type Project,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequestChains";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { pullRequestMatchesProject } from "./ThreadPullRequestReactor.ts";
import {
  isAutoSettlementCandidate,
  resolveAutoSettlementAt,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    readonly start: (options?: {
      readonly beforeSweep?: Effect.Effect<void>;
    }) => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** Sweeps every candidate thread. */
    readonly requestSweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementReactor") {}

/** Every candidate thread, or only the threads whose own events asked for a decision. */
type SweepScope = "all" | ReadonlySet<ThreadId>;

const DAY_MS = 86_400_000;

/** @public Canonical Effect service construction. */
export const make = Effect.gen(function* () {
  const engine = yield* ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitManager.GitManager;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;

  // The shell carries the last message the user wrote, so wakes the agent
  // started on its own cannot hold a merged thread open.
  const resolveSettledAt = Effect.fn("ThreadSettlementReactor.resolveSettledAt")(function* (
    thread: OrchestrationV2ThreadShell,
    pullRequest: SettlementPullRequest | null,
  ) {
    const current = yield* settingsService.getSettings;
    return resolveAutoSettlementAt({
      thread,
      pullRequest,
      now: yield* DateTime.now,
      autoSettleAfterDays: current.sidebarAutoSettleAfterDays,
      autoSettleOnMerge: current.sidebarAutoSettleOnMerge,
    });
  });

  const wouldSettle = (thread: OrchestrationV2ThreadShell, pullRequest: SettlementPullRequest) =>
    resolveSettledAt(thread, pullRequest).pipe(Effect.map((settledAt) => settledAt !== null));

  const lookup = Effect.fn("ThreadSettlementReactor.lookup")(function* (
    thread: OrchestrationV2ThreadShell,
    project: Project | undefined,
  ) {
    if (visibleThreadPullRequests(thread.pullRequests ?? []).length > 0) return null;
    const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
    const cwd =
      project === undefined
        ? null
        : thread.worktreePath !== null && (yield* fileSystem.exists(thread.worktreePath))
          ? thread.worktreePath
          : project.workspaceRoot;
    if (reference != null) {
      const summary = yield* pullRequests.summary(reference);
      const terminal = {
        state: summary.state,
        mergedAt: summary.mergedAt ?? null,
        closedAt: summary.closedAt ?? null,
      } satisfies SettlementPullRequest;
      if (
        summary.state !== "open" &&
        thread.branch !== null &&
        cwd !== null &&
        project !== undefined &&
        (yield* wouldSettle(thread, terminal))
      ) {
        // Branch reuse must win over an older terminal branch candidate. Only
        // recheck when this sweep would settle; later eligibility waits for the
        // next sweep.
        const current = yield* git.branchPullRequest(
          { cwd, branch: thread.branch },
          { refresh: true },
        );
        if (current?.state === "open" && pullRequestMatchesProject(current, project))
          return current;
      }
      return terminal;
    }
    if (thread.branch === null || cwd === null || project === undefined) return null;
    const candidate = yield* git.branchPullRequest({ cwd, branch: thread.branch });
    return candidate !== null && pullRequestMatchesProject(candidate, project) ? candidate : null;
  });

  // Candidates come from the thread table alone, and each one's shell is read on its own below,
  // so a sweep never holds the database for a whole shell snapshot.
  const settleSweep = Effect.fn("ThreadSettlementReactor.settleSweep")(function* (
    scope: SweepScope,
  ) {
    const candidates = yield* projections.listThreads({
      kind: "auto-settle-candidates",
      ...(scope === "all" ? {} : { threadIds: [...scope] }),
    });
    if (candidates.length === 0) return;
    const projectSnapshot = yield* projects.snapshot;
    const projectById = new Map(projectSnapshot.projects.map((project) => [project.id, project]));
    const settle = Effect.fn("ThreadSettlementReactor.settle")(function* (
      thread: OrchestrationV2ThreadShell,
      expectedSequence: number,
      pullRequest: SettlementPullRequest | null,
    ) {
      const settledAt = yield* resolveSettledAt(thread, pullRequest);
      if (settledAt === null) return false;
      const uuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
        threadId: thread.id,
        settledAt: DateTime.formatIso(settledAt),
        automatic: { expectedSequence },
      });
      return true;
    });
    // Complete every local decision before any provider read can occupy a worker slot.
    const lookups = yield* Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          const expectedSequence = yield* engine.getThreadEventSequence(candidate.id);
          const thread = yield* engine.getThreadShell(candidate.id);
          if (thread === null || !isAutoSettlementCandidate(thread, yield* DateTime.now))
            return null;
          if (yield* settle(thread, expectedSequence, null)) return null;
          if (visibleThreadPullRequests(thread.pullRequests ?? []).length > 0) return null;
          return { thread, expectedSequence };
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logDebug("automatic thread settlement skipped", {
                  threadId: candidate.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
          ),
        ),
      { concurrency: 8 },
    );
    yield* Effect.forEach(
      lookups.filter((entry) => entry !== null),
      ({ thread, expectedSequence }) =>
        lookup(thread, projectById.get(thread.projectId)).pipe(
          Effect.flatMap((pullRequest) => settle(thread, expectedSequence, pullRequest)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logDebug("automatic thread settlement lookup skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  /**
   * Removes the deleted thread's worktree and local branch, both forced, unless
   * another thread (active or archived) still uses them. Never touches the
   * project root.
   */
  const removeThreadWorkspace = Effect.fn("ThreadSettlementReactor.removeThreadWorkspace")(
    function* (thread: OrchestrationV2ThreadShell) {
      const worktreePath = thread.worktreePath?.trim();
      if (worktreePath === undefined || worktreePath === "") return;
      const project = (yield* projects.snapshot).projects.find(
        (candidate) => candidate.id === thread.projectId,
      );
      if (project === undefined || worktreePath === project.workspaceRoot.trim()) return;
      const others = (yield* projections.listThreads({
        kind: "workspace-users",
        worktreePath,
        projectId: thread.projectId,
        branch: thread.branch,
      })).filter((other) => other.id !== thread.id && other.deletedAt === null);
      if (others.some((other) => other.worktreePath?.trim() === worktreePath)) return;
      yield* gitWorkflow.removeWorktree({
        cwd: project.workspaceRoot,
        path: worktreePath,
        force: true,
      });
      const branch = thread.branch;
      if (
        branch === null ||
        others.some((other) => other.projectId === thread.projectId && other.branch === branch)
      ) {
        return;
      }
      // Worktree removal already drops branches T3 created when they are merged;
      // a missing branch here is the expected outcome, not a failure.
      yield* gitWorkflow
        .deleteLocalBranch({ cwd: project.workspaceRoot, refName: branch, force: true })
        .pipe(
          Effect.catch((cause) =>
            Effect.logDebug("automatic thread deletion left no branch to delete", {
              threadId: thread.id,
              branch,
              cause,
            }),
          ),
        );
    },
  );

  const autoDeleteSweep = Effect.fn("ThreadSettlementReactor.autoDeleteSweep")(function* (
    afterDays: number,
    scope: SweepScope,
  ) {
    const now = yield* DateTime.now;
    const due = (yield* projections.listThreads({
      kind: "auto-delete-candidates",
      settledBefore: DateTime.subtract(now, { milliseconds: afterDays * DAY_MS }),
      ...(scope === "all" ? {} : { threadIds: [...scope] }),
    })).filter((thread) => isAutoDeleteDue(thread, afterDays, now));
    // One at a time: removals in the same repository contend for its Git lock.
    yield* Effect.forEach(
      due,
      (candidate) =>
        Effect.gen(function* () {
          const expectedSequence = yield* engine.getThreadEventSequence(candidate.id);
          const thread = yield* engine.getThreadShell(candidate.id);
          const current = (yield* settingsService.getSettings).autoDeleteSettledAfterDays;
          if (thread === null || !isAutoDeleteDue(thread, current, yield* DateTime.now)) return;
          const uuid = yield* crypto.randomUUIDv4;
          yield* engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`server:auto-delete:${thread.id}:${uuid}`),
            threadId: thread.id,
            automatic: { expectedSequence },
          });
          yield* removeThreadWorkspace(thread);
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread deletion skipped", {
                  threadId: candidate.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { discard: true },
    );
  });

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* (scope: SweepScope) {
    const settings = yield* settingsService.getSettings;
    if (settings.sidebarAutoSettleOnMerge || settings.sidebarAutoSettleAfterDays !== null) {
      yield* settleSweep(scope);
    }
    if (settings.autoDeleteSettledAfterDays !== null) {
      yield* autoDeleteSweep(settings.autoDeleteSettledAfterDays, scope);
    }
  });
  let beforeSweep: Effect.Effect<void> = Effect.void;
  // Requests coalesce until the worker takes them. A thread's own events only need that thread
  // decided again; the periodic, settings, and merge sweeps cover every thread, including those
  // whose time-based settlement came due in between.
  let queued = false;
  let fullSweepQueued = false;
  const queuedThreadIds = new Set<ThreadId>();
  const takeScope = (): SweepScope => {
    queued = false;
    const scope: SweepScope = fullSweepQueued ? "all" : new Set(queuedThreadIds);
    fullSweepQueued = false;
    queuedThreadIds.clear();
    return scope;
  };
  const worker = yield* makeDrainableWorker(() =>
    Effect.sync(takeScope).pipe(
      Effect.tap(() => Effect.suspend(() => beforeSweep)),
      Effect.flatMap(sweep),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const enqueueScope = (threadId: ThreadId | null) =>
    Effect.suspend(() => {
      if (threadId === null) fullSweepQueued = true;
      else queuedThreadIds.add(threadId);
      if (queued) return Effect.void;
      queued = true;
      return worker.enqueue(undefined);
    });
  const enqueue = enqueueScope(null);
  const start = Effect.fn("ThreadSettlementReactor.start")(function* (options?: {
    readonly beforeSweep?: Effect.Effect<void>;
  }) {
    beforeSweep = options?.beforeSweep ?? Effect.void;
    const changes = yield* settingsService.subscribeChanges;
    const merges = yield* pullRequests.subscribeMerges;
    yield* forkParked(
      Stream.runForEach(merges, (event) =>
        Effect.gen(function* () {
          const parsed = parseChangeRequestUrl(event.url) ?? event;
          const repositoryKey = canonicalRepositoryKey(
            `${parsed.host}/${parsed.repository}`.toLowerCase(),
          );
          const projectSnapshot = yield* projects.snapshot;
          const matchingProjects = new Map(
            projectSnapshot.projects
              .filter(
                (project) =>
                  project.id === event.projectId ||
                  (project.repositoryIdentity != null &&
                    canonicalRepositoryKey(
                      project.repositoryIdentity.canonicalKey.toLowerCase(),
                    ) === repositoryKey),
              )
              .map((project) => [project.id, project]),
          );
          const threads = yield* projections.listThreads({
            kind: "active",
            projectIds: [...matchingProjects.keys()],
          });
          const cwds = new Set<string>();
          for (const thread of threads) {
            const project = matchingProjects.get(thread.projectId);
            if (project === undefined || thread.deletedAt !== null || thread.archivedAt !== null)
              continue;
            const hasWorktree =
              thread.worktreePath !== null && (yield* fileSystem.exists(thread.worktreePath));
            cwds.add(
              hasWorktree && thread.worktreePath !== null
                ? thread.worktreePath
                : project.workspaceRoot,
            );
          }
          yield* Effect.forEach(cwds, (cwd) => git.invalidateStatus(cwd), {
            concurrency: 8,
            discard: true,
          });
          yield* enqueue;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("merged pull request settlement refresh failed", {
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      ),
    );

    yield* forkParked(Stream.runForEach(changes, () => enqueue));
    // Pushed host snapshots and completed runs make the decision promptly; no client is required.
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.metadata-updated" || event.type === "run.updated"
          ? enqueueScope(event.threadId)
          : Effect.void,
      ),
    );
    yield* forkParked(
      Effect.gen(function* () {
        yield* enqueue;
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });
  return {
    start,
    drain: worker.drain,
    requestSweep: enqueue,
  } satisfies ThreadSettlementReactor["Service"];
});
export const layer = Layer.effect(ThreadSettlementReactor, make);
