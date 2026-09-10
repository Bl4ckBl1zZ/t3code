import { it, assert } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, type AgentSessionImportSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as eventStoreLayer } from "../orchestration-v2/EventStore.ts";
import { layer as eventSinkLayer } from "../orchestration-v2/EventSink.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import {
  layer as projectionStoreLayer,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import { AgentSessionScanner, type AgentSessionRecentThread } from "./AgentSessionScanner.ts";
import { importedAgentThreadId, importRecentAgentThreads } from "./AgentSessionImporter.ts";

const database = SqlitePersistenceMemory;
const stores = Layer.mergeAll(
  database,
  eventStoreLayer.pipe(Layer.provide(database)),
  projectionStoreLayer.pipe(Layer.provide(database)),
);
const TestLayer = Layer.mergeAll(
  stores,
  eventSinkLayer.pipe(Layer.provide(stores)),
  idAllocatorLayer,
);
const timestamp = "2026-09-10T12:00:00.000Z";

function source(key: string): AgentSessionImportSource {
  return {
    provider: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: `native:${key}`,
    filePath: `/fixtures/${key}.jsonl`,
    size: 100,
    mtimeMs: 100,
    device: 1,
    inode: 1,
    birthtimeMs: 1,
  };
}
function transcript(item: AgentSessionImportSource): AgentSessionRecentThread {
  return {
    _tag: "Importable",
    source: item,
    thread: {
      source: item.provider,
      providerInstanceId: item.providerInstanceId,
      providerSessionId: item.providerSessionId,
      title: "CLI conversation",
      model: "gpt-5.4",
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { role: "user", text: "Keep my CLI history", createdAt: timestamp },
        { role: "assistant", text: "Original response", createdAt: timestamp },
      ],
    },
  };
}
const setup = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make(`project:${key}`);
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
    VALUES (${projectId}, 'Project', ${`/fixtures/${key}`}, NULL, '[]', ${timestamp}, ${timestamp}, NULL)`;
    return projectId;
  });
const runImport = (
  projectId: ProjectId,
  outcomes: ReadonlyArray<AgentSessionRecentThread>,
  expectedWorkspaceRoot?: string,
) =>
  importRecentAgentThreads({
    projectId,
    ...(expectedWorkspaceRoot === undefined ? {} : { expectedWorkspaceRoot }),
  }).pipe(
    Effect.provideService(
      AgentSessionScanner,
      AgentSessionScanner.of({
        scan: Effect.succeed({ candidates: [], scannedAt: timestamp }),
        recentThreads: () => Stream.fromIterable(outcomes),
      }),
    ),
  );

it.layer(TestLayer)("AgentSessionImporter V2", (it) => {
  it.effect(
    "atomically creates settled history and the original provider resume reference, without a runtime",
    () =>
      Effect.gen(function* () {
        const projectId = yield* setup("history");
        const item = source("history");
        assert.deepStrictEqual(yield* runImport(projectId, [transcript(item)]), {
          importedCount: 1,
          skippedCount: 0,
        });
        const store = yield* ProjectionStoreV2;
        const projection = yield* store.getThreadProjection(importedAgentThreadId(item));
        assert.deepStrictEqual(
          projection.messages.map((m) => [m.role, m.text]),
          [
            ["user", "Keep my CLI history"],
            ["assistant", "Original response"],
          ],
        );
        assert.deepStrictEqual(
          projection.visibleTurnItems.map((i) => i.item.type),
          ["user_message", "assistant_message"],
        );
        assert.strictEqual(projection.thread.settledOverride, "settled");
        assert.strictEqual(
          projection.thread.activeProviderThreadId,
          projection.providerThreads[0]?.id,
        );
        assert.strictEqual(
          projection.providerThreads[0]?.nativeThreadRef?.nativeId,
          item.providerSessionId,
        );
        assert.strictEqual(projection.providerThreads[0]?.status, "not_loaded");
        assert.strictEqual(projection.providerThreads[0]?.providerSessionId, null);
        assert.strictEqual(projection.providerSessions.length, 0);
        assert.strictEqual(projection.runs.length, 0);
      }),
  );
  it.effect("retries and copied files count once and never rewrite continued history", () =>
    Effect.gen(function* () {
      const projectId = yield* setup("retry");
      const item = source("retry");
      yield* runImport(projectId, [transcript(item)]);
      const sql = yield* SqlClient.SqlClient;
      const before =
        yield* sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${importedAgentThreadId(item)}`;
      const changed = transcript({ ...item, size: 200 });
      assert.deepStrictEqual(
        yield* runImport(projectId, [
          changed,
          { _tag: "Duplicate", source: { ...item, filePath: "/fixtures/copy.jsonl" } },
        ]),
        { importedCount: 1, skippedCount: 0 },
      );
      assert.strictEqual(
        (yield* sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${importedAgentThreadId(item)}`)
          .length,
        before.length,
      );
      assert.strictEqual(
        (yield* sql`SELECT file_path FROM agent_session_import_sources WHERE thread_id = ${importedAgentThreadId(item)}`)
          .length,
        2,
      );
    }),
  );
  it.effect("cannot move an imported native session into another project or account", () =>
    Effect.gen(function* () {
      const first = yield* setup("owner");
      const second = yield* setup("other");
      const item = source("owner");
      yield* runImport(first, [transcript(item)]);
      assert.deepStrictEqual(yield* runImport(second, [transcript(item)]), {
        importedCount: 0,
        skippedCount: 1,
      });
      const otherAccount = { ...item, providerInstanceId: ProviderInstanceId.make("codex-other") };
      assert.deepStrictEqual(yield* runImport(second, [transcript(otherAccount)]), {
        importedCount: 0,
        skippedCount: 1,
      });
      const store = yield* ProjectionStoreV2;
      assert.strictEqual(
        (yield* store.getThreadProjection(importedAgentThreadId(item))).thread.projectId,
        first,
      );
      assert.strictEqual(yield* store.getThreadShell(importedAgentThreadId(otherAccount)), null);
    }),
  );
  it.effect("a failed projection write rolls back the import ledger, receipt and all history", () =>
    Effect.gen(function* () {
      const projectId = yield* setup("rollback");
      const item = source("rollback");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER reject_import_message BEFORE INSERT ON orchestration_v2_projection_messages
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      assert.deepStrictEqual(yield* runImport(projectId, [transcript(item)]), {
        importedCount: 0,
        skippedCount: 1,
      });
      assert.strictEqual(
        (yield* sql`SELECT thread_id FROM agent_session_imports WHERE thread_id = ${importedAgentThreadId(item)}`)
          .length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${importedAgentThreadId(item)}`)
          .length,
        0,
      );
      yield* sql`DROP TRIGGER reject_import_message`;
      assert.deepStrictEqual(yield* runImport(projectId, [transcript(item)]), {
        importedCount: 1,
        skippedCount: 0,
      });
    }),
  );
  it.effect("rejects stale project roots and malformed Claude resume IDs", () =>
    Effect.gen(function* () {
      const projectId = yield* setup("validation");
      const result = yield* runImport(projectId, [], "/fixtures/stale").pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.strictEqual(result.failure._tag, "AgentSessionImportProjectChangedError");
      const invalid = {
        ...source("validation"),
        provider: "claudeAgent" as const,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      };
      assert.deepStrictEqual(yield* runImport(projectId, [transcript(invalid)]), {
        importedCount: 0,
        skippedCount: 1,
      });
      const valid = { ...invalid, providerSessionId: "62ec7fdc-4b76-4213-a117-85f1c5903c92" };
      assert.deepStrictEqual(yield* runImport(projectId, [transcript(valid)]), {
        importedCount: 1,
        skippedCount: 0,
      });
    }),
  );
});
