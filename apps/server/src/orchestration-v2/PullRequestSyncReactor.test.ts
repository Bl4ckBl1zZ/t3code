import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  PullRequestOperationError,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type PullRequestRef,
  type PullRequestSummary,
  type PullRequestStack,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { updateLinkedPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import {
  type PullRequestMergeEvent,
  PullRequestService,
} from "../pullRequest/PullRequestService.ts";
import { ProjectionStoreV2, threadMatchesQuery } from "./ProjectionStore.ts";
import { make } from "./PullRequestSyncReactor.ts";

const projectId = ProjectId.make("p");
const ref = {
  projectId,
  repository: "org/repo",
  number: 1,
  url: "https://github.com/org/repo/pull/1",
};
const key = { host: "github.com", repository: ref.repository, number: 1 };
const at = "2026-09-11T00:00:00.000Z";
const overview: PullRequestSummary = {
  provider: "github",
  projectId,
  repository: ref.repository,
  number: 1,
  url: ref.url,
  title: "A pull request",
  state: "open",
  headBranch: "feature/one",
  baseBranch: "main",
  updatedAt: at,
};
const stack: PullRequestStack = {
  id: "native-9",
  number: 9,
  url: "https://github.com/org/repo/stack/9",
  base: "main",
  layers: [
    { number: 1, headBranch: "feature/one", state: "open" },
    { number: 2, headBranch: "feature/two", state: "open" },
  ],
};
const shell = (id: string): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    ...updateLinkedPullRequests({}, { linkPullRequest: ref }, at),
  }) as unknown as OrchestrationV2ThreadShell;

function harness(
  initial: OrchestrationV2ThreadShell[],
  read: Effect.Effect<PullRequestSummary> = Effect.succeed(overview),
  nativeStack: PullRequestStack | null = null,
  merges: Stream.Stream<PullRequestMergeEvent> = Stream.empty,
  extra: {
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
    readonly invalidate?: (input: {
      readonly reference?: PullRequestRef | undefined;
    }) => Effect.Effect<void>;
    readonly summary?: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestSummary, PullRequestOperationError>;
    readonly stack?: () => Effect.Effect<PullRequestStack | null, PullRequestOperationError>;
    readonly stateChanges?: Stream.Stream<ThreadPullRequestKey>;
  } = {},
) {
  let shells = initial;
  const summary = vi.fn((input: PullRequestRef) => extra.summary?.(input) ?? read);
  const stackRead = vi.fn(() => extra.stack?.() ?? Effect.succeed(nativeStack));
  const dispatch = vi.fn((command: OrchestrationV2ServerCommand) =>
    Effect.sync(() => {
      if (command.type !== "thread.metadata.update")
        throw new Error("Expected V2 metadata command");
      shells = shells.map((thread) =>
        thread.id !== command.threadId
          ? thread
          : {
              ...thread,
              ...updateLinkedPullRequests(thread, command, at),
            },
      );
      return { sequence: dispatch.mock.calls.length, storedEvents: [] };
    }),
  );
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionStoreV2)({
      listThreads: (query) =>
        Effect.succeed(
          shells.filter((thread) =>
            threadMatchesQuery(thread as unknown as OrchestrationV2AppThread, query),
          ) as unknown as ReadonlyArray<OrchestrationV2AppThread>,
        ),
    }),
    Layer.mock(ThreadManagementService)({
      streamDomainEvents: extra.domainEvents ?? Stream.empty,
      getThreadShell: (id) => Effect.succeed(shells.find((thread) => thread.id === id) ?? null),
      dispatch,
    }),
    Layer.mock(PullRequestService)({
      summary,
      stack: stackRead,
      invalidate: extra.invalidate ?? (() => Effect.void),
      subscribeMerges: Effect.succeed(merges),
      subscribeStateChanges: Effect.succeed(extra.stateChanges ?? Stream.empty),
    }),
    NodeServices.layer,
  );
  return {
    layer,
    summary,
    stackRead,
    dispatch,
    shells: () => shells,
    setShells: (next: OrchestrationV2ThreadShell[]) => {
      shells = next;
    },
    remove: (id: string) => {
      shells = shells.map((thread) =>
        thread.id === id
          ? { ...thread, ...updateLinkedPullRequests(thread, { unlinkPullRequest: ref }, at) }
          : thread,
      );
    },
  };
}

it.effect("reads a shared PR once and writes only changed snapshots", () =>
  Effect.gen(function* () {
    const h = harness([shell("one"), shell("two")]);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSync(key);
    yield* reactor.drain;
    expect(h.summary).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.shells().map((thread) => thread.pullRequests?.[0]?.snapshot?.title)).toEqual([
      "A pull request",
      "A pull request",
    ]);
    yield* reactor.requestSync(key);
    yield* reactor.drain;
    expect(h.summary).toHaveBeenCalledTimes(2);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped),
);

