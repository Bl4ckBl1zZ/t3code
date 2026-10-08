import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { loadProductionPlannerStatistics } from "../persistence/productionPlannerStatistics.testkit.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { EventStoreV2, layer as eventStoreLayer } from "./EventStore.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "./ProjectionMaintenance.ts";
import {
  applyToProjection,
  emptyProjection,
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "./ProjectionStore.ts";

// Provided per test, so each test builds its own database: compaction cursors
// are per store.
const storesLayer = Layer.mergeAll(eventStoreLayer, projectionStoreLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const testLayer = Layer.mergeAll(
  storesLayer,
  eventSinkLayer.pipe(Layer.provide(storesLayer)),
  projectionMaintenanceLayer.pipe(Layer.provide(storesLayer)),
);

const providerInstanceId = ProviderInstanceId.make("codex");

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

/** Events of one thread with a streaming tool item, assistant message, and node. */
function makeStreamingThread(name: string, now: DateTime.Utc) {
  const threadId = ThreadId.make(`thread:${name}`);
  const thread = makeThread(threadId, now);
  const turnItemId = TurnItemId.make(`turn-item:${name}`);
  const messageId = MessageId.make(`message:${name}`);
  const nodeId = NodeId.make(`node:${name}`);
  const created: OrchestrationV2DomainEvent = {
    id: EventId.make(`event:${name}:create`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  };
  const visited = (suffix: string): OrchestrationV2DomainEvent => ({
    id: EventId.make(`event:${name}:visit-${suffix}`),
    type: "thread.visited",
    threadId,
    providerInstanceId,
    occurredAt: now,
    payload: { ...thread, lastVisitedAt: now },
  });
  // Each rewrite carries everything so far, like a streaming command's output.
  const turnItem = (
    version: number,
    status: "running" | "completed",
  ): OrchestrationV2DomainEvent => ({
    id: EventId.make(`event:${name}:item-${version}`),
    type: "turn-item.updated",
    threadId,
    providerInstanceId,
    occurredAt: now,
    payload: {
      id: turnItemId,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status,
      title: "tool",
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
      type: "dynamic_tool" as const,
      toolName: "tool",
      input: {},
      output: { text: "x".repeat(version * 4_000) },
    },
  });
  const message = (version: number): OrchestrationV2DomainEvent => ({
    id: EventId.make(`event:${name}:message-${version}`),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "agent",
      creationSource: "provider",
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: "assistant",
      text: "word ".repeat(version * 50),
      attachments: [],
      streaming: version < 3,
      createdAt: now,
      updatedAt: now,
    },
  });
  const node = (version: number): OrchestrationV2DomainEvent => ({
    id: EventId.make(`event:${name}:node-${version}`),
    type: "node.updated",
    threadId,
    nodeId,
    occurredAt: now,
    payload: {
      id: nodeId,
      threadId,
      runId: null,
      kind: "root_turn",
      parentNodeId: null,
      rootNodeId: nodeId,
      status: version < 3 ? "running" : "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: version < 3 ? null : now,
    },
  });
  return { threadId, created, visited, turnItem, message, node };
}

const readThread = (threadId: ThreadId, afterSequence = 0) =>
  Effect.gen(function* () {
    const eventStore = yield* EventStoreV2;
    return Array.from(
      yield* eventStore.read({ threadId, afterSequence, limit: 10_000 }).pipe(Stream.runCollect),
    );
  });

const eventIds = (threadId: ThreadId) =>
  Effect.map(readThread(threadId), (events) => events.map((stored) => String(stored.event.id)));

/** The client-side fold a resuming subscriber runs over the events it receives. */
function fold(
  start: OrchestrationV2ThreadProjection | null,
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
): OrchestrationV2ThreadProjection | null {
  let projection = start;
  for (const { event } of events) {
    projection =
      projection === null
        ? event.type === "thread.created"
          ? emptyProjection(event)
          : null
        : applyToProjection(projection, event);
  }
  return projection;
}

const byId = <T extends { readonly id: string }>(items: ReadonlyArray<T>) =>
  [...items].sort((left, right) => left.id.localeCompare(right.id));

const entityState = (projection: OrchestrationV2ThreadProjection | null) => ({
  thread: projection?.thread,
  turnItems: byId(projection?.turnItems ?? []),
  messages: byId(projection?.messages ?? []),
  nodes: byId(projection?.nodes ?? []),
});

it.effect(
  "collects superseded streaming snapshots an hour after their successor, and every reader converges",
  () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const projectionStore = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const t = makeStreamingThread("compaction-streaming", now);

      yield* eventSink.write({ events: [t.created, t.visited("1"), t.turnItem(1, "running")] });
      // A client that subscribed mid-stream holds everything up to here.
      const resumeCursor = (yield* readThread(t.threadId)).at(-1)!.sequence;
      yield* eventSink.write({
        events: [
          t.message(1),
          t.node(1),
          t.turnItem(2, "running"),
          t.message(2),
          t.node(2),
          t.turnItem(3, "running"),
          t.message(3),
          t.node(3),
          t.visited("2"),
          // Still streaming when the server dies: its latest snapshot is all
          // that recovery has.
          t.turnItem(4, "running"),
        ],
      });
      const original = yield* readThread(t.threadId);
      const clientAtCursor = fold(
        null,
        original.filter((stored) => stored.sequence <= resumeCursor),
      );
      const projectionBefore = yield* projectionStore.getThreadProjection(t.threadId);

      // Inside the hour nothing is collected.
      assert.equal((yield* maintenance.compactEventStore()).deletedEventCount, 0);

      yield* TestClock.adjust(Duration.hours(2));
      const summary = yield* maintenance.compactEventStore();
      assert.equal(summary.deletedEventCount, 6);
      assert.deepEqual(yield* eventIds(t.threadId), [
        "event:compaction-streaming:create",
        "event:compaction-streaming:visit-1",
        // Turn items keep both ends; messages and nodes keep their latest.
        "event:compaction-streaming:item-1",
        "event:compaction-streaming:message-3",
        "event:compaction-streaming:node-3",
        // Thread-state history stays for the full retention window.
        "event:compaction-streaming:visit-2",
        "event:compaction-streaming:item-4",
      ]);

      // A client resuming from its cursor reaches the same state as one that
      // saw every rewrite.
      const resumed = fold(clientAtCursor, yield* readThread(t.threadId, resumeCursor));
      assert.deepEqual(entityState(resumed), entityState(fold(null, original)));

      // Rebuilding from the compacted log reproduces the projection, including
      // the in-flight item's last persisted state.
      assert.isTrue((yield* maintenance.rebuild).valid);
      const projectionAfter = yield* projectionStore.getThreadProjection(t.threadId);
      assert.deepEqual(projectionAfter, projectionBefore);
      const item = projectionAfter.turnItems.find((turnItem) => turnItem.type === "dynamic_tool");
      assert.equal(item?.status, "running");
      assert.deepEqual(item?.type === "dynamic_tool" ? item.output : null, {
        text: "x".repeat(16_000),
      });
    }).pipe(Effect.provide(testLayer)),
);

