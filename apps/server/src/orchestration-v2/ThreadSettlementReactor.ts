import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import { CommandId, type OrchestrationV2ThreadShell, type Project } from "@t3tools/contracts";
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
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
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
    readonly requestSweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementReactor") {}

/** @public Canonical Effect service construction. */
export const make = Effect.gen(function* () {
  const engine = yield* ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;

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
      if (
        summary.state !== "open" &&
        thread.branch !== null &&
        cwd !== null &&
        project !== undefined
      ) {
        // Branch reuse must win over an older terminal branch candidate.
        const current = yield* git.branchPullRequest(
          { cwd, branch: thread.branch },
          { refresh: true },
        );
        if (current?.state === "open" && pullRequestMatchesProject(current, project))
          return current;
      }
      return {
        state: summary.state,
        mergedAt: summary.mergedAt ?? null,
        closedAt: summary.closedAt ?? null,
      } satisfies SettlementPullRequest;
    }
    if (thread.branch === null || cwd === null || project === undefined) return null;
    const candidate = yield* git.branchPullRequest({ cwd, branch: thread.branch });
    return candidate !== null && pullRequestMatchesProject(candidate, project) ? candidate : null;
  });

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* () {
    const settings = yield* settingsService.getSettings;
    if (!settings.sidebarAutoSettleOnMerge && settings.sidebarAutoSettleAfterDays === null) return;
    const snapshot = yield* engine.getShellSnapshot({ location: "active" });
    const projectSnapshot = yield* projects.snapshot;
    const projectById = new Map(projectSnapshot.projects.map((project) => [project.id, project]));
    const now = yield* DateTime.now;
    const candidates = snapshot.threads.filter((thread) => isAutoSettlementCandidate(thread, now));
    const settle = Effect.fn("ThreadSettlementReactor.settle")(function* (
      thread: OrchestrationV2ThreadShell,
      expectedSequence: number,
      pullRequest: SettlementPullRequest | null,
    ) {
      const current = yield* settingsService.getSettings;
      const settledAt = resolveAutoSettlementAt({
        thread,
        pullRequest,
        now: yield* DateTime.now,
        autoSettleAfterDays: current.sidebarAutoSettleAfterDays,
        autoSettleOnMerge: current.sidebarAutoSettleOnMerge,
      });
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
  let beforeSweep: Effect.Effect<void> = Effect.void;
  let queued = false;
  const worker = yield* makeDrainableWorker(() =>
    Effect.sync(() => {
      queued = false;
    }).pipe(
      Effect.andThen(Effect.suspend(() => beforeSweep)),
      Effect.andThen(sweep()),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const enqueue = Effect.suspend(() => {
    if (queued) return Effect.void;
    queued = true;
    return worker.enqueue(undefined);
  });
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
          const snapshot = yield* engine.getShellSnapshot({ location: "active" });
          const cwds = new Set<string>();
          for (const thread of snapshot.threads) {
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
          ? enqueue
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
