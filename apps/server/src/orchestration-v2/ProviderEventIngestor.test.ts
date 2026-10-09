import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import {
  IdAllocatorV2,
  type IdAllocatorV2Error,
  layer as idAllocatorLayer,
} from "./IdAllocator.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import {
  type ProviderEventIngestInput,
  ProviderEventIngestorV2,
  layer as providerEventIngestorLayer,
  withPlanStepDurations,
} from "./ProviderEventIngestor.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";
import { layer as threadCommandExecutorLayer } from "./ThreadCommandExecutor.ts";

const TestDatabaseLayer = SqlitePersistenceMemory;
const TestStoresLayer = Layer.merge(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provide(TestDatabaseLayer),
);

const TestEventSinkLayer = eventSinkLayer.pipe(
  Layer.provide(Layer.mergeAll(TestStoresLayer, TestDatabaseLayer)),
);

const TestLayer = Layer.mergeAll(
  TestStoresLayer,
  TestEventSinkLayer,
  idAllocatorLayer,
  threadCommandExecutorLayer,
  providerEventIngestorLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        TestStoresLayer,
        TestEventSinkLayer,
        idAllocatorLayer,
        threadCommandExecutorLayer,
      ),
    ),
  ),
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<OrchestrationV2DomainEvent, IdAllocatorV2Error, IdAllocatorV2> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

function todoPlan(steps: TodoListPlan["steps"]): TodoListPlan {
  return {
    id: PlanId.make("plan:durations"),
    threadId: ThreadId.make("thread:durations"),
    runId: null,
    nodeId: NodeId.make("node:durations"),
    status: "active",
    kind: "todo_list",
    steps,
  };
}

const at = (iso: string) => DateTime.makeUnsafe(iso);

it("measures a step from when it started running until it completed", () => {
  const running = withPlanStepDurations(
    todoPlan([
      { id: "1", text: "Read", status: "running" },
      { id: "2", text: "Write", status: "pending" },
    ]),
    undefined,
    at("2026-08-29T00:00:00.000Z"),
  );
  assert.equal(running.steps[0]?.durationAnchorAt, "2026-08-29T00:00:00.000Z");
  assert.isUndefined(running.steps[0]?.durationMs);

  const completed = withPlanStepDurations(
    todoPlan([
      { id: "1", text: "Read", status: "completed" },
      { id: "2", text: "Write", status: "running" },
    ]),
    running,
    at("2026-08-29T00:00:03.000Z"),
  );
  assert.equal(completed.steps[0]?.durationMs, 3_000);
  assert.equal(completed.steps[1]?.durationAnchorAt, "2026-08-29T00:00:03.000Z");
});

it("keeps a finished step's measurement across later updates", () => {
  const first = withPlanStepDurations(
    todoPlan([{ id: "1", text: "Read", status: "running" }]),
    undefined,
    at("2026-08-29T00:00:00.000Z"),
  );
  const done = withPlanStepDurations(
    todoPlan([{ id: "1", text: "Read", status: "completed" }]),
    first,
    at("2026-08-29T00:00:05.000Z"),
  );
  const later = withPlanStepDurations(
    todoPlan([{ id: "1", text: "Read", status: "completed" }]),
    done,
    at("2026-08-29T00:09:00.000Z"),
  );
  assert.equal(later.steps[0]?.durationMs, 5_000);
});

it("refuses to inherit timing when a positional step id gets new text", () => {
  const first = withPlanStepDurations(
    todoPlan([{ id: "1", text: "Read", status: "running" }]),
    undefined,
    at("2026-08-29T00:00:00.000Z"),
  );
  const replaced = withPlanStepDurations(
    todoPlan([{ id: "1", text: "Something else entirely", status: "completed" }]),
    first,
    at("2026-08-29T00:05:00.000Z"),
  );
  assert.isUndefined(replaced.steps[0]?.durationMs);
});