it.effect("does not add stack siblings when the anchor was removed during the host read", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const read = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(finish)),
      Effect.as(overview),
    );
    const h = harness([shell("one")], read, stack);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSync(key);
    yield* Deferred.await(entered);
    h.remove("one");
    yield* Deferred.succeed(finish, undefined);
    yield* reactor.drain;
    expect(h.shells()[0]?.pullRequests).toEqual([]);
    expect(
      h.dispatch.mock.calls.some(
        ([command]) =>
          command.type === "thread.metadata.update" && command.linkPullRequest !== undefined,
      ),
    ).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("preserves dismissed native stack members and guards additions by their anchor", () =>
  Effect.gen(function* () {
    let thread = shell("one");
    thread = {
      ...thread,
      ...updateLinkedPullRequests(
        thread,
        {
          linkPullRequest: { ...ref, number: 2, url: "https://github.com/org/repo/pull/2" },
          linkPullRequestSource: "stack",
        },
        at,
      ),
    };
    thread = {
      ...thread,
      ...updateLinkedPullRequests(
        thread,
        { unlinkPullRequest: { ...ref, number: 2, url: "https://github.com/org/repo/pull/2" } },
        at,
      ),
    };
    const h = harness([thread, shell("two")], Effect.succeed(overview), stack);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSync(key);
    yield* reactor.drain;
    expect(h.shells()[0]?.linkedPullRequests?.map((link) => link.number)).toEqual([1]);
    expect(h.shells()[1]?.linkedPullRequests?.map((link) => link.number)).toEqual([1, 2]);
    const additions = h.dispatch.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "thread.metadata.update" && command.linkPullRequest);
    expect(additions).toHaveLength(1);
    expect(additions[0]).toMatchObject({
      expectedPullRequestLink: { number: 1, source: "manual", linkedAt: at },
      linkPullRequestSource: "stack",
    });
  }).pipe(Effect.scoped),
);

