import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type PullRequestRef,
  type PullRequestSummary,
  type PullRequestStack,
} from "@t3tools/contracts";
import { updateLinkedPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import {
  type PullRequestMergeEvent,
  PullRequestService,
} from "../pullRequest/PullRequestService.ts";
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
  } = {},
) {
  let shells = initial;
  const summary = vi.fn(() => read);
  const stackRead = vi.fn(() => Effect.succeed(nativeStack));
  const dispatch = vi.fn((command: OrchestrationV2Command) =>
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
    Layer.mock(ThreadManagementService)({
      streamDomainEvents: extra.domainEvents ?? Stream.empty,
      getShellSnapshot: () =>
        Effect.succeed({
          threads: shells,
          snapshotSequence: 1,
          schemaVersion: 1,
          archivedThreads: [],
        } as OrchestrationV2ThreadShellSnapshot),
      getThreadShell: (id) => Effect.succeed(shells.find((thread) => thread.id === id) ?? null),
      dispatch,
    }),
    Layer.mock(PullRequestService)({
      summary,
      stack: stackRead,
      invalidate: extra.invalidate ?? (() => Effect.void),
      subscribeMerges: Effect.succeed(merges),
    }),
    NodeServices.layer,
  );
  return {
    layer,
    summary,
    stackRead,
    dispatch,
    shells: () => shells,
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