it("gives the elapsed time to one step when several complete straight from pending", () => {
  const pending = withPlanStepDurations(
    todoPlan([
      { id: "1", text: "A", status: "pending" },
      { id: "2", text: "B", status: "pending" },
    ]),
    undefined,
    at("2026-08-29T00:00:00.000Z"),
  );
  const both = withPlanStepDurations(
    todoPlan([
      { id: "1", text: "A", status: "completed" },
      { id: "2", text: "B", status: "completed" },
    ]),
    pending,
    at("2026-08-29T00:00:04.000Z"),
  );
  assert.equal(both.steps[0]?.durationMs, 4_000);
  assert.isUndefined(both.steps[1]?.durationMs);
});

const layer = it.layer(TestLayer);

layer("ProviderEventIngestorV2", (it) => {
  it.effect("normalizes provider events through the real event log and projection store", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const eventStore = yield* EventStoreV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "native-thread",
        }),
        driver: CODEX_DRIVER,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        appThreadId: threadEvent.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CODEX_DRIVER,
          nativeId: "native-thread",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({ events: [threadEvent] });
      const storedEvents = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const storedDomainEvents = yield* eventStore.read({}).pipe(Stream.runCollect);
      const afterFirstEvent = yield* eventStore
        .read({ afterSequence: 1, threadId: threadEvent.threadId })
        .pipe(Stream.runCollect);
      const latestThreadSequence = yield* eventStore.latestSequence({
        threadId: threadEvent.threadId,
      });

      assert.equal(storedEvents.length, 1);
      assert.equal(storedEvents[0]?.event.type, "provider-thread.updated");
      assert.deepEqual(
        projection.providerThreads.map((thread) => thread.id),
        [providerThread.id],
      );
      assert.deepEqual(
        Array.from(storedDomainEvents).map((stored) => stored.event.type),
        ["thread.created", "provider-thread.updated"],
      );
      assert.deepEqual(
        Array.from(storedDomainEvents).map((stored) => stored.sequence),
        [1, 2],
      );
      assert.deepEqual(
        Array.from(afterFirstEvent).map((stored) => stored.event.type),
        ["provider-thread.updated"],
      );
      assert.equal(latestThreadSequence, 2);
    }),
  );

  it.effect(
    "treats successful provider terminal markers as non-persisted orchestration control signals",
    () =>
      Effect.gen(function* () {
        const ingestor = yield* ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocatorV2;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-event-terminal",
        });
        const threadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-event-terminal",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const normalized = yield* ingestor.normalize({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event: {
            type: "turn.terminal",
            driver: CODEX_DRIVER,
            providerThreadId: idAllocator.derive.providerThread({
              driver: CODEX_DRIVER,
              nativeThreadId: "native-thread",
            }),
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_DRIVER,
              nativeTurnId: "native-turn",
            }),
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          },
        });

        assert.deepEqual(normalized, []);
      }),
  );

  it.effect("rolls back runs a provider rewound off its active branch", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const threadId = threadEvent.threadId;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const rewoundThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "rewound-thread",
      });
      const otherThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "other-thread",
      });
      const scopeId = CheckpointScopeId.make("checkpoint-scope:rewound");
      // A run as execution leaves it: attempt, provider turn, root node, and a
      // checkpoint once completed. A null native turn id is a weak ref.
      const seedRun = Effect.fnUntraced(function* (input: {
        readonly ordinal: number;
        readonly providerThreadId: ProviderThreadId;
        readonly status: "completed" | "interrupted" | "running";
        readonly nativeTurnId: string | null;
      }) {
        const runId = RunId.make(`run:rewound:${input.ordinal}`);
        const attemptId = RunAttemptId.make(`attempt:rewound:${input.ordinal}`);
        const nodeId = NodeId.make(`node:rewound:${input.ordinal}`);
        const providerTurnId = ProviderTurnId.make(`provider-turn:rewound:${input.ordinal}`);
        const completedAt = input.status === "running" ? null : now;
        const eventId = () => idAllocator.allocate.event({ threadId });
        const events: Array<OrchestrationV2DomainEvent> = [
          {
            id: yield* eventId(),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: input.ordinal,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: input.providerThreadId,
              userMessageId: MessageId.make(`message:rewound:${input.ordinal}`),
              rootNodeId: nodeId,
              activeAttemptId: attemptId,
              status: input.status,
              requestedAt: now,
              startedAt: now,
              completedAt,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: yield* eventId(),
            type: "run-attempt.created",
            threadId,
            occurredAt: now,
            payload: {
              id: attemptId,
              runId,
              attemptOrdinal: 1,
              rootNodeId: nodeId,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              reason: "initial",
              status: input.status,
              startedAt: now,
              completedAt,
            },
          },
          {
            id: yield* eventId(),
            type: "provider-turn.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerTurnId,
              providerThreadId: input.providerThreadId,
              nodeId,
              runAttemptId: attemptId,
              nativeTurnRef:
                input.nativeTurnId === null
                  ? {
                      driver: CODEX_DRIVER,
                      nativeId: `synthetic:${input.ordinal}`,
                      strength: "weak",
                    }
                  : { driver: CODEX_DRIVER, nativeId: input.nativeTurnId, strength: "strong" },
              ordinal: input.ordinal,
              status: input.status,
              startedAt: now,
              completedAt,
            },
          },
          {
            id: yield* eventId(),
            type: "node.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "root_turn",
              status: input.status,
              countsForRun: true,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: scopeId,
              startedAt: now,
              completedAt,
            },
          },
          ...(input.status === "completed"
            ? [
                {
                  id: yield* eventId(),
                  type: "checkpoint.captured" as const,
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: CheckpointId.make(`checkpoint:rewound:${input.ordinal}`),
                    threadId,
                    scopeId,
                    runId,
                    nodeId,
                    parentCheckpointId: null,
                    ordinalWithinScope: input.ordinal,
                    appRunOrdinal: input.ordinal,
                    ref: CheckpointRef.make(`refs/t3/checkpoints/rewound/${input.ordinal}`),
                    status: "ready" as const,
                    files: [],
                    capturedAt: now,
                  },
                },
              ]
            : []),
        ];
        yield* eventSink.write({ events });
        return runId;
      });

      yield* eventSink.write({ events: [threadEvent] });
      const otherProviderRun = yield* seedRun({
        ordinal: 1,
        providerThreadId: otherThreadId,
        status: "completed",
        nativeTurnId: "other-turn",
      });
      const keptRun = yield* seedRun({
        ordinal: 2,
        providerThreadId: rewoundThreadId,
        status: "completed",
        nativeTurnId: "kept-turn",
      });
      const abandonedRun = yield* seedRun({
        ordinal: 3,
        providerThreadId: rewoundThreadId,
        status: "completed",
        nativeTurnId: "abandoned-turn",
      });
      const unlocatedRun = yield* seedRun({
        ordinal: 4,
        providerThreadId: rewoundThreadId,
        status: "interrupted",
        nativeTurnId: null,
      });
      const rewindingRun = yield* seedRun({
        ordinal: 5,
        providerThreadId: rewoundThreadId,
        status: "running",
        nativeTurnId: null,
      });

      yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId,
        runId: rewindingRun,
        event: {
          type: "provider_thread.updated",
          driver: CODEX_DRIVER,
          providerThread: {
            id: rewoundThreadId,
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: CODEX_DRIVER,
              nativeId: "rewound-thread",
              strength: "strong",
            },
            nativeConversationHeadRef: {
              driver: CODEX_DRIVER,
              nativeId: "kept-turn-reply",
              strength: "strong",
            },
            status: "idle",
            firstRunOrdinal: 2,
            lastRunOrdinal: 5,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
          retainedNativeTurnIds: ["turn-started-outside-t3", "kept-turn"],
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const runIds = [otherProviderRun, keptRun, abandonedRun, unlocatedRun, rewindingRun];
      assert.deepEqual(
        runIds.map((runId) => projection.runs.find((run) => run.id === runId)?.status),
        ["completed", "completed", "rolled_back", "rolled_back", "running"],
      );
      assert.deepEqual(
        runIds.map((runId) => projection.nodes.find((node) => node.runId === runId)?.status),
        ["completed", "completed", "rolled_back", "rolled_back", "running"],
      );
      assert.deepEqual(
        [otherProviderRun, keptRun, abandonedRun].map(
          (runId) =>
            projection.checkpoints.find((checkpoint) => checkpoint.runId === runId)?.status,
        ),
        ["ready", "ready", "stale"],
      );
      assert.equal(
        projection.providerThreads.find((thread) => thread.id === rewoundThreadId)?.lastRunOrdinal,
        5,
      );
    }),
  );

  it.effect("persists a failed provider terminal as one expected error item", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const retryStartedAt = DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 5_000);
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-thread-failed",
      });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-failed",
      });

      yield* eventSink.write({ events: [threadEvent] });
      const stored = yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId,
          providerTurnId,
          runOrdinal: 1,
          failureItemOrdinal: 102,
          status: "failed",
          failure: makeProviderFailure({
            message: "Invalid reasoning effort.",
            code: "invalid_request",
            class: "validation_error",
          }),
          retry: {
            attempt: 3,
            maxAttempts: 3,
            retryDelayMs: 2_000,
          },
          retryStartedAt,
          threadDisposition: "reusable",
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
      const errorItems = projection.visibleTurnItems.filter(
        (candidate) => candidate.item.type === "error",
      );

      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.event.type, "turn-item.updated");
      assert.equal(errorItems.length, 1);
      const errorItem = errorItems[0]?.item;
      assert.equal(errorItem?.type, "error");
      if (errorItem?.type !== "error") return;
      assert.equal(errorItem.failure.message, "Invalid reasoning effort.");
      assert.equal(errorItem.failure.code, "invalid_request");
      assert.deepEqual(errorItem.retry, {
        attempt: 3,
        maxAttempts: 3,
        retryDelayMs: 2_000,
      });
      const errorStartedAt = errorItem.startedAt;
      assert.ok(errorStartedAt);
      assert.equal(DateTime.toEpochMillis(errorStartedAt), DateTime.toEpochMillis(retryStartedAt));
      assert.equal(errorItem.providerThreadId, providerThreadId);
      assert.equal(errorItem.providerTurnId, providerTurnId);
    }),
  );

  it.effect("stores tool image bytes only where a tool-output-image asset serves them", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const eventStore = yield* EventStoreV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const readBase64 = Buffer.alloc(30_000, 7).toString("base64");
      const screenshotBase64 = Buffer.alloc(20_000, 9).toString("base64");
      const toolItem = (
        id: string,
        ordinal: number,
        toolName: string,
        output: unknown,
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: threadEvent.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: toolName,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool",
        toolName,
        input: {},
        output,
      });
      const read = toolItem("turn-item:read-image", 1, "Read", {
        type: "image",
        file: { base64: readBase64, type: "image/png", originalSize: 30_000 },
      });
      const screenshot = toolItem("turn-item:screenshot", 2, "mcp__t3-code__device_screenshot", {
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: screenshotBase64 },
          },
        ],
      });

      yield* eventSink.write({ events: [threadEvent] });
      for (const turnItem of [read, screenshot]) {
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
          event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem },
        });
      }

      const storedEvents = yield* eventStore
        .read({ threadId: threadEvent.threadId })
        .pipe(Stream.runCollect);
      const storedJson = JSON.stringify(
        Array.from(storedEvents, (stored) => stored.event).filter(
          (event) => event.type === "turn-item.updated",
        ),
      );
      const projectedRead = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: read.id,
      });
      const projectedScreenshot = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: screenshot.id,
      });

      assert.equal(storedJson.includes(readBase64), false);
      assert.equal(storedJson.includes(screenshotBase64), true);
      assert.deepEqual(projectedRead?.type === "dynamic_tool" ? projectedRead.output : null, {
        type: "image",
        file: { type: "image/png", originalSize: 30_000, sizeBytes: 30_000 },
      });
      assert.deepEqual(
        toolOutputImages(
          projectedScreenshot?.type === "dynamic_tool" ? projectedScreenshot.output : null,
        ),
        [{ mimeType: "image/png", data: screenshotBase64 }],
      );
    }),
  );

  it.effect("routes provider-owned child artifacts to their child app thread", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") {
        throw new Error("Expected a thread.created fixture event");
      }
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-subagent-thread",
      });
      const childRootNodeId = NodeId.make("node:subagent-root");
      const childThread: OrchestrationV2AppThread = {
        ...rootEvent.payload,
        id: childThreadId,
        title: "inspect package",
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: rootEvent.threadId,
          relationshipToParent: "subagent",
          rootThreadId: rootEvent.threadId,
        },
        forkedFrom: {
          type: "node",
          nodeId: NodeId.make("node:parent-subagent"),
        },
      };
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });

      const threadEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "app_thread.created",
          driver: CODEX_DRIVER,
          appThread: childThread,
        },
      });
      const messageEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "message.updated",
          driver: CODEX_DRIVER,
          message: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make("message:subagent-response"),
            threadId: childThreadId,
            runId: null,
            nodeId: childRootNodeId,
            role: "assistant",
            text: "Subagent result",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      assert.equal(threadEvents[0]?.type, "thread.created");
      assert.equal(threadEvents[0]?.threadId, childThreadId);
      assert.equal(messageEvents[0]?.type, "message.updated");
      assert.equal(messageEvents[0]?.threadId, childThreadId);
    }),
  );

  it.effect("moves a native subagent's thread to the model its provider reports later", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") {
        throw new Error("Expected a thread.created fixture event");
      }
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-late-model-subagent",
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });
      const ingest = (event: ProviderEventIngestInput["event"]) =>
        ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootEvent.threadId,
          event,
        });
      yield* eventSink.write({ events: [rootEvent] });
      // The subagent's thread starts on the parent's model and options.
      yield* ingest({
        type: "app_thread.created",
        driver: CODEX_DRIVER,
        appThread: {
          ...rootEvent.payload,
          id: childThreadId,
          title: "review design",
          modelSelection: {
            ...modelSelection,
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: rootEvent.threadId,
            relationshipToParent: "subagent",
            rootThreadId: rootEvent.threadId,
          },
        },
      });
      const subagentUpdated = {
        type: "subagent.updated",
        driver: CODEX_DRIVER,
        subagent: {
          id: NodeId.make("node:late-model-subagent"),
          threadId: rootEvent.threadId,
          runId: null,
          parentNodeId: NodeId.make("node:root"),
          origin: "provider_native",
          createdBy: "agent",
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Review the design",
          title: "review design",
          model: "gpt-6.1-sol",
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      } satisfies ProviderEventIngestInput["event"];

      const first = yield* ingest(subagentUpdated);
      const repeated = yield* ingest(subagentUpdated);
      const { thread: childThread } = yield* projectionStore.getThreadRecords(childThreadId, []);

      assert.deepEqual(
        first.map((stored) => [stored.event.type, stored.event.threadId]),
        [
          ["subagent.updated", rootEvent.threadId],
          ["thread.model-selection-updated", childThreadId],
        ],
      );
      assert.deepEqual(
        repeated.map((stored) => stored.event.type),
        ["subagent.updated"],
      );
      assert.deepEqual(childThread.modelSelection, {
        instanceId: modelSelection.instanceId,
        model: "gpt-6.1-sol",
      });
    }),
  );
});
