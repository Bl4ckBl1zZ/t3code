import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
  type Project,
  type PullRequestSummary,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import {
  type PullRequestMergeEvent,
  PullRequestService,
} from "../pullRequest/PullRequestService.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ProjectionStoreV2, threadMatchesQuery } from "./ProjectionStore.ts";
import { make } from "./ThreadSettlementReactor.ts";

const epoch = DateTime.makeUnsafe(0);
const fixture = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: ThreadId.make("thread"),
    projectId: ProjectId.make("project"),
    branch: null,
    worktreePath: null,
    status: "completed",
    activeRunId: null,
    pendingRuntimeRequest: null,
    createdAt: epoch,
    updatedAt: epoch,
    latestUserMessageAt: epoch,
    latestRunRequestedAt: epoch,
    latestRunStartedAt: epoch,
    latestRunCompletedAt: epoch,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    pullRequests: [],
    ...overrides,
  }) as OrchestrationV2ThreadShell;

/** A projection store over these shells, narrowing each sweep's read like the SQL store does. */
const projectionsOf = (shells: () => ReadonlyArray<OrchestrationV2ThreadShell>) => {
  const listThreads = vi.fn((query: Parameters<ProjectionStoreV2["Service"]["listThreads"]>[0]) =>
    Effect.succeed(
      shells().filter((thread) =>
        threadMatchesQuery(thread as unknown as OrchestrationV2AppThread, query),
      ) as unknown as ReadonlyArray<OrchestrationV2AppThread>,
    ),
  );
  return { listThreads, layer: Layer.mock(ProjectionStoreV2)({ listThreads }) };
};

function harness(thread: OrchestrationV2ThreadShell, enabled = true) {
  const summary = vi.fn(() => Effect.die("Unexpected host read"));
  const branch = vi.fn(() => Effect.die("Unexpected git read"));
  const dispatch = vi.fn((command: OrchestrationV2ServerCommand) =>
    Effect.sync(() => {
      expect(command.type).toBe("thread.settle");
      return { sequence: 8, storedEvents: [] };
    }),
  );
  const projections = projectionsOf(() => [thread]);
  return {
    summary,
    branch,
    dispatch,
    listThreads: projections.listThreads,
    layer: Layer.mergeAll(
      projections.layer,
      Layer.mock(ThreadManagementService)({
        getThreadEventSequence: () => Effect.succeed(7),
        getThreadShell: () => Effect.succeed(thread),
        dispatch,
      }),
      Layer.mock(ProjectService)({
        snapshot: Effect.succeed({ projects: [], updatedAt: "1970-01-01T00:00:00Z" }),
      }),
      Layer.mock(PullRequestService)({ summary }),
      Layer.mock(GitManager)({ branchPullRequest: branch }),
      Layer.mock(GitWorkflowService)({}),
      ServerSettings.layerTest(
        enabled ? {} : { sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: null },
      ),
      NodeServices.layer,
    ),
  };
}

