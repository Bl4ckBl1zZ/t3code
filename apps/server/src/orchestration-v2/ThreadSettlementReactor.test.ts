import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { GitManager } from "../git/GitManager.ts";
import * as ServerSettings from "../serverSettings.ts";
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

function harness(thread: OrchestrationV2ThreadShell, enabled = true) {
  const summary = vi.fn(() => Effect.die("Unexpected host read"));
  const branch = vi.fn(() => Effect.die("Unexpected git read"));
  const dispatch = vi.fn((command: OrchestrationV2Command) =>
    Effect.sync(() => {
      expect(command.type).toBe("thread.settle");
      return { sequence: 8, storedEvents: [] };
    }),
  );
  const snapshot = vi.fn(() =>
    Effect.succeed({
      schemaVersion: 1,
      snapshotSequence: 7,
      threads: [thread],
      archivedThreads: [],
    }),
  );
  return {
    summary,
    branch,
    dispatch,
    snapshot,
    layer: Layer.mergeAll(
      Layer.mock(ThreadManagementService)({
        getShellSnapshot: snapshot,
        getThreadEventSequence: () => Effect.succeed(7),
        getThreadShell: () => Effect.succeed(thread),
        dispatch,
      }),
      Layer.mock(ProjectService)({
        snapshot: Effect.succeed({ projects: [], updatedAt: "1970-01-01T00:00:00Z" }),
      }),
      Layer.mock(PullRequestService)({ summary }),
      Layer.mock(GitManager)({ branchPullRequest: branch }),
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

it.effect("disabled automatic settings do not even scan threads", () =>
  Effect.gen(function* () {
    const h = harness(fixture(), false);
    const reactor = yield* make.pipe(Effect.provide(h.layer));
    yield* reactor.requestSweep;
    yield* reactor.drain;
    expect(h.snapshot).not.toHaveBeenCalled();
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
