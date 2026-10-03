import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import { makeSingleLayer as makeSingleProviderAdapterRegistryLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
} satisfies ModelSelection;
// A composer whose options differ from the running run's (an explicit
// `fastMode: false`), as Claude's composer sends.
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
} satisfies ModelSelection;

// Claude steers live but cannot interrupt-and-restart, and applies a changed
// selection on its next turn.
const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const started: ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: true,
      supportsSteeringByInterruptRestart: false,
    },
  };
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
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
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
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
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = makeOrchestratorV2ReplayLayerWithRegistry(
    { name },
    makeSingleProviderAdapterRegistryLayer(adapter),
    { runEffectWorker: false },
  );
  // Creates the thread and starts its first turn on `runSelection`.
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return { started, steered, layer, startFirstTurn };
});

it.effect("steers a changed turn-scoped selection into a provider that cannot restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-change",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const steer = (id: string, selection: ModelSelection) =>
          orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(`message:${id}`),
              text: id,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.andThen(worker.drain()));

        yield* steer("steer-changed", composerSelection);
        const changed = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["steer-changed"]);
        assert.equal(started.length, 1);
        assert.lengthOf(changed.attempts, 1);
        assert.equal(changed.runs[0]?.status, "running");
        assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
        assert.deepEqual(changed.thread.modelSelection, composerSelection);

        // Choosing the running run's selection again replaces the saved choice.
        yield* steer("steer-reverted", runSelection);
        const reverted = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
        assert.lengthOf(reverted.attempts, 1);
        assert.deepEqual(reverted.thread.modelSelection, runSelection);

        // The saved choice moves to another instance while the run keeps going.
        // Steering with the run's selection brings the thread's instance back too.
        const otherSelection = {
          instanceId: ProviderInstanceId.make("codex-work"),
          model: "other",
        };
        const sink = yield* EventSinkV2;
        yield* sink.write({
          events: [
            {
              id: EventId.make("switched-away"),
              type: "thread.provider-switched",
              threadId,
              providerInstanceId: otherSelection.instanceId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...reverted.thread,
                providerInstanceId: otherSelection.instanceId,
                modelSelection: otherSelection,
              },
            },
          ],
        });
        yield* steer("steer-back", runSelection);
        const back = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
        assert.equal(back.thread.providerInstanceId, instanceId);
        assert.deepEqual(back.thread.modelSelection, runSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
