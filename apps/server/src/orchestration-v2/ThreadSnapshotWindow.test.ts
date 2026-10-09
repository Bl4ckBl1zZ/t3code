// @effect-diagnostics nodeBuiltinImport:off - node:sqlite holds a competing write lock; node:fs/os/path make its temp database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadHistoryOrigin,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserMessageInputIntent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { windowOrchestrationV2ThreadProjection } from "@t3tools/shared/orchestrationV2Window";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";

import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import {
  clearPlannerStatistics,
  loadProductionPlannerStatistics,
} from "../persistence/productionPlannerStatistics.testkit.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { projectThreadProjectionForWire, threadSnapshotForWire } from "./WireProjection.ts";

const TestLayer = Layer.mergeAll(
  projectionStoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:window");
const at = (seconds: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, seconds));

// Wire bytes, so "equal" means what every client decodes is identical.
const encodeProjection = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ThreadProjection));
const decodeProjectionJson = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadProjection),
);

let eventCounter = 0;
const nextEventId = () => EventId.make(`event:window:${++eventCounter}`);

const createThread = (
  threadId: ThreadId,
  options: {
    readonly forkedFrom?: { readonly threadId: ThreadId; readonly runId: RunId };
    readonly historyOrigin?: OrchestrationV2ThreadHistoryOrigin;
  } = {},
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    yield* store.apply({
      id: nextEventId(),
      type: "thread.created",
      threadId,
      occurredAt: at(0),
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:window"),
        title: `Window ${threadId}`,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: options.forkedFrom?.threadId ?? null,
          relationshipToParent: options.forkedFrom === undefined ? null : "fork",
          rootThreadId: options.forkedFrom?.threadId ?? threadId,
        },
        forkedFrom:
          options.forkedFrom === undefined
            ? null
            : {
                type: "run",
                threadId: options.forkedFrom.threadId,
                runId: options.forkedFrom.runId,
              },
        ...(options.historyOrigin === undefined ? {} : { historyOrigin: options.historyOrigin }),
        createdAt: at(0),
        updatedAt: at(0),
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  });

const runIdFor = (threadId: ThreadId, ordinal: number) => RunId.make(`run:${threadId}:${ordinal}`);
const rootNodeFor = (threadId: ThreadId, ordinal: number, attempt = 1) =>
  NodeId.make(`node:${threadId}:${ordinal}:root:${attempt}`);