it.effect("settles inactivity without touching git or host APIs", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("10 days");
    const h = harness(fixture());
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({
      automatic: { expectedSequence: 7 },
      settledAt: "1970-01-01T00:00:00.000Z",
    });
    expect(h.summary).not.toHaveBeenCalled();
    expect(h.branch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("a thread's own events decide that thread again, not every thread", () =>
  Effect.gen(function* () {
    const one = fixture({ id: ThreadId.make("one") });
    const two = fixture({ id: ThreadId.make("two") });
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const shellReads = yield* Queue.unbounded<ThreadId>();
    const layer = Layer.mergeAll(
      projectionsOf(() => [one, two]).layer,
      Layer.mock(ThreadManagementService)({
        streamDomainEvents: Stream.fromQueue(events),
        getThreadEventSequence: () => Effect.succeed(7),
        getThreadShell: (id) =>
          Queue.offer(shellReads, id).pipe(Effect.as(id === one.id ? one : two)),
        dispatch: () => Effect.die("Nothing is due"),
      }),
      Layer.mock(ProjectService)({
        snapshot: Effect.succeed({ projects: [], updatedAt: "1970-01-01T00:00:00Z" }),
      }),
      Layer.mock(PullRequestService)({ subscribeMerges: Effect.succeed(Stream.never) }),
      Layer.mock(GitManager)({}),
      Layer.mock(GitWorkflowService)({}),
      ServerSettings.layerTest({}),
      NodeServices.layer,
    );
    const reactor = yield* make.pipe(Effect.provide(layer));
    yield* reactor.start();
    // The first periodic sweep decides every thread.
    const initial = [yield* Queue.take(shellReads), yield* Queue.take(shellReads)];
    expect(initial.toSorted()).toEqual([one.id, two.id]);
    yield* reactor.drain;

    yield* Queue.offer(events, {
      type: "run.updated",
      threadId: one.id,
    } as unknown as OrchestrationV2DomainEvent);
    expect(yield* Queue.take(shellReads)).toBe(one.id);
    yield* reactor.drain;
    expect(yield* Queue.size(shellReads)).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("disabled automatic settings do not even scan threads", () =>
  Effect.gen(function* () {
    const h = harness(fixture(), false);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.listThreads).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("unknown explicit link snapshots keep quiet work active without re-reading details", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("10 days");
    const h = harness(
      fixture({
        pullRequests: [
          {
            host: "github.com",
            repository: "org/repo",
            number: 1,
            url: "https://github.com/org/repo/pull/1",
            source: "agent",
            linkedAt: "1970-01-01T00:00:00Z",
            snapshot: null,
            stack: null,
          },
        ],
      }),
    );
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.summary).not.toHaveBeenCalled();
    expect(h.branch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("skips the branch recheck when a terminal link would settle nothing", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("12 days");
    // Work resumed after the merge and is too recent for inactivity, so the
    // merged link cannot settle the thread.
    const thread = fixture({
      branch: "feature",
      latestUserMessageAt: DateTime.makeUnsafe(10 * 86_400_000),
      latestUserAuthoredMessageAt: DateTime.makeUnsafe(10 * 86_400_000),
      linkedPullRequest: {
        projectId: ProjectId.make("project"),
        repository: "org/repo",
        number: 1,
        url: "https://github.com/org/repo/pull/1",
      },
    });
    const project = {
      id: thread.projectId,
      workspaceRoot: "/repo",
      updatedAt: "1970-01-01T00:00:00Z",
    } as unknown as Project;
    const summary = vi.fn(() =>
      Effect.succeed<PullRequestSummary>({
        provider: "github",
        projectId: thread.projectId,
        repository: "org/repo",
        number: 1,
        title: "Feature",
        url: "https://github.com/org/repo/pull/1",
        state: "merged",
        headBranch: "feature",
        baseBranch: "main",
        mergedAt: "1970-01-02T00:00:00.000Z",
        closedAt: null,
        updatedAt: "1970-01-02T00:00:00.000Z",
      }),
    );
    const h = harness(thread);
    const layer = Layer.mergeAll(
      h.layer,
      Layer.mock(ProjectService)({
        snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
      }),
      Layer.mock(PullRequestService)({ summary }),
    );
    const reactor = yield* make.pipe(Effect.provide(layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(summary).toHaveBeenCalledTimes(1);
    expect(h.branch).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("settles a merged thread the agent woke on its own after the merge", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("12 days");
    const wokeAt = DateTime.makeUnsafe(10 * 86_400_000);
    // A delegated result woke the agent after the merge; the user last wrote before it.
    const thread = fixture({
      latestUserMessageAt: wokeAt,
      latestUserAuthoredMessageAt: epoch,
      latestRunRequestedAt: wokeAt,
      latestRunStartedAt: wokeAt,
      latestRunCompletedAt: wokeAt,
      pullRequests: [
        {
          host: "github.com",
          repository: "org/repo",
          number: 1,
          url: "https://github.com/org/repo/pull/1",
          source: "agent",
          linkedAt: "1970-01-01T00:00:00Z",
          stack: null,
          snapshot: {
            state: "merged",
            title: "Feature",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: "1970-01-02T00:00:00.000Z",
            syncedAt: "1970-01-02T00:00:00.000Z",
            mergedAt: "1970-01-02T00:00:00.000Z",
            closedAt: null,
          },
        },
      ],
    });
    const h = harness(thread);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.summary).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("a confirmed merge invalidates the matching checkout before scheduling settlement", () =>
  Effect.gen(function* () {
    const notified = yield* Deferred.make<PullRequestMergeEvent>();
    const invalidated = yield* Deferred.make<void>();
    const thread = fixture();
    const project: Project = {
      id: thread.projectId,
      title: "Repo",
      workspaceRoot: "/merge-checkout",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "1970-01-01T00:00:00Z",
      updatedAt: "1970-01-01T00:00:00Z",
      deletedAt: null,
    };
    const invalidate = vi.fn((cwd: string) => {
      expect(cwd).toBe(project.workspaceRoot);
      return Deferred.succeed(invalidated, undefined).pipe(Effect.asVoid);
    });
    const layer = Layer.mergeAll(
      projectionsOf(() => [thread]).layer,
      Layer.mock(ThreadManagementService)({
        streamDomainEvents: Stream.empty,
      }),
      Layer.mock(ProjectService)({
        snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
      }),
      Layer.mock(PullRequestService)({
        subscribeMerges: Effect.succeed(Stream.fromEffect(Deferred.await(notified))),
      }),
      Layer.mock(GitManager)({ invalidateStatus: invalidate }),
      Layer.mock(GitWorkflowService)({}),
      ServerSettings.layerTest({
        sidebarAutoSettleOnMerge: false,
        sidebarAutoSettleAfterDays: null,
      }),
      NodeServices.layer,
    );
    const reactor = yield* make.pipe(Effect.provide(layer));
    yield* reactor.start();
    yield* Deferred.succeed(notified, {
      projectId: project.id,
      host: "github.com",
      repository: "org/repo",
      number: 1,
      url: "https://github.com/org/repo/pull/1",
      mergedAt: "2026-09-11T00:00:00Z",
    });
    yield* Deferred.await(invalidated);
    yield* reactor.drain;
    expect(invalidate).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);

const deleteProject = {
  id: ProjectId.make("project"),
  workspaceRoot: "/repo",
  updatedAt: "1970-01-01T00:00:00Z",
} as unknown as Project;
const settled = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  fixture({
    settledOverride: "settled",
    settledAt: epoch,
    branch: "feature",
    worktreePath: "/repo-worktrees/feature",
    ...overrides,
  });

function deleteHarness(thread: OrchestrationV2ThreadShell, others: OrchestrationV2ThreadShell[]) {
  const calls: string[] = [];
  const dispatch = vi.fn((command: OrchestrationV2ServerCommand) =>
    Effect.sync(() => {
      calls.push(command.type);
      return { sequence: 8, storedEvents: [] };
    }),
  );
  const removeWorktree = vi.fn(
    (input: { readonly path: string; readonly force?: boolean | undefined }) =>
      Effect.sync(() => void calls.push(`remove ${input.path} force=${input.force}`)),
  );
  const deleteLocalBranch = vi.fn(
    (input: { readonly refName: string; readonly force?: boolean | undefined }) =>
      Effect.sync(() => void calls.push(`branch ${input.refName} force=${input.force}`)),
  );
  const layer = Layer.mergeAll(
    projectionsOf(() => [thread, ...others]).layer,
    Layer.mock(ThreadManagementService)({
      getThreadEventSequence: () => Effect.succeed(7),
      getThreadShell: () => Effect.succeed(thread),
      dispatch,
    }),
    Layer.mock(ProjectService)({
      snapshot: Effect.succeed({ projects: [deleteProject], updatedAt: "1970-01-01T00:00:00Z" }),
    }),
    Layer.mock(PullRequestService)({}),
    Layer.mock(GitManager)({}),
    Layer.mock(GitWorkflowService)({ removeWorktree, deleteLocalBranch }),
    ServerSettings.layerTest({
      sidebarAutoSettleOnMerge: false,
      sidebarAutoSettleAfterDays: null,
      autoDeleteSettledAfterDays: 30,
    }),
    NodeServices.layer,
  );
  return { calls, dispatch, removeWorktree, deleteLocalBranch, layer };
}

it.effect("deletes a long-settled thread, then force-removes its worktree and branch", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("31 days");
    const h = deleteHarness(settled(), []);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.delete",
      automatic: { expectedSequence: 7 },
    });
    expect(h.calls).toEqual([
      "thread.delete",
      "remove /repo-worktrees/feature force=true",
      "branch feature force=true",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("counts from when the thread entered Settled, not its backdated settle time", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("31 days");
    const h = deleteHarness(settled({ settledRecordedAt: DateTime.makeUnsafe("1970-01-30") }), []);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.dispatch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("keeps pinned threads", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("31 days");
    const h = deleteHarness(settled({ pinnedAt: epoch }), []);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.dispatch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("keeps a worktree and branch another thread still uses", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("31 days");
    const archivedOwner = settled({
      id: ThreadId.make("other"),
      settledOverride: null,
      archivedAt: epoch,
    });
    const h = deleteHarness(settled(), [archivedOwner]);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.calls).toEqual(["thread.delete"]);
  }).pipe(Effect.scoped),
);

it.effect("never removes the project root", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("31 days");
    const h = deleteHarness(settled({ worktreePath: "/repo", branch: "main" }), []);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.calls).toEqual(["thread.delete"]);
  }).pipe(Effect.scoped),
);