it.effect("a merge notification refreshes an otherwise idle merged link", () =>
  Effect.gen(function* () {
    const notified = yield* Deferred.make<PullRequestMergeEvent>();
    const read = yield* Deferred.make<void>();
    const thread = shell("merged");
    const merged = { ...overview, state: "merged" as const, mergedAt: at };
    const h = harness(
      [
        {
          ...thread,
          pullRequests:
            thread.pullRequests?.map((link) => ({
              ...link,
              snapshot: { ...merged, isDraft: false, closedAt: null, syncedAt: at },
            })) ?? [],
        },
      ],
      Deferred.succeed(read, undefined).pipe(Effect.as({ ...merged, title: "Confirmed merge" })),
      null,
      Stream.fromEffect(Deferred.await(notified)),
    );
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.start();
    yield* Deferred.succeed(notified, { ...ref, host: key.host, mergedAt: at });
    yield* Deferred.await(read);
    yield* reactor.drain;
    expect(h.shells()[0]?.pullRequests?.[0]?.snapshot?.title).toBe("Confirmed merge");
    expect(h.summary).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);

it.effect("syncs a pull request a reader saw merge without waiting for the sweep", () =>
  Effect.gen(function* () {
    const stateChanges = yield* Queue.unbounded<ThreadPullRequestKey>();
    const invalidated: Array<number> = [];
    const requested = yield* Deferred.make<void>();
    let state: PullRequestSummary["state"] = "open";
    const thread = shell("agent");
    const h = harness(
      [
        {
          ...thread,
          pullRequests:
            thread.pullRequests?.map((link) => ({
              ...link,
              snapshot: { ...overview, isDraft: false, closedAt: null, syncedAt: at },
            })) ?? [],
        },
      ],
      Effect.succeed(overview),
      null,
      Stream.empty,
      {
        stateChanges: Stream.fromQueue(stateChanges),
        invalidate: ({ reference }) =>
          Effect.sync(() => invalidated.push(reference?.number ?? -1)).pipe(
            Effect.andThen(Deferred.succeed(requested, undefined)),
          ),
        summary: () =>
          Effect.sync(() => (state === "merged" ? { ...overview, state, mergedAt: at } : overview)),
      },
    );
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.start();
    yield* reactor.drain;
    state = "merged";

    // The clock stays put: the next sweep is still a minute away.
    yield* Queue.offer(stateChanges, key);
    yield* Deferred.await(requested);
    yield* reactor.drain;
    expect(invalidated).toEqual([1]);
    expect(h.shells()[0]?.pullRequests?.[0]?.snapshot?.state).toBe("merged");
  }).pipe(Effect.scoped),
);

const commandRan = (threadId: string, input: string) =>
  ({
    type: "turn-item.updated",
    threadId: ThreadId.make(threadId),
    payload: { type: "command_execution", input },
  }) as unknown as OrchestrationV2DomainEvent;

const runEnded = (threadId: string) =>
  ({
    type: "run.updated",
    threadId: ThreadId.make(threadId),
    payload: { status: "completed" },
  }) as unknown as OrchestrationV2DomainEvent;

it.effect("re-reads open links fresh only when a run that ran a merge command ends", () =>
  Effect.gen(function* () {
    const openSnapshot = { ...overview, isDraft: false, closedAt: null, syncedAt: at };
    const withOpenSnapshot = (thread: OrchestrationV2ThreadShell, number: number) => {
      const linked = {
        ...thread,
        ...updateLinkedPullRequests(
          {},
          {
            linkPullRequest: { ...ref, number, url: `https://github.com/org/repo/pull/${number}` },
          },
          at,
        ),
      } as OrchestrationV2ThreadShell;
      return {
        ...linked,
        pullRequests:
          linked.pullRequests?.map((link) => ({
            ...link,
            snapshot: { ...openSnapshot, number },
          })) ?? [],
      } as OrchestrationV2ThreadShell;
    };
    const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const invalidated: Array<number> = [];
    const agentInvalidated = yield* Deferred.make<void>();
    const h = harness(
      [withOpenSnapshot(shell("other"), 2), withOpenSnapshot(shell("agent"), 1)],
      Effect.succeed(overview),
      null,
      Stream.empty,
      {
        domainEvents: Stream.fromQueue(domainEvents),
        invalidate: ({ reference }) =>
          Effect.suspend(() => {
            invalidated.push(reference?.number ?? -1);
            return reference?.number === 1
              ? Deferred.succeed(agentInvalidated, undefined)
              : Effect.void;
          }),
      },
    );
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.start();
    yield* reactor.drain;

    yield* Queue.offerAll(domainEvents, [
      // A run that only reads its pull request costs no fresh host read when it ends.
      commandRan("other", "gh pr view 2"),
      runEnded("other"),
      commandRan("agent", "gh pr merge 1 --squash 2>&1 | tail -3"),
      runEnded("agent"),
    ]);
    yield* Deferred.await(agentInvalidated);
    yield* reactor.drain;
    expect(invalidated).toEqual([1]);
  }).pipe(Effect.scoped),
);

const rateLimited = (operation: string, retryAt: number) =>
  new PullRequestOperationError({
    operation,
    detail: "paused",
    cause: new PullRequestProviderError({
      provider: "github",
      operation,
      reason: "rate-limited",
      detail: "paused",
      retryAt,
    }),
  });

const linkedShell = (id: string, number: number, url: string) =>
  ({
    ...shell(id),
    ...updateLinkedPullRequests({}, { linkPullRequest: { ...ref, number, url } }, at),
  }) as OrchestrationV2ThreadShell;

it.effect("leaves a rate limited host unread until its pause ends", () =>
  Effect.gen(function* () {
    const skips: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      const parts = Array.isArray(message) ? message : [message];
      if (logLevel === "Warn" && parts[0] === "pull request sync skipped") skips.push(parts);
    });
    yield* TestClock.setTime(Date.parse(at));
    const retryAt = Date.parse(at) + 3 * 60_000;
    const h = harness(
      [
        linkedShell("first", 1, "https://github.com/org/repo/pull/1"),
        linkedShell("second", 2, "https://github.com/org/repo/pull/2"),
        linkedShell("third", 3, "https://gitlab.com/org/repo/-/merge_requests/3"),
      ],
      Effect.succeed(overview),
      null,
      Stream.empty,
      {
        summary: (input) =>
          Effect.gen(function* () {
            if (input.host === "github.com" && (yield* Clock.currentTimeMillis) < retryAt) {
              return yield* rateLimited("getChangeRequestSummary", retryAt);
            }
            return { ...overview, number: input.number };
          }),
      },
    );
    const reads = (host: string) =>
      h.summary.mock.calls
        .map(([input]) => input)
        .filter((input) => input.host === host)
        .map((input) => input.number);
    const gitlabKey = { host: "gitlab.com", repository: ref.repository, number: 3 };
    // The reactor forks its worker as it is made, so the logger must reach it there.
    const reactor = yield* make.pipe(
      Effect.provide(Layer.merge(h.layer, Logger.layer([logger], { mergeWithExisting: false }))),
    );

    // The first refused read pauses the host, so the sweep does not try the other.
    yield* reactor.requestSync(gitlabKey);
    yield* reactor.drain;
    expect(reads("github.com")).toEqual([1]);
    expect(reads("gitlab.com")).toEqual([3]);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.[1]).toMatchObject({ count: 1 });

    // A requested refresh waits for the pause like the sweep does; other hosts still read.
    yield* reactor.requestSync(key);
    yield* reactor.drain;
    expect(reads("github.com")).toEqual([1]);
    expect(reads("gitlab.com")).toEqual([3, 3]);
    expect(skips).toHaveLength(1);

    yield* TestClock.setTime(retryAt);
    yield* reactor.requestSync(gitlabKey);
    yield* reactor.drain;
    expect(reads("github.com").slice(1).toSorted()).toEqual([1, 2]);
  }).pipe(Effect.scoped),
);

