import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2InterruptInput,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

/**
 * A Codex-shaped adapter whose turns run until the test ends them. It reports
 * pending background work for every thread, so a settled Stop always reaches it,
 * and its interrupt reports nothing ending: what the thread still shows
 * afterwards is the settle follow-up's to end.
 */
const makeAdapter = Effect.fn("makeAdapter")(function* (cwd: string) {
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const started: ProviderAdapterV2TurnInput[] = [];
  const interrupts: ProviderAdapterV2InterruptInput[] = [];
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push(turn);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: (interrupt) =>
            Effect.sync(() => {
              interrupts.push(interrupt);
            }),
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  return { adapter, events, started, interrupts };
});

/** A settled run with its root node, attempt and provider turn, written as one batch. */
function settledRunEvents(input: {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly ordinal: number;
  readonly providerThreadId: ProviderThreadId;
  readonly now: DateTime.Utc;
}) {
  const { threadId, now } = input;
  const runId = RunId.make(`run:${input.key}:${input.ordinal}`);
  const attemptId = RunAttemptId.make(`attempt:${input.key}:${input.ordinal}`);
  const nodeId = NodeId.make(`node:${input.key}:${input.ordinal}`);
  const providerTurnId = ProviderTurnId.make(`provider-turn:${input.key}:${input.ordinal}`);
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${input.key}:run:${input.ordinal}`),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: input.ordinal,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: input.providerThreadId,
        userMessageId: MessageId.make(`message:${input.key}:${input.ordinal}`),
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      id: EventId.make(`${input.key}:node:${input.ordinal}`),
      type: "node.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "completed",
        countsForRun: true,
        providerThreadId: input.providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: now,
      },
    },
    {
      id: EventId.make(`${input.key}:attempt:${input.ordinal}`),
      type: "run-attempt.created",
      threadId,
      occurredAt: now,
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId: instanceId,
        providerThreadId: input.providerThreadId,
        providerTurnId,
        reason: "initial",
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    },
    {
      id: EventId.make(`${input.key}:provider-turn:${input.ordinal}`),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId: input.providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: null,
        ordinal: input.ordinal,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    },
  ];
  return { runId, nodeId, providerTurnId, events };
}

function backgroundCommandEvent(input: {
  readonly threadId: ThreadId;
  readonly id: TurnItemId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`item:${input.id}`),
    type: "turn-item.updated",
    threadId: input.threadId,
    runId: input.runId,
    occurredAt: input.now,
    payload: {
      id: input.id,
      threadId: input.threadId,
      runId: input.runId,
      nodeId: input.nodeId,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: input.ordinal,
      status: "running",
      title: null,
      startedAt: input.now,
      completedAt: null,
      updatedAt: input.now,
      type: "command_execution",
      input: `sleep ${input.ordinal}`,
      background: true,
    },
  };
}

// Stop's settle follow-up runs after the provider interrupt returns, possibly
// long after the Stop (retries) or again (an effect replayed after a crash).
// A later run's background work is not that Stop's to end.
it.effect("settles only the stopped run's background work, once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("background-work-settle");
      const { adapter } = yield* makeAdapter(cwd);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:settle-binding");
        const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-settle-binding"),
          threadId,
          projectId: ProjectId.make("project:settle-binding"),
          title: "Settle binding",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const runs = [1, 2].map((ordinal) =>
          settledRunEvents({ threadId, key: "settle-binding", ordinal, providerThreadId, now }),
        );
        const commandItem = (ordinal: number) =>
          TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
        yield* sink.write({
          events: [
            {
              id: EventId.make("settle-binding:provider-thread"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerThreadId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: 1,
                lastRunOrdinal: 2,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            ...runs.flatMap((run, index) => [
              ...run.events,
              backgroundCommandEvent({
                threadId,
                id: commandItem(index + 1),
                runId: run.runId,
                nodeId: run.nodeId,
                providerThreadId,
                providerTurnId: run.providerTurnId,
                ordinal: (index + 1) * 10,
                now,
              }),
            ]),
          ],
        });
        const itemStatuses = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
          projection.turnItems
            .flatMap((item) =>
              item.type === "command_execution" ? [`${item.id}:${item.status}`] : [],
            )
            .toSorted(),
        );
        // The settle that followed a Stop of run 1's turn, dispatched only after
        // run 2 had settled with work of its own.
        const settle = {
          type: "thread.background-work.settle",
          commandId: CommandId.make("stop-run-1:background-work-settled"),
          threadId,
          providerThreadId,
          providerTurnId: runs[0]!.providerTurnId,
        } as const;
        yield* orchestrator.dispatch(settle);
        assert.deepEqual(yield* itemStatuses, [
          `${commandItem(1)}:interrupted`,
          `${commandItem(2)}:running`,
        ]);

        // A settle that found nothing to end replays as a no-op, even after
        // work it would match appears: its receipt is recorded with no events.
        const emptySettle = {
          ...settle,
          commandId: CommandId.make("stop-run-1-again:background-work-settled"),
        };
        const first = yield* orchestrator.dispatch(emptySettle);
        assert.lengthOf(first.storedEvents, 0);
        yield* sink.write({
          events: [
            backgroundCommandEvent({
              threadId,
              id: commandItem(3),
              runId: runs[0]!.runId,
              nodeId: runs[0]!.nodeId,
              providerThreadId,
              providerTurnId: runs[0]!.providerTurnId,
              ordinal: 30,
              now,
            }),
          ],
        });
        const replayed = yield* orchestrator.dispatch(emptySettle);
        assert.lengthOf(replayed.storedEvents, 0);
        assert.deepEqual(yield* itemStatuses, [
          `${commandItem(1)}:interrupted`,
          `${commandItem(2)}:running`,
          `${commandItem(3)}:running`,
        ]);
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "background-work-settle" },
            ProviderAdapterRegistry.makeSingleLayer(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);

// Codex turns leave commands and a native subagent running, then the thread
// moves to another provider thread (a provider switch). Stop on the newer,
// settled run must reach both provider threads and end all of the Codex work.
it.effect("Stop reaches background work an earlier provider thread still runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("background-work-stop");
      const { adapter, events, started, interrupts } = yield* makeAdapter(cwd);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:background-work-stop");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:background-work-stop"),
          title: "Background work stop",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-dev-server"),
          threadId,
          messageId: MessageId.make("message:start-dev-server"),
          text: "Start the dev server",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const codexTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const devServerId = TurnItemId.make("turn-item:dev-server");
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            backgroundCommandEvent({
              threadId,
              id: devServerId,
              runId: first.runId,
              nodeId: first.rootNodeId,
              providerThreadId: codexTurn.providerThreadId,
              providerTurnId: codexTurn.id,
              ordinal: 100,
              now,
            }),
          ],
        });
        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...codexTurn, status: "completed", completedAt: now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: codexTurn.providerThreadId,
          providerTurnId: codexTurn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const codexProviderThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        // A later Codex run leaves a second command, the next a native
        // subagent. Then the thread moves on to another provider thread, which
        // also has a live session.
        const watcherId = TurnItemId.make("turn-item:watcher");
        const watcherRun = settledRunEvents({
          threadId,
          key: "background-work-stop",
          ordinal: 2,
          providerThreadId: codexProviderThread.id,
          now,
        });
        const reviewerId = TurnItemId.make("turn-item:reviewer");
        const reviewerSubagentId = NodeId.make("subagent:reviewer");
        const reviewerRun = settledRunEvents({
          threadId,
          key: "background-work-stop",
          ordinal: 3,
          providerThreadId: codexProviderThread.id,
          now,
        });
        // A native subagent item names its own provider thread but its
        // parent's provider turn.
        const subagentProviderThreadId = ProviderThreadId.make("provider-thread:codex-subagent");
        const otherProviderThreadId = ProviderThreadId.make("provider-thread:other");
        const latestRun = settledRunEvents({
          threadId,
          key: "background-work-stop",
          ordinal: 4,
          providerThreadId: otherProviderThreadId,
          now,
        });
        yield* sink.write({
          events: [
            ...watcherRun.events,
            backgroundCommandEvent({
              threadId,
              id: watcherId,
              runId: watcherRun.runId,
              nodeId: watcherRun.nodeId,
              providerThreadId: codexProviderThread.id,
              providerTurnId: watcherRun.providerTurnId,
              ordinal: 200,
              now,
            }),
            ...reviewerRun.events,
            {
              id: EventId.make("subagent:reviewer"),
              type: "subagent.updated",
              threadId,
              runId: reviewerRun.runId,
              nodeId: reviewerSubagentId,
              occurredAt: now,
              payload: {
                id: reviewerSubagentId,
                threadId,
                runId: reviewerRun.runId,
                parentNodeId: reviewerRun.nodeId,
                origin: "provider_native",
                createdBy: "agent",
                driver,
                providerInstanceId: instanceId,
                providerThreadId: subagentProviderThreadId,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "Review the change",
                title: "Review the change",
                model: null,
                status: "running",
                result: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("item:reviewer"),
              type: "turn-item.updated",
              threadId,
              runId: reviewerRun.runId,
              occurredAt: now,
              payload: {
                id: reviewerId,
                threadId,
                runId: reviewerRun.runId,
                nodeId: reviewerRun.nodeId,
                providerThreadId: subagentProviderThreadId,
                providerTurnId: reviewerRun.providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 300,
                status: "running",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "subagent",
                subagentId: reviewerSubagentId,
                origin: "provider_native",
                driver,
                providerInstanceId: instanceId,
                childThreadId: null,
                prompt: "Review the change",
                result: null,
              },
            },
            {
              id: EventId.make("provider-thread:other"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...codexProviderThread,
                id: otherProviderThreadId,
                firstRunOrdinal: 4,
                lastRunOrdinal: 4,
              },
            },
            ...latestRun.events,
          ],
        });

        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop-background-work"),
          threadId,
          runId: latestRun.runId,
        });
        yield* worker.drain();

        // Stop reaches both provider threads. The Codex one is interrupted at
        // its latest pending work, the subagent's parent turn, so its settle
        // covers all three Codex runs.
        assert.sameDeepMembers(
          interrupts.map((interrupt) => [interrupt.providerThread.id, interrupt.providerTurnId]),
          [
            [otherProviderThreadId, latestRun.providerTurnId],
            [codexProviderThread.id, reviewerRun.providerTurnId],
          ],
        );
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          [devServerId, watcherId, reviewerId].map(
            (id) => after.turnItems.find((item) => item.id === id)?.status,
          ),
          ["interrupted", "interrupted", "interrupted"],
        );
        // The subagent row ends with its item, so the thread stops counting it.
        assert.equal(
          after.subagents.find((subagent) => subagent.id === reviewerSubagentId)?.status,
          "interrupted",
        );
        const shell = yield* orchestrator.getThreadShell(threadId);
        assert.deepEqual(shell?.pendingBackgroundTasks, []);
        assert.equal(shell?.backgroundProcessCount, 0);
        assert.equal(shell?.activeAgentCount, 0);
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "background-work-stop" },
            ProviderAdapterRegistry.makeSingleLayer(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);
