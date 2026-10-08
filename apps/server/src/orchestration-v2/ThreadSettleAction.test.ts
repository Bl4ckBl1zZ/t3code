import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ThreadSettleAction from "./ThreadSettleAction.ts";

const settledAt = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

const shell = (
  id: string,
  worktreePath: string | null,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project:settle-action"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    branch: null,
    worktreePath,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: settledAt,
    updatedAt: settledAt,
    archivedAt: null,
    settledOverride: "settled",
    settledAt,
    deletedAt: null,
    ...overrides,
  };
};

const makeHarness = Effect.fn("makeSettleActionHarness")(function* (options: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly existingWorktreePaths: ReadonlyArray<string>;
  /** Runs inside each worktree check, after the first thread read. */
  readonly onExists?: (path: string) => Effect.Effect<void>;
  /** Runs before each script start; a failure fails that start. */
  readonly onScriptRun?: (
    input: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<void>;
}) {
  const threads = yield* Ref.make(new Map(options.threads.map((thread) => [thread.id, thread])));
  const runs = yield* Ref.make<
    ReadonlyArray<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput>
  >([]);
  const layer = ThreadSettleAction.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStoreV2)({
          getThreadShell: (threadId) =>
            Ref.get(threads).pipe(Effect.map((current) => current.get(threadId) ?? null)),
        }),
        FileSystem.layerNoop({
          exists: (path) =>
            (options.onExists?.(path) ?? Effect.void).pipe(
              Effect.as(options.existingWorktreePaths.includes(path)),
            ),
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: (input) =>
            (options.onScriptRun?.(input) ?? Effect.void).pipe(
              Effect.andThen(Ref.update(runs, (current) => [...current, input])),
              Effect.as({ status: "no-script" } as const),
            ),
        }),
      ),
    ),
  );
  const updateThread = (id: ThreadId, patch: Partial<OrchestrationV2ThreadShell>) =>
    Ref.update(threads, (current) => {
      const next = new Map(current);
      const thread = next.get(id);
      if (thread) next.set(id, { ...thread, ...patch });
      return next;
    });
  return { layer, runs, updateThread };
});

it.effect("runs the settle action in the thread's own worktree", () =>
  Effect.gen(function* () {
    const shared = shell("shared-checkout-thread", null);
    const missing = shell("removed-worktree-thread", "/worktrees/removed");
    const worktree = shell("worktree-thread", "/worktrees/thread");
    const active = shell("active-thread", "/worktrees/active", { settledOverride: "active" });
    const fixture = yield* makeHarness({
      threads: [shared, missing, worktree, active],
      existingWorktreePaths: ["/worktrees/thread", "/worktrees/active"],
    });

    yield* Effect.gen(function* () {
      const action = yield* ThreadSettleAction.ThreadSettleActionRunner;
      yield* action.run(shared.id);
      yield* action.run(missing.id);
      yield* action.run(active.id);
      yield* action.run(worktree.id);
    }).pipe(Effect.provide(fixture.layer));

    const runs = yield* Ref.get(fixture.runs);
    assert.deepStrictEqual(
      runs.map((run) => ({
        threadId: run.threadId,
        worktreePath: run.worktreePath,
        trigger: run.trigger,
        observeCompletion: run.observeCompletion,
      })),
      [
        {
          threadId: worktree.id,
          worktreePath: "/worktrees/thread",
          trigger: "settle",
          observeCompletion: true,
        },
      ],
    );
  }),
);

it.effect("skips the settle action for a thread re-engaged during the worktree check", () =>
  Effect.gen(function* () {
    const thread = shell("reengaging-thread", "/worktrees/reengaging");
    let updateThread: (
      id: ThreadId,
      patch: Partial<OrchestrationV2ThreadShell>,
    ) => Effect.Effect<void> = () => Effect.void;
    const fixture = yield* makeHarness({
      threads: [thread],
      existingWorktreePaths: ["/worktrees/reengaging"],
      // The user sends a message while the worktree check waits on I/O.
      onExists: () => updateThread(thread.id, { settledOverride: "active", settledAt: null }),
    });
    updateThread = fixture.updateThread;

    yield* Effect.gen(function* () {
      const action = yield* ThreadSettleAction.ThreadSettleActionRunner;
      yield* action.run(thread.id);
    }).pipe(Effect.provide(fixture.layer));

    assert.lengthOf(yield* Ref.get(fixture.runs), 0);
  }),
);

it.effect("runs the settle action once per settlement", () =>
  Effect.gen(function* () {
    const thread = shell("repeated-thread", "/worktrees/repeated");
    const fixture = yield* makeHarness({
      threads: [thread],
      existingWorktreePaths: ["/worktrees/repeated"],
    });

    yield* Effect.gen(function* () {
      const action = yield* ThreadSettleAction.ThreadSettleActionRunner;
      // Settling an already settled thread keeps its settledAt.
      yield* action.run(thread.id);
      yield* action.run(thread.id);
      assert.lengthOf(yield* Ref.get(fixture.runs), 1);
      // Resumed and settled again: a new settlement runs the action again.
      yield* fixture.updateThread(thread.id, {
        settledAt: DateTime.add(settledAt, { hours: 1 }),
      });
      yield* action.run(thread.id);
      assert.lengthOf(yield* Ref.get(fixture.runs), 2);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("retries the settle action on the next settle after a failed start", () =>
  Effect.gen(function* () {
    const thread = shell("failed-start-thread", "/worktrees/failed-start");
    let starts = 0;
    const fixture = yield* makeHarness({
      threads: [thread],
      existingWorktreePaths: ["/worktrees/failed-start"],
      onScriptRun: () =>
        Effect.suspend(() => {
          starts += 1;
          return starts === 1 ? Effect.die(new Error("terminal failed to open")) : Effect.void;
        }),
    });

    yield* Effect.gen(function* () {
      const action = yield* ThreadSettleAction.ThreadSettleActionRunner;
      // A failed start is logged, not raised, so the settle effect still succeeds.
      yield* action.run(thread.id);
      yield* action.run(thread.id);
    }).pipe(Effect.provide(fixture.layer));

    assert.strictEqual(starts, 2);
    assert.lengthOf(yield* Ref.get(fixture.runs), 1);
  }),
);
