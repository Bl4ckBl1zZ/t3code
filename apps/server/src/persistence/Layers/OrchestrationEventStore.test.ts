import * as NodeV8 from "node:v8";
import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("orders project and V2 agent events in the retained application event source", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectId = ProjectId.make("project-shared-stream");
      const threadId = ThreadId.make("thread-shared-stream");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const occurredAt = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
      const now = DateTime.formatIso(occurredAt);
      const baselineSequence = yield* eventStore.latestApplicationSequence;

      const projectEvent = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("event-project-shared-stream"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.make("command-project-shared-stream"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-shared-stream"),
        metadata: {},
        payload: {
          projectId,
          title: "Shared stream",
          workspaceRoot: "/tmp/shared-stream",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const [threadEvent] = yield* eventStore.appendAgentEvents({
        commandId: CommandId.make("command-thread-shared-stream"),
        events: [
          {
            id: EventId.make("event-thread-shared-stream"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt,
            payload: {
              id: threadId,
              projectId,
              title: "Thread",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: {
                rootThreadId: threadId,
                parentThreadId: null,
                relationshipToParent: null,
              },
              forkedFrom: null,
              createdBy: "user",
              creationSource: "web",
              createdAt: occurredAt,
              updatedAt: occurredAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
        ],
      });

      const applicationEvents = yield* eventStore
        .streamApplicationEvents({ afterSequence: baselineSequence })
        .pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      assert.deepEqual(
        applicationEvents.map((event) => event.sequence),
        [projectEvent.sequence, threadEvent!.sequence],
      );
      assert.isTrue("aggregateKind" in applicationEvents[0]!);
      assert.isTrue("event" in applicationEvents[1]!);

      const finiteReplay = yield* eventStore
        .readApplicationEvents({
          afterSequence: baselineSequence,
          throughSequence: threadEvent!.sequence,
        })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      assert.deepEqual(
        finiteReplay.map((event) => event.sequence),
        [projectEvent.sequence, threadEvent!.sequence],
      );

      const legacyReplay = yield* eventStore.readFromSequence(projectEvent.sequence - 1).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.deepEqual(
        legacyReplay.map((event) => event.type),
        ["project.created"],
      );
    }),
  );

  it.effect("reads a thread's latest V2 sequence past newer non-V2 rows", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-latest-agent-sequence");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const occurredAt = DateTime.makeUnsafe("2026-01-03T00:00:00.000Z");
      const [agentEvent] = yield* eventStore.appendAgentEvents({
        commandId: CommandId.make("command-latest-agent-sequence"),
        events: [
          {
            id: EventId.make("event-latest-agent-sequence"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt,
            payload: {
              id: threadId,
              projectId: ProjectId.make("project-latest-agent-sequence"),
              title: "Thread",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
              forkedFrom: null,
              createdBy: "user",
              creationSource: "web",
              createdAt: occurredAt,
              updatedAt: occurredAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
        ],
      });
      // A newer row on the same stream that is not a V2 application event.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          ${EventId.make("event-latest-agent-sequence-legacy")}, ${"thread"}, ${threadId}, ${99},
          ${"thread.created"}, ${DateTime.formatIso(occurredAt)}, ${null}, ${null}, ${null},
          ${"server"}, ${"{}"}, ${"{}"}
        )
      `;

      assert.equal(yield* eventStore.latestAgentSequence(threadId), agentEvent!.sequence);
      assert.equal(
        yield* eventStore.latestAgentSequence(ThreadId.make("thread-without-events")),
        0,
      );
    }),
  );
});

// Exercise multiple SQL pages while the consumer remains active.
it.effect("releases consumed project replay pages and supports repeatable limited reads", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    const now = "2026-01-01T00:00:00.000Z";
    yield* Effect.forEach(
      Array.from({ length: 1501 }, (_, index) => index),
      (index) =>
        store.append({
          type: "project.created",
          eventId: EventId.make(`replay-page-${index}`),
          aggregateKind: "project",
          aggregateId: ProjectId.make(`replay-project-${index}`),
          occurredAt: now,
          commandId: CommandId.make(`replay-command-${index}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: ProjectId.make(`replay-project-${index}`),
            title: "Replay",
            workspaceRoot: `/tmp/replay-${index}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      { discard: true },
    );
    // oxlint-disable-next-line typescript/no-extraneous-class -- Identifies page markers for V8's heap query.
    class ReplayPage {}
    let count = 0;
    yield* Stream.runForEach(store.readAll(), (event) =>
      Effect.sync(() => {
        assert.equal(event.sequence, count + 1);
        if (count % 500 === 0) {
          Object.assign(event, { replayPage: new ReplayPage() });
          assert.isAtMost(NodeV8.queryObjects(ReplayPage, { format: "count" }), 1);
        }
        count++;
      }),
    );
    assert.equal(count, 1501);
    const limited = store.readFromSequence(1, 501.9);
    for (let run = 0; run < 2; run++) {
      const events = yield* Stream.runCollect(limited);
      assert.equal(events.length, 501);
      assert.equal(events[0]?.sequence, 2);
      assert.equal(events.at(-1)?.sequence, 502);
    }
    assert.deepEqual(yield* Stream.runCollect(store.readFromSequence(0, -1)), []);
  }).pipe(Effect.provide(OrchestrationEventStoreLive.pipe(Layer.provide(SqlitePersistenceMemory)))),
);

// Captures the one statement an effect runs and returns its query plan, so
// each read shape stays pinned to the index it names.
const explainOnlyStatement = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  params: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    const result = yield* effect.pipe(Effect.withTracer(tracer));
    assert.equal(statements.length, 1);
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statements[0]}`,
      params,
    );
    return { result, plan: plan.map((row) => row.detail).join("\n") };
  });

it.effect("replays a command's events through the command index, not the sequence range", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const occurredAt = "2026-09-03T00:00:00.000Z";
    yield* sql`
      WITH RECURSIVE history(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 25000
      )
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, actor_kind, payload_json, metadata_json, application_event_version
      )
      SELECT 'history:' || n, 'thread', 'thread', n, 'provider-session.detached', ${occurredAt},
        CASE WHEN n IN (12, 24990) THEN 'retried-command' ELSE 'command:' || n END,
        'server',
        '{"providerSessionId":"session","detachedAt":"' || ${occurredAt} || '"}',
        '{}', 2
      FROM history
    `;
    // Parameters: command, sequence range, limit.
    const { result, plan } = yield* explainOnlyStatement(
      store
        .readAgentEvents({ commandId: CommandId.make("retried-command") })
        .pipe(Stream.runCollect),
      ["retried-command", 0, Number.MAX_SAFE_INTEGER, 500],
    );
    assert.deepEqual(
      result.map((event) => event.sequence),
      [12, 24990],
    );
    assert.match(
      plan,
      /SEARCH orchestration_events USING INDEX idx_orch_events_command_id \(command_id=\?/,
    );
  }).pipe(
    Effect.provide(OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

it.effect("reads each event range from the index that bounds it", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const occurredAt = "2026-09-03T00:00:00.000Z";
    // Two interleaved threads plus legacy V1 rows, so a read that walks the
    // wrong index still has rows to skip.
    yield* sql`
      WITH RECURSIVE history(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 400
      )
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, actor_kind, payload_json, metadata_json, application_event_version
      )
      SELECT 'history:' || n, 'thread',
        CASE WHEN n % 4 = 0 THEN 'quiet-thread' ELSE 'busy-thread' END,
        n, 'provider-session.detached', ${occurredAt}, 'command:' || n, 'server',
        '{"providerSessionId":"session","detachedAt":"' || ${occurredAt} || '"}',
        '{}', CASE WHEN n % 10 = 0 THEN 1 ELSE 2 END
      FROM history
    `;
    const quietThread = ThreadId.make("quiet-thread");

    // Parameters: thread, sequence range, limit.
    const thread = yield* explainOnlyStatement(
      store
        .readAgentEvents({ threadId: quietThread, afterSequence: 100, limit: 129 })
        .pipe(Stream.runCollect),
      [quietThread, 100, Number.MAX_SAFE_INTEGER, 129],
    );
    assert.deepEqual(
      thread.result.map((event) => event.sequence),
      Array.from({ length: 75 }, (_, index) => 104 + index * 4).filter(
        (sequence) => sequence % 10 !== 0,
      ),
    );
    assert.match(
      thread.plan,
      /SEARCH orchestration_events USING INDEX idx_orch_events_stream_sequence \(aggregate_kind=\? AND stream_id=\? AND sequence>\? AND sequence<\?\)/,
    );
    assert.notMatch(thread.plan, /TEMP B-TREE/);

    // Parameters: sequence range, limit.
    const agent = yield* explainOnlyStatement(
      store.readAgentEvents({ afterSequence: 390 }).pipe(Stream.runCollect),
      [390, Number.MAX_SAFE_INTEGER, 1000],
    );
    assert.deepEqual(
      agent.result.map((event) => event.sequence),
      [391, 392, 393, 394, 395, 396, 397, 398, 399],
    );
    assert.match(
      agent.plan,
      /SEARCH orchestration_events USING INDEX idx_orchestration_events_application_sequence \(application_event_version=\? AND sequence>\? AND sequence<\?\)/,
    );
    assert.notMatch(agent.plan, /TEMP B-TREE/);

    const projectId = ProjectId.make("plan-project");
    yield* store.append({
      type: "project.created",
      eventId: EventId.make("plan-project-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt,
      commandId: CommandId.make("plan-project-command"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId,
        title: "Plan",
        workspaceRoot: "/tmp/plan",
        defaultModelSelection: null,
        scripts: [],
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    });
    // Parameters: sequence range, limit.
    const application = yield* explainOnlyStatement(
      store
        .readApplicationEvents({ afterSequence: 397, throughSequence: 401 })
        .pipe(Stream.runCollect),
      [397, 401, 500],
    );
    assert.deepEqual(
      application.result.map((event) => [
        event.sequence,
        "aggregateKind" in event ? event.aggregateKind : "agent",
      ]),
      [
        [398, "agent"],
        [399, "agent"],
        [401, "project"],
      ],
    );
    assert.match(
      application.plan,
      /SEARCH orchestration_events USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/,
    );
    assert.notMatch(application.plan, /TEMP B-TREE/);

    // Parameters: thread.
    const latest = yield* explainOnlyStatement(store.latestAgentSequence(quietThread), [
      quietThread,
    ]);
    assert.equal(latest.result, 396);
    assert.match(
      latest.plan,
      /SEARCH orchestration_events USING INDEX idx_orch_events_stream_sequence \(aggregate_kind=\? AND stream_id=\?\)/,
    );
  }).pipe(
    Effect.provide(OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);