const createRun = (
  threadId: ThreadId,
  ordinal: number,
  status: "completed" | "rolled_back" | "cancelled" | "running" | "queued" = "completed",
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const runId = runIdFor(threadId, ordinal);
    const rootNodeId = rootNodeFor(threadId, ordinal);
    yield* store.apply({
      id: nextEventId(),
      type: "run.created",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: at(ordinal),
      payload: {
        id: runId,
        threadId,
        ordinal,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:${threadId}:${ordinal}:user`),
        rootNodeId,
        activeAttemptId: null,
        status,
        requestedAt: at(ordinal),
        startedAt: at(ordinal),
        completedAt: status === "running" || status === "queued" ? null : at(ordinal),
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* store.apply({
      id: nextEventId(),
      type: "node.updated",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: at(ordinal),
      payload: {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "completed",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: at(ordinal),
        completedAt: at(ordinal),
      },
    });
    return runId;
  });

const createAttempt = (
  threadId: ThreadId,
  runOrdinal: number,
  attemptOrdinal: number,
  status: "completed" | "superseded",
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const runId = runIdFor(threadId, runOrdinal);
    yield* store.apply({
      id: nextEventId(),
      type: "run-attempt.created",
      threadId,
      runId,
      driver,
      occurredAt: at(runOrdinal),
      payload: {
        id: RunAttemptId.make(`attempt:${threadId}:${runOrdinal}:${attemptOrdinal}`),
        runId,
        attemptOrdinal,
        rootNodeId: rootNodeFor(threadId, runOrdinal, attemptOrdinal),
        providerInstanceId: modelSelection.instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: attemptOrdinal === 1 ? "initial" : "steering_restart",
        status,
        startedAt: at(runOrdinal),
        completedAt: at(runOrdinal),
      },
    });
  });

type ItemSpec =
  | {
      readonly type: "user_message";
      readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
    }
  | { readonly type: "assistant_message" }
  | { readonly type: "command_execution"; readonly output?: string }
  | { readonly type: "run_interrupt_request" }
  | { readonly type: "run_interrupt_result"; readonly attemptOrdinal: number };

const addItem = (input: {
  readonly threadId: ThreadId;
  readonly runOrdinal: number | null;
  readonly ordinal: number;
  readonly spec: ItemSpec;
}) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const { threadId, spec } = input;
    const runId = input.runOrdinal === null ? null : runIdFor(threadId, input.runOrdinal);
    const id = TurnItemId.make(`turn-item:${threadId}:${input.ordinal}`);
    const messageId = MessageId.make(`message:${threadId}:item:${input.ordinal}`);
    const base = {
      id,
      threadId,
      runId,
      nodeId:
        input.runOrdinal === null
          ? null
          : spec.type === "run_interrupt_result"
            ? rootNodeFor(threadId, input.runOrdinal, spec.attemptOrdinal)
            : rootNodeFor(threadId, input.runOrdinal),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: input.ordinal,
      status: "completed",
      title: null,
      startedAt: at(input.ordinal % 60),
      completedAt: at(input.ordinal % 60),
      updatedAt: at(input.ordinal % 60),
    } as const;
    const item: OrchestrationV2TurnItem =
      spec.type === "user_message"
        ? {
            ...base,
            createdBy: "user",
            creationSource: "web",
            type: "user_message",
            messageId,
            inputIntent: spec.inputIntent ?? "turn_start",
            text: `user ${input.ordinal}`,
            attachments: [],
          }
        : spec.type === "assistant_message"
          ? {
              ...base,
              type: "assistant_message",
              messageId,
              text: `assistant ${input.ordinal}`,
              streaming: false,
            }
          : spec.type === "command_execution"
            ? {
                ...base,
                type: "command_execution",
                input: `echo ${input.ordinal}`,
                output: spec.output ?? `${input.ordinal}`,
              }
            : { ...base, type: spec.type, message: `${spec.type} ${input.ordinal}` };
    yield* store.apply({
      id: nextEventId(),
      type: "turn-item.updated",
      threadId,
      ...(runId === null ? {} : { runId }),
      driver,
      occurredAt: at(input.ordinal % 60),
      payload: item,
    });
    if (spec.type === "user_message" || spec.type === "assistant_message") {
      yield* store.apply({
        id: nextEventId(),
        type: "message.updated",
        threadId,
        ...(runId === null ? {} : { runId }),
        driver,
        occurredAt: at(input.ordinal % 60),
        payload: {
          createdBy: spec.type === "user_message" ? "user" : "agent",
          creationSource: "web",
          id: messageId,
          threadId,
          runId,
          nodeId: null,
          role: spec.type === "user_message" ? "user" : "assistant",
          text: `${spec.type} ${input.ordinal}`,
          attachments: [],
          streaming: false,
          // Reverse creation order, so only turn-item order puts messages in place.
          createdAt: at(59 - (input.ordinal % 60)),
          updatedAt: at(59 - (input.ordinal % 60)),
        },
      });
    }
  });

/** A run with a user prompt, `tools` commands, and an answer, at ordinals `start..`. */
const addTurn = (input: {
  readonly threadId: ThreadId;
  readonly runOrdinal: number;
  readonly start: number;
  readonly tools?: number;
  readonly output?: string;
}) =>
  Effect.gen(function* () {
    let ordinal = input.start;
    yield* addItem({
      threadId: input.threadId,
      runOrdinal: input.runOrdinal,
      ordinal: ordinal++,
      spec: { type: "user_message", inputIntent: "turn_start" },
    });
    for (let tool = 0; tool < (input.tools ?? 1); tool++) {
      yield* addItem({
        threadId: input.threadId,
        runOrdinal: input.runOrdinal,
        ordinal: ordinal++,
        spec: {
          type: "command_execution",
          ...(input.output === undefined ? {} : { output: input.output }),
        },
      });
    }
    yield* addItem({
      threadId: input.threadId,
      runOrdinal: input.runOrdinal,
      ordinal: ordinal++,
      spec: { type: "assistant_message" },
    });
    return ordinal;
  });

/**
 * The full snapshot and every window size around the history, compared on the
 * wire against the full projection read and the in-memory window over it.
 */
const assertWindowsMatchInMemoryWindow = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const projection = yield* store.getThreadProjection(threadId);
    const full = yield* store.getThreadSnapshot(threadId);
    assert.strictEqual(encodeProjection(full.projection), encodeProjection(projection));
    const total = projection.visibleTurnItems.length;
    let truncatedWindows = 0;
    for (let maxVisibleItems = 1; maxVisibleItems <= total + 1; maxVisibleItems++) {
      const windowed = yield* store.getThreadSnapshot(threadId, { maxVisibleItems });
      const expected = windowOrchestrationV2ThreadProjection(projection, maxVisibleItems);
      assert.strictEqual(
        encodeProjection(windowed.projection),
        encodeProjection(expected),
        `window of ${maxVisibleItems} over ${total} visible items`,
      );
      assert.strictEqual(windowed.snapshotSequence, full.snapshotSequence);
      if (expected.truncatedVisibleItemCount !== undefined) truncatedWindows += 1;
    }
    return { total, truncatedWindows };
  });

const corruptPayload = (table: string, idColumn: string, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`UPDATE ${table} SET payload_json = 'not json' WHERE ${idColumn} = ?`, [id]);
  });

it.layer(TestLayer)("windowed thread snapshots", (it) => {
  it.effect("match the in-memory window for a short thread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:window:short");
      yield* createThread(threadId);
      yield* createRun(threadId, 1);
      yield* addTurn({ threadId, runOrdinal: 1, start: 1 });
      yield* createRun(threadId, 2);
      yield* addTurn({ threadId, runOrdinal: 2, start: 10 });

      const { total, truncatedWindows } = yield* assertWindowsMatchInMemoryWindow(threadId);
      assert.strictEqual(total, 6);
      assert.isAbove(truncatedWindows, 0);
      const wide = yield* (yield* ProjectionStoreV2).getThreadSnapshot(threadId, {
        maxVisibleItems: 100,
      });
      assert.isUndefined(wide.projection.truncatedVisibleItemCount);
    }),
  );

  it.effect("never split a run longer than the window", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:window:long-run");
      yield* createThread(threadId);
      yield* createRun(threadId, 1);
      yield* addTurn({ threadId, runOrdinal: 1, start: 1 });
      yield* createRun(threadId, 2, "running");
      yield* addTurn({ threadId, runOrdinal: 2, start: 10, tools: 20 });

      yield* assertWindowsMatchInMemoryWindow(threadId);
      const store = yield* ProjectionStoreV2;
      const windowed = yield* store.getThreadSnapshot(threadId, { maxVisibleItems: 5 });
      // The whole 22-item run, nothing of run 1.
      assert.strictEqual(windowed.projection.visibleTurnItems.length, 22);
      assert.strictEqual(windowed.projection.truncatedVisibleItemCount, 3);
      assert.deepEqual(
        windowed.projection.visibleTurnItems.map((row) => row.position),
        Array.from({ length: 22 }, (_, index) => index),
      );
    }),
  );

  it.effect("match the in-memory window across hidden rows, runless rows, and old requests", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const threadId = ThreadId.make("thread:window:mixed");
      yield* createThread(threadId);

      // Run 1 is old, and its approval is still pending.
      yield* createRun(threadId, 1);
      yield* addTurn({ threadId, runOrdinal: 1, start: 1 });
      const pendingRequestId = RuntimeRequestId.make("request:window:mixed:pending");
      yield* store.apply({
        id: nextEventId(),
        type: "runtime-request.updated",
        threadId,
        runId: runIdFor(threadId, 1),
        driver,
        occurredAt: at(1),
        payload: {
          id: pendingRequestId,
          nodeId: rootNodeFor(threadId, 1),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: at(1),
          resolvedAt: null,
        },
      });
      const checkpointId = CheckpointId.make("checkpoint:window:mixed:1");
      yield* store.apply({
        id: nextEventId(),
        type: "checkpoint.captured",
        threadId,
        runId: runIdFor(threadId, 1),
        driver,
        occurredAt: at(1),
        payload: {
          id: checkpointId,
          threadId,
          scopeId: CheckpointScopeId.make("scope:window:mixed"),
          runId: runIdFor(threadId, 1),
          nodeId: rootNodeFor(threadId, 1),
          parentCheckpointId: null,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/checkpoints/window/1"),
          status: "ready",
          files: [],
          capturedAt: at(1),
        },
      });
      // A runless notice and message sit between runs.
      yield* addItem({ threadId, runOrdinal: null, ordinal: 5, spec: { type: "user_message" } });
      // Run 2 was rolled back, so none of its items are visible.
      yield* createRun(threadId, 2, "rolled_back");
      yield* addTurn({ threadId, runOrdinal: 2, start: 10 });
      // Run 3 was a queued message that was cancelled before it ran.
      yield* createRun(threadId, 3, "cancelled");
      yield* addItem({
        threadId,
        runOrdinal: 3,
        ordinal: 20,
        spec: { type: "user_message", inputIntent: "queued_turn" },
      });
      // Run 4 was steered: its plain-steer interrupt result stays hidden.
      yield* createRun(threadId, 4);
      yield* createAttempt(threadId, 4, 1, "superseded");
      yield* createAttempt(threadId, 4, 2, "completed");
      yield* addItem({
        threadId,
        runOrdinal: 4,
        ordinal: 30,
        spec: { type: "user_message", inputIntent: "turn_start" },
      });
      yield* addItem({
        threadId,
        runOrdinal: 4,
        ordinal: 31,
        spec: { type: "run_interrupt_result", attemptOrdinal: 1 },
      });
      yield* addItem({ threadId, runOrdinal: 4, ordinal: 32, spec: { type: "assistant_message" } });
      // Run 5 was stopped then steered: its request and result pair stay visible.
      yield* createRun(threadId, 5);
      yield* createAttempt(threadId, 5, 1, "superseded");
      yield* createAttempt(threadId, 5, 2, "completed");
      yield* addItem({
        threadId,
        runOrdinal: 5,
        ordinal: 40,
        spec: { type: "user_message", inputIntent: "turn_start" },
      });
      yield* addItem({
        threadId,
        runOrdinal: 5,
        ordinal: 41,
        spec: { type: "run_interrupt_request" },
      });
      yield* addItem({
        threadId,
        runOrdinal: 5,
        ordinal: 42,
        spec: { type: "run_interrupt_result", attemptOrdinal: 1 },
      });
      yield* addItem({ threadId, runOrdinal: 5, ordinal: 43, spec: { type: "assistant_message" } });
      yield* addItem({
        threadId,
        runOrdinal: null,
        ordinal: 44,
        spec: { type: "command_execution" },
      });
      yield* createRun(threadId, 6);
      yield* addTurn({ threadId, runOrdinal: 6, start: 50, tools: 3 });

      const { total } = yield* assertWindowsMatchInMemoryWindow(threadId);
      assert.strictEqual(total, 16);

      const windowed = yield* store.getThreadSnapshot(threadId, { maxVisibleItems: 4 });
      // Run 6 is five rows, and the window never splits it.
      assert.strictEqual(windowed.projection.truncatedVisibleItemCount, 11);
      // Entity arrays stay whole: an old pending question and every checkpoint.
      assert.isTrue(
        windowed.projection.runtimeRequests.some((request) => request.id === pendingRequestId),
      );
      assert.isTrue(
        windowed.projection.checkpoints.some((checkpoint) => checkpoint.id === checkpointId),
      );
      assert.strictEqual(windowed.projection.runs.length, 6);
      assert.strictEqual(windowed.projection.nodes.length, 6);
    }),
  );

  it.effect("match the in-memory window for forks of forks", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:window:fork-source");
      const forkId = ThreadId.make("thread:window:fork");
      const nestedId = ThreadId.make("thread:window:fork-nested");
      yield* createThread(sourceId);
      for (let ordinal = 1; ordinal <= 4; ordinal++) {
        yield* createRun(sourceId, ordinal, ordinal === 4 ? "rolled_back" : "completed");
        yield* addTurn({ threadId: sourceId, runOrdinal: ordinal, start: ordinal * 10 });
      }
      yield* createRun(sourceId, 5);
      yield* createAttempt(sourceId, 5, 1, "superseded");
      yield* addItem({
        threadId: sourceId,
        runOrdinal: 5,
        ordinal: 50,
        spec: { type: "run_interrupt_result", attemptOrdinal: 1 },
      });

      yield* createThread(forkId, {
        forkedFrom: { threadId: sourceId, runId: runIdFor(sourceId, 5) },
      });
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        yield* createRun(forkId, ordinal);
        yield* addTurn({ threadId: forkId, runOrdinal: ordinal, start: ordinal * 10 });
      }
      yield* createThread(nestedId, {
        forkedFrom: { threadId: forkId, runId: runIdFor(forkId, 2) },
      });
      yield* createRun(nestedId, 1);
      yield* addTurn({ threadId: nestedId, runOrdinal: 1, start: 10, tools: 2 });

      const fork = yield* assertWindowsMatchInMemoryWindow(forkId);
      // 12 inherited (a rolled-back source run stays inherited), the marker, 9 local.
      assert.strictEqual(fork.total, 22);
      const nested = yield* assertWindowsMatchInMemoryWindow(nestedId);
      // The fork's 13 inherited rows and marker, 6 of its own, a marker, 4 local.
      assert.strictEqual(nested.total, 24);
    }),
  );

  it.effect("match the in-memory window for forks of imported runless history", () =>
    Effect.gen(function* () {
      const sourceId = ThreadId.make("thread:window:imported-source");
      const forkId = ThreadId.make("thread:window:imported-fork");
      yield* createThread(sourceId, { historyOrigin: "v1_import" });
      for (let ordinal = 1; ordinal <= 6; ordinal++) {
        yield* addItem({
          threadId: sourceId,
          runOrdinal: null,
          ordinal,
          spec: { type: ordinal % 2 === 1 ? "user_message" : "assistant_message" },
        });
      }
      yield* createRun(sourceId, 1);
      yield* addTurn({ threadId: sourceId, runOrdinal: 1, start: 10 });
      yield* createThread(forkId, {
        forkedFrom: { threadId: sourceId, runId: runIdFor(sourceId, 1) },
      });
      yield* createRun(forkId, 1);
      yield* addTurn({ threadId: forkId, runOrdinal: 1, start: 10 });

      yield* assertWindowsMatchInMemoryWindow(sourceId);
      const fork = yield* assertWindowsMatchInMemoryWindow(forkId);
      assert.strictEqual(fork.total, 13);
    }),
  );

  it.effect("never read the payloads a window drops, here or in a fork source", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const sourceId = ThreadId.make("thread:window:unread-source");
      const forkId = ThreadId.make("thread:window:unread-fork");
      yield* createThread(sourceId);
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        yield* createRun(sourceId, ordinal);
        yield* addTurn({ threadId: sourceId, runOrdinal: ordinal, start: ordinal * 10 });
      }
      yield* createThread(forkId, {
        forkedFrom: { threadId: sourceId, runId: runIdFor(sourceId, 3) },
      });
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        yield* createRun(forkId, ordinal);
        yield* addTurn({ threadId: forkId, runOrdinal: ordinal, start: ordinal * 10 });
      }
      const before = yield* store.getThreadSnapshot(forkId, { maxVisibleItems: 3 });

      // Dropped rows that a windowed read must not even look at.
      yield* corruptPayload(
        "orchestration_v2_projection_turn_items",
        "turn_item_id",
        `turn-item:${forkId}:11`,
      );
      yield* corruptPayload(
        "orchestration_v2_projection_messages",
        "message_id",
        `message:${forkId}:item:10`,
      );
      for (const ordinal of [11, 21, 31]) {
        yield* corruptPayload(
          "orchestration_v2_projection_turn_items",
          "turn_item_id",
          `turn-item:${sourceId}:${ordinal}`,
        );
      }
      for (const ordinal of [1, 2, 3]) {
        yield* corruptPayload(
          "orchestration_v2_projection_nodes",
          "node_id",
          rootNodeFor(sourceId, ordinal),
        );
      }

      const after = yield* store.getThreadSnapshot(forkId, { maxVisibleItems: 3 });
      assert.strictEqual(encodeProjection(after.projection), encodeProjection(before.projection));
      // A full projection read decodes everything, so the corruption is real.
      const fullExit = yield* Effect.exit(store.getThreadProjection(forkId));
      assert.strictEqual(fullExit._tag, "Failure");
    }),
  );

  it.effect("read only what a full fork snapshot inherits from its source", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const sourceId = ThreadId.make("thread:window:full-fork-source");
      const forkId = ThreadId.make("thread:window:full-fork");
      yield* createThread(sourceId);
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        yield* createRun(sourceId, ordinal);
        yield* addTurn({ threadId: sourceId, runOrdinal: ordinal, start: ordinal * 10 });
      }
      yield* createThread(forkId, {
        forkedFrom: { threadId: sourceId, runId: runIdFor(sourceId, 2) },
      });
      yield* createRun(forkId, 1);
      yield* addTurn({ threadId: forkId, runOrdinal: 1, start: 10 });
      const before = yield* store.getThreadSnapshot(forkId);

      // The source's later run, its messages, and its nodes are not the fork's history.
      yield* corruptPayload(
        "orchestration_v2_projection_turn_items",
        "turn_item_id",
        `turn-item:${sourceId}:31`,
      );
      yield* corruptPayload(
        "orchestration_v2_projection_messages",
        "message_id",
        `message:${sourceId}:item:10`,
      );
      yield* corruptPayload(
        "orchestration_v2_projection_nodes",
        "node_id",
        rootNodeFor(sourceId, 1),
      );

      const after = yield* store.getThreadSnapshot(forkId);
      assert.strictEqual(encodeProjection(after.projection), encodeProjection(before.projection));
      assert.strictEqual(after.projection.visibleTurnItems.length, 10);
    }),
  );

  it.effect("send compact turnItems only to opted-in clients, restorable byte for byte", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const sourceId = ThreadId.make("thread:window:compact-source");
      const forkId = ThreadId.make("thread:window:compact-fork");
      yield* createThread(sourceId);
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        yield* createRun(sourceId, ordinal);
        yield* addTurn({ threadId: sourceId, runOrdinal: ordinal, start: ordinal * 10 });
      }
      yield* createThread(forkId, {
        forkedFrom: { threadId: sourceId, runId: runIdFor(sourceId, 2) },
      });
      for (let ordinal = 1; ordinal <= 4; ordinal++) {
        yield* createRun(forkId, ordinal);
        yield* addTurn({ threadId: forkId, runOrdinal: ordinal, start: ordinal * 10, tools: 2 });
      }

      for (const threadId of [sourceId, forkId]) {
        for (const maxVisibleItems of [undefined, 4, 8]) {
          const snapshot = yield* store.getThreadSnapshot(
            threadId,
            maxVisibleItems === undefined ? undefined : { maxVisibleItems },
          );
          const plain = threadSnapshotForWire({ ...snapshot, compactTurnItems: false });
          assert.notProperty(plain, "turnItemsOmitLocalVisible");
          const compact = threadSnapshotForWire({ ...snapshot, compactTurnItems: true });
          assert.strictEqual(compact.turnItemsOmitLocalVisible, true);
          // Nothing hidden here: every local item is also a visible row.
          assert.strictEqual(compact.projection.turnItems.length, 0);
          // What a client decodes and restores is exactly the plain snapshot.
          const decoded = decodeProjectionJson(JSON.parse(encodeProjection(compact.projection)));
          assert.strictEqual(
            encodeProjection(boundedSnapshotProjection({ ...compact, projection: decoded })),
            encodeProjection(plain.projection),
          );
        }
      }
    }),
  );

  it.effect("send full turnItems when a hidden item breaks the compact layout", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const threadId = ThreadId.make("thread:window:compact-hidden");
      yield* createThread(threadId);
      yield* createRun(threadId, 1, "rolled_back");
      yield* addTurn({ threadId, runOrdinal: 1, start: 1 });
      yield* createRun(threadId, 2);
      yield* addTurn({ threadId, runOrdinal: 2, start: 10 });

      const snapshot = yield* store.getThreadSnapshot(threadId);
      const compact = threadSnapshotForWire({ ...snapshot, compactTurnItems: true });
      assert.notProperty(compact, "turnItemsOmitLocalVisible");
      assert.strictEqual(
        encodeProjection(compact.projection),
        encodeProjection(projectThreadProjectionForWire(snapshot.projection)),
      );
    }),
  );

  it.effect("read turn items and messages through indexes", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:window:plan");
      yield* createThread(threadId);
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        yield* createRun(threadId, ordinal);
        yield* addTurn({ threadId, runOrdinal: ordinal, start: ordinal * 10 });
      }
      yield* addItem({ threadId, runOrdinal: null, ordinal: 40, spec: { type: "user_message" } });

      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      yield* store
        .getThreadSnapshot(threadId, { maxVisibleItems: 2 })
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));

      const planOf = (...needles: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const query = queries.find(([text]) => needles.every((needle) => text.includes(needle)));
          assert.isDefined(query, needles.join(" "));
          const plan = yield* sql.unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN ${query![0]}`,
            query![1],
          );
          return plan.map((row) => row.detail);
        });
      const keyPlan = yield* planOf("orchestration_v2_projection_turn_items", "AS message_id");
      const itemPlan = yield* planOf("orchestration_v2_projection_turn_items", "UNION ALL");
      const messagePlan = yield* planOf("orchestration_v2_projection_messages", "UNION ALL");
      // Kept runs come off (thread_id, run_id), kept runless rows by id; the
      // dropped history is never walked. Only the key scan reads every row.
      assert.isTrue(
        itemPlan.some((detail) =>
          detail.includes("turn_items_thread_run_idx (thread_id=? AND run_id=?)"),
        ),
      );
      assert.isTrue(itemPlan.some((detail) => detail.includes("(turn_item_id=?)")));
      assert.isTrue(
        messagePlan
          .filter((detail) => detail.startsWith("SEARCH"))
          .every((detail) => detail.includes("messages_thread_run_idx (thread_id=? AND run_id=?)")),
      );
      for (const detail of [...keyPlan, ...itemPlan, ...messagePlan]) {
        assert.notMatch(detail, /^SCAN orchestration_v2|TEMP B-TREE/);
      }
    }),
  );

  it.effect("read every snapshot table through an index under production statistics", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const sourceId = ThreadId.make("thread:window:stats-source");
      const forkId = ThreadId.make("thread:window:stats-fork");
      yield* createThread(sourceId);
      for (let ordinal = 1; ordinal <= 2; ordinal++) {
        yield* createRun(sourceId, ordinal);
        yield* addTurn({ threadId: sourceId, runOrdinal: ordinal, start: ordinal * 10 });
      }
      yield* createThread(forkId, {
        forkedFrom: { threadId: sourceId, runId: runIdFor(sourceId, 2) },
      });
      yield* createRun(forkId, 1);
      yield* addTurn({ threadId: forkId, runOrdinal: 1, start: 10 });

      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      yield* Effect.all([
        store.getThreadSnapshot(forkId, { maxVisibleItems: 2 }),
        store.getThreadSnapshot(forkId),
        store.getThreadRecords(forkId, []),
      ]).pipe(Effect.provideService(Statement.CurrentTransformer, record));

      // Production statistics flipped the provider-thread read to a full table
      // scan; a plan that only holds without them is not a pinned plan.
      yield* loadProductionPlannerStatistics;
      const scans = yield* Effect.forEach(queries, ([text, params]) =>
        sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params).pipe(
          Effect.map((plan) =>
            plan
              .map((row) => row.detail)
              .filter((detail) => detail.startsWith("SCAN orchestration_v2"))
              .map((detail) => `${detail} in ${text.replace(/\s+/g, " ").slice(0, 120)}`),
          ),
        ),
      ).pipe(Effect.ensuring(Effect.orDie(clearPlannerStatistics)));
      assert.isAbove(queries.length, 10);
      assert.deepStrictEqual(scans.flat(), []);
    }),
  );
});

