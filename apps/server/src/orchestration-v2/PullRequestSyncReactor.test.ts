import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2Command,
  type PullRequestSummary,
  type PullRequestStack,
} from "@t3tools/contracts";
import { updateLinkedPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
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
    Layer.mock(PullRequestService)({ summary, stack: stackRead, invalidate: () => Effect.void }),
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
