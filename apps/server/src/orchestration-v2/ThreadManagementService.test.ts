import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { OrchestratorProjectionError, OrchestratorV2 } from "./Orchestrator.ts";
import {
  existingThreadIdsForCommand,
  layer,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementProjectionLoadError,
  ThreadManagementRunNotFoundError,
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  withCreationProvenance,
} from "./ThreadManagementService.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
});

it("leaves commands that do not create durable authored content unchanged", () => {
  const command: OrchestrationV2Command = {
    type: "run.interrupt",
    commandId: CommandId.make("command:thread-management:interrupt"),
    threadId: ThreadId.make("thread:thread-management:interrupt"),
    runId: RunId.make("run:thread-management:interrupt"),
  };

  expect(
    withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toBe(command);
});

it("identifies every existing thread that must be hydrated before dispatch", () => {
  const sourceThreadId = ThreadId.make("thread:thread-management:source");
  const targetThreadId = ThreadId.make("thread:thread-management:target");
  const parentThreadId = ThreadId.make("thread:thread-management:parent");

  expect(
    existingThreadIdsForCommand({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:create"),
      threadId: targetThreadId,
      projectId: ProjectId.make("project:thread-management"),
      title: "Created thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.archive",
      commandId: CommandId.make("command:thread-management:archive"),
      threadId: targetThreadId,
    }),
  ).toEqual([targetThreadId]);

  // Read-state commands skip transcript hydration entirely: they fire on
  // every activity bump while a thread is open and never touch messages.
  expect(
    existingThreadIdsForCommand({
      type: "thread.visit",
      commandId: CommandId.make("command:thread-management:visit"),
      threadId: targetThreadId,
      visitedAt: "2026-07-30T00:00:00.000Z",
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.mark-unread",
      commandId: CommandId.make("command:thread-management:mark-unread"),
      threadId: targetThreadId,
    }),
  ).toEqual([]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.merge_back",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:merge"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId, targetThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "provider",
      commandId: CommandId.make("command:thread-management:delegate"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      task: "Inspect the migration",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  ).toEqual([parentThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("command:thread-management:wake-policy"),
      parentThreadId,
      taskId: NodeId.make("node:thread-management:delegated"),
      completionWake: "always",
    }),
  ).toEqual([parentThreadId]);

  expect(
    existingThreadIdsForCommand({
      type: "thread.created.record",
      commandId: CommandId.make("command:thread-management:record"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      targetThreadId,
      targetRunId: null,
    }),
  ).toEqual([parentThreadId, targetThreadId]);
});

it("derives thread management messages from structural error attributes", () => {
  const projectId = ProjectId.make("project:thread-management:errors");
  const threadId = ThreadId.make("thread:thread-management:errors");
  const runId = RunId.make("run:thread-management:errors");
  const messageId = MessageId.make("message:thread-management:errors");
  const infrastructureCause = new Error("private sqlite detail");

  const threadNotFound = new ThreadManagementThreadNotFoundError({
    projectId,
    threadId,
  });
  expect(threadNotFound).toMatchObject({ projectId, threadId });
  expect(threadNotFound.message).toBe(`Thread ${threadId} was not found in project ${projectId}.`);

  const runNotFound = new ThreadManagementRunNotFoundError({ threadId, runId });
  expect(runNotFound).toMatchObject({ threadId, runId });
  expect(runNotFound.message).toBe(`Run ${runId} does not belong to thread ${threadId}.`);

  const archived = new ThreadManagementThreadArchivedError({
    threadId,
  });
  expect(archived).toMatchObject({ threadId });
  expect(archived.message).toBe(`Thread ${threadId} is archived and cannot receive messages.`);

  const notSteerable = new ThreadManagementNoSteerableRunError({
    threadId,
    mode: "restart",
  });
  expect(notSteerable).toMatchObject({
    threadId,
    mode: "restart",
  });
  expect(notSteerable.message).toBe(
    `Thread ${threadId} has no running turn that can be restarted.`,
  );

  const notInterruptible = new ThreadManagementThreadNotInterruptibleError({
    threadId,
    runId,
  });
  expect(notInterruptible).toMatchObject({ threadId, runId });
  expect(notInterruptible.message).toBe(`Run ${runId} is not currently interruptible.`);

  const listFailure = new ThreadManagementProjectThreadsListError({
    projectId,
    cause: infrastructureCause,
  });
  expect(listFailure).toMatchObject({ projectId, cause: infrastructureCause });
  expect(listFailure.message).toBe(`Unable to list threads in project ${projectId}.`);
  expect(listFailure.message).not.toContain(infrastructureCause.message);

  const durableProjectionFailure = new ThreadManagementDurableRunProjectionError({
    threadId,
    messageId,
  });
  expect(durableProjectionFailure).toMatchObject({ threadId, messageId });
  expect(durableProjectionFailure.message).toBe(
    `Message ${messageId} was accepted on thread ${threadId} without a durable run projection.`,
  );
});

it.effect("classifies projection infrastructure failures separately from a missing thread", () => {
  const projectId = ProjectId.make("project:thread-management:projection-failure");
  const threadId = ThreadId.make("thread:thread-management:projection-failure");
  const infrastructureCause = new Error("sqlite read failed");
  const projectionError = new OrchestratorProjectionError({
    threadId,
    cause: infrastructureCause,
  });
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadProjection: () => Effect.fail(projectionError),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementProjectionLoadError);
    expect(error).toMatchObject({
      projectId,
      threadId,
      cause: projectionError,
    });
    expect(error.message).toBe(`Unable to load thread ${threadId} in project ${projectId}.`);
  }).pipe(Effect.provide(testLayer));
});

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(testLayer));
});