it.effect("pauses the host when only its stack read is rate limited", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at));
    const retryAt = Date.parse(at) + 3 * 60_000;
    const h = harness([shell("one")], Effect.succeed(overview), null, Stream.empty, {
      stack: () =>
        Effect.gen(function* () {
          if ((yield* Clock.currentTimeMillis) >= retryAt) return null;
          return yield* rateLimited("getChangeRequestStack", retryAt);
        }),
    });
    const reads = () => [h.summary.mock.calls.length, h.stackRead.mock.calls.length];
    const reactor = yield* make.pipe(Effect.provide(h.layer));

    yield* reactor.requestSync(key);
    yield* reactor.drain;
    expect(reads()).toEqual([1, 1]);
    yield* reactor.requestSync(key);
    yield* reactor.drain;
    expect(reads()).toEqual([1, 1]);
    expect(h.dispatch).not.toHaveBeenCalled();

    // Once the pause ends the pull request is read again, stack included.
    yield* TestClock.setTime(retryAt);
    yield* reactor.requestSync(key);
    yield* reactor.drain;
    expect(reads()).toEqual([2, 2]);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);

const withSnapshot = (
  thread: OrchestrationV2ThreadShell,
  states: Record<number, PullRequestSummary["state"]>,
): OrchestrationV2ThreadShell => {
  const linked = { ...thread, pullRequests: [] } as OrchestrationV2ThreadShell;
  for (const number of Object.keys(states).map(Number)) {
    Object.assign(
      linked,
      updateLinkedPullRequests(
        linked,
        { linkPullRequest: { ...ref, number, url: `https://github.com/org/repo/pull/${number}` } },
        at,
      ),
    );
  }
  return {
    ...linked,
    pullRequests:
      linked.pullRequests?.map((link) => ({
        ...link,
        snapshot: {
          ...overview,
          number: link.number,
          state: states[link.number]!,
          isDraft: false,
          closedAt: null,
          syncedAt: at,
        },
      })) ?? [],
  } as OrchestrationV2ThreadShell;
};

it.effect("leaves a settled thread's links unread until the thread is unsettled", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at));
    const settled = {
      ...withSnapshot(shell("settled"), { 5: "open", 6: "closed" }),
      settledOverride: "settled",
      settledAt: at,
    } as unknown as OrchestrationV2ThreadShell;
    const h = harness([settled]);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    // A request for a pull request no thread links runs a sweep and reads nothing else.
    const sweep = Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      yield* reactor.requestSync({ ...key, number: 999 });
      yield* reactor.drain;
    });

    for (let index = 0; index < 16; index += 1) yield* sweep;
    expect(h.summary).not.toHaveBeenCalled();

    h.setShells(
      h.shells().map((thread) => ({ ...thread, settledOverride: null, settledAt: null })),
    );
    yield* sweep;
    expect(h.summary.mock.calls.map(([input]) => input.number).toSorted()).toEqual([5, 6]);
  }).pipe(Effect.scoped),
);

it.effect("auto-links missing native stack layers on active threads only", () =>
  Effect.gen(function* () {
    const settled = {
      ...shell("settled"),
      settledOverride: "settled",
      settledAt: at,
    } as unknown as OrchestrationV2ThreadShell;
    const h = harness([shell("one"), settled], Effect.succeed(overview), stack);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSync(key);
    yield* reactor.drain;

    const commands = h.dispatch.mock.calls.flatMap(([command]) =>
      command.type === "thread.metadata.update" ? [command] : [],
    );
    expect(
      commands
        .filter((command) => command.syncPullRequest !== undefined)
        .map((command) => [command.threadId, command.syncPullRequest?.stack?.kind]),
    ).toEqual([
      [ThreadId.make("one"), "native"],
      [ThreadId.make("settled"), "native"],
    ]);
    expect(
      commands
        .filter((command) => command.linkPullRequest !== undefined)
        .map((command) => [command.threadId, command.linkPullRequest?.number]),
    ).toEqual([[ThreadId.make("one"), 2]]);
  }).pipe(Effect.scoped),
);