it.effect("walks the log in bounded ranges and resumes from its cursor", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const maintenance = yield* ProjectionMaintenanceV2;
    const eventStore = yield* EventStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const t = makeStreamingThread("compaction-chunks", now);

    // More events than one range holds, so the pass has to take several.
    yield* eventSink.write({ events: [t.created, t.turnItem(1, "running")] });
    const filler = Array.from({ length: 4_500 }, (_, index) => t.visited(`filler-${index}`));
    yield* eventSink.write({ events: filler });
    yield* eventSink.write({ events: [t.turnItem(2, "running")] });

    const ranges: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          const text = String(span.attributes.get("db.query.text") ?? "");
          if (text.includes("WITH latest") && text.includes("event_type,")) {
            ranges.push(text);
          }
        };
        return span;
      },
    });

    yield* TestClock.adjust(Duration.hours(2));
    const highWater = yield* eventStore.latestSequence();
    const first = yield* maintenance
      .compactEventStore({ retainNewerThan: Duration.hours(1) })
      .pipe(Effect.withTracer(tracer));
    // ceil(4_503 / 500) ranges for the snapshot pass; thread-state visits
    // collapse to the newest.
    assert.equal(ranges.length, Math.ceil(highWater / 500));
    assert.equal(first.deletedEventCount, 4_499);
    const cursors = yield* sql<{ readonly pass: string; readonly through_sequence: number }>`
      SELECT pass, through_sequence
      FROM orchestration_event_compaction_cursors
      ORDER BY pass
    `;
    assert.deepEqual(cursors, [
      { pass: "entity-snapshots", through_sequence: highWater },
      { pass: "thread-state", through_sequence: highWater },
    ]);

    // The next run reads only what was appended since. A new version still
    // collects its predecessors behind the cursor.
    yield* eventSink.write({ events: [t.turnItem(3, "completed")] });
    yield* TestClock.adjust(Duration.hours(2));
    ranges.length = 0;
    const second = yield* maintenance
      .compactEventStore({ retainNewerThan: Duration.hours(1) })
      .pipe(Effect.withTracer(tracer));
    assert.equal(ranges.length, 1);
    assert.equal(second.deletedEventCount, 1);
    const remaining = (yield* readThread(t.threadId))
      .filter((stored) => stored.event.type === "turn-item.updated")
      .map((stored) => String(stored.event.id));
    assert.deepEqual(remaining, [
      "event:compaction-chunks:item-1",
      "event:compaction-chunks:item-3",
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("finds older versions through the partial indexes", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const maintenance = yield* ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const t = makeStreamingThread("compaction-plan", now);
    yield* eventSink.write({
      events: [t.created, t.visited("1"), t.turnItem(1, "running"), t.turnItem(2, "running")],
    });

    const statements = new Set<string>();
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          const text = String(span.attributes.get("db.query.text") ?? "");
          if (text.trimStart().startsWith("WITH latest")) {
            statements.add(text);
          }
        };
        return span;
      },
    });
    yield* maintenance
      .compactEventStore({ retainNewerThan: Duration.zero })
      .pipe(Effect.withTracer(tracer));
    assert.equal(statements.size, 2);

    const explainAll = Effect.forEach([...statements], (text) =>
      sql
        .unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          Array.from(text.matchAll(/\?/g), () => 0),
        )
        .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n"))),
    );
    const withoutStatistics = yield* explainAll;
    // The plans are pinned, so production statistics must not move them.
    yield* loadProductionPlannerStatistics;
    const withStatistics = yield* explainAll;
    for (const plan of withStatistics) {
      // At production size the range is bounded on both ends. (On this tiny
      // table the planner may skip the upper bound; it costs nothing here.)
      assert.include(plan, "USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)");
    }
    for (const plan of [...withoutStatistics, ...withStatistics]) {
      // Seeks by type, entity id, and sequence, not just by type.
      assert.include(
        plan,
        "SEARCH version USING INDEX idx_orch_events_versions (event_type=? AND <expr>=? AND sequence<?)",
        plan,
      );
      // The range is read by rowid and older versions by index; nothing scans
      // the table or walks a whole index.
      assert.include(plan, "SEARCH orchestration_events USING INTEGER PRIMARY KEY");
      assert.notMatch(plan, /\bSCAN (orchestration_events|version|first)\b/);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("hands freed pages back to the filesystem on new databases", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const maintenance = yield* ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const t = makeStreamingThread("compaction-vacuum", now);

    const autoVacuum = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    assert.deepEqual(autoVacuum, [{ auto_vacuum: 2 }]);

    yield* eventSink.write({
      events: [
        t.created,
        ...Array.from({ length: 40 }, (_, index) => t.turnItem(index + 1, "running")),
      ],
    });
    const summary = yield* maintenance.compactEventStore({ retainNewerThan: Duration.zero });
    assert.equal(summary.deletedEventCount, 38);
    assert.isAbove(summary.reclaimedBytes, 1_000_000);
    assert.equal(summary.reclaimableBytes, 0);
    const freelist = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    assert.deepEqual(freelist, [{ freelist_count: 0 }]);
  }).pipe(Effect.provide(testLayer)),
);