it.effect("reads a snapshot while another process holds the write lock", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-read-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const threadId = ThreadId.make("thread:window:write-locked");

  return Effect.gen(function* () {
    yield* createThread(threadId);
    yield* createRun(threadId, 1);
    yield* addTurn({ threadId, runOrdinal: 1, start: 1 });

    const writer = new NodeSqlite.DatabaseSync(dbPath);
    writer.exec("BEGIN IMMEDIATE");
    const snapshot = yield* (yield* ProjectionStoreV2)
      .getThreadSnapshot(threadId, { maxVisibleItems: 10 })
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            writer.exec("ROLLBACK");
            writer.close();
          }),
        ),
      );
    assert.strictEqual(snapshot.projection.visibleTurnItems.length, 3);
  }).pipe(
    Effect.provide(
      projectionStoreLayer.pipe(
        Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("keeps a long thread's windowed wire projection within budget", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const threadId = ThreadId.make("thread:window:budget");
    yield* createThread(threadId);
    // 60 turns of 4 tool calls with 4 KiB outputs: about 1 MiB of transcript.
    const output = "x".repeat(4096);
    for (let ordinal = 1; ordinal <= 60; ordinal++) {
      yield* createRun(threadId, ordinal);
      yield* addTurn({ threadId, runOrdinal: ordinal, start: ordinal * 10, tools: 4, output });
    }
    const full = yield* store.getThreadSnapshot(threadId);
    const windowed = yield* store.getThreadSnapshot(threadId, { maxVisibleItems: 30 });

    const wireBytes = (projection: OrchestrationV2ThreadProjection) =>
      new TextEncoder().encode(encodeProjection(projectThreadProjectionForWire(projection)))
        .byteLength;
    assert.strictEqual(windowed.projection.visibleTurnItems.length, 30);
    assert.strictEqual(windowed.projection.turnItems.length, 30);
    assert.strictEqual(windowed.projection.messages.length, 10);
    assert.strictEqual(windowed.projection.truncatedVisibleItemCount, 330);
    // The transcript is what the window bounds. Runs and nodes stay whole,
    // since clients read them for visibility and attempts, so they still grow
    // with history (about 1 KiB per turn here).
    const transcriptBytes = (projection: OrchestrationV2ThreadProjection) =>
      wireBytes({ ...projection, runs: [], nodes: [] });
    assert.isBelow(transcriptBytes(windowed.projection), 48 * 1024);
    assert.isBelow(wireBytes(windowed.projection), 128 * 1024);
    assert.isBelow(wireBytes(windowed.projection) * 4, wireBytes(full.projection));
  }).pipe(Effect.provide(TestLayer)),
);