it.effect("interrupts a settled run whose background work still runs", () => {
  const projectId = ProjectId.make("project:thread-management:settled-stop");
  const threadId = ThreadId.make("thread:thread-management:settled-stop");
  const runId = RunId.make("run:thread-management:settled-stop");
  const providerThreadId = ProviderThreadId.make("provider-thread:thread-management:settled-stop");
  const now = DateTime.makeUnsafe("2026-09-27T00:00:00.000Z");
  const records = (background: boolean) =>
    ({
      thread: { id: threadId, projectId, deletedAt: null },
      runs: [{ id: runId, status: "completed", providerThreadId, ordinal: 1 }],
      providerTurns: [],
      providerThreads: [{ id: providerThreadId, driver: ProviderDriverKind.make("claudeAgent") }],
      subagents: [],
      turnItems: [
        {
          id: TurnItemId.make("turn-item:thread-management:settled-stop"),
          runId,
          type: "command_execution",
          status: background ? "running" : "completed",
          background: true,
          startedAt: now,
        },
      ],
    }) as unknown as OrchestrationV2ThreadProjection;
  let background = true;
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        getThreadRecords: () => Effect.succeed(records(background)),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length, storedEvents: [] };
          }),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService;
    const stopped = yield* service.interruptThread({
      projectId,
      commandId: CommandId.make("command:thread-management:settled-stop"),
      threadId,
    });
    expect(stopped.type).toBe("interrupt_requested");
    expect(dispatched).toMatchObject([{ type: "run.interrupt", threadId, runId }]);

    background = false;
    const explicit = yield* service.interruptThread({
      projectId,
      commandId: CommandId.make("command:thread-management:settled-stop-2"),
      threadId,
      runId,
    });
    expect(explicit.type).toBe("already_terminal");
    const implicit = yield* service.interruptThread({
      projectId,
      commandId: CommandId.make("command:thread-management:settled-stop-3"),
      threadId,
    });
    expect(implicit.type).toBe("no_active_run");
    expect(dispatched).toHaveLength(1);
  }).pipe(Effect.provide(testLayer));
});

it.effect("waitForThread reads the run again only when the run updates", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-event");
    const threadId = ThreadId.make("thread:thread-management:wait-event");
    const runId = RunId.make("run:thread-management:wait-event");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let status: OrchestrationV2Run["status"] = "running";
    let reads = 0;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mock(OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          // Only the run.updated stream carries events in this test.
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(() => {
              reads += 1;
              return {
                thread: { id: threadId, projectId, deletedAt: null },
                runs: [{ id: runId, status }],
              } as unknown as OrchestrationV2ThreadProjection;
            }),
        }),
      ),
    );
    const service = yield* ThreadManagementService.pipe(Effect.provide(testLayer));
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    status = "completed";
    yield* Queue.offer(events, stored(1, { type: "run.updated", payload: { id: "other-run" } }));
    yield* Queue.offer(events, stored(2, { type: "run.updated", payload: { id: runId, status } }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "completed" } });
    // The first read plus one for this run's update. The other run caused none.
    expect(reads).toBe(2);
  }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = layer.pipe(
      Layer.provide(
        Layer.mock(OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
    );
    const service = yield* ThreadManagementService.pipe(Effect.provide(layerTest));

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);
