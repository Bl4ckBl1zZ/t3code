import * as NodeCrypto from "node:crypto";
import {
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportSource,
  AgentSessionScanError,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { AgentSessionScanner, type AgentSessionThread } from "./AgentSessionScanner.ts";

class AgentSessionOwnershipConflict extends Schema.TaggedErrorClass<AgentSessionOwnershipConflict>()(
  "AgentSessionOwnershipConflict",
  { threadId: ThreadId },
) {}

const claudeSessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(AgentSessionImportSource));
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentSessionImportSource));

/** Native session identity is account-scoped; file copies must not create new conversations. */
export function importedAgentThreadId(source: AgentSessionImportSource): ThreadId {
  const digest = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([source.provider, source.providerInstanceId, source.providerSessionId]))
    .digest("hex");
  return ThreadId.make(`import:${digest}`);
}

function historyEvents(
  thread: AgentSessionThread,
  appThread: OrchestrationV2AppThread,
  providerThread: OrchestrationV2ProviderThread,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = appThread.id;
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: appThread.createdAt,
      payload: appThread,
    },
    {
      id: EventId.make(`${threadId}:provider`),
      type: "provider-thread.updated",
      threadId,
      occurredAt: providerThread.updatedAt,
      payload: providerThread,
    },
  ];
  for (const [ordinal, message] of thread.messages.entries()) {
    const messageId = MessageId.make(`${threadId}:${String(ordinal).padStart(6, "0")}`);
    const timestamp = DateTime.makeUnsafe(message.createdAt);
    events.push({
      id: EventId.make(`${messageId}:message`),
      type: "message.updated",
      threadId,
      occurredAt: timestamp,
      payload: {
        id: messageId,
        threadId,
        createdBy: message.role === "user" ? "user" : "agent",
        creationSource: "server",
        runId: null,
        nodeId: null,
        role: message.role,
        text: message.text,
        attachments: [],
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    const base = {
      id: TurnItemId.make(`${messageId}:item`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ordinal + 1,
      status: "completed" as const,
      title: null,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    const item: OrchestrationV2TurnItem =
      message.role === "user"
        ? {
            ...base,
            type: "user_message",
            messageId,
            createdBy: "user",
            creationSource: "server",
            inputIntent: "turn_start",
            text: message.text,
            attachments: [],
          }
        : { ...base, type: "assistant_message", messageId, text: message.text, streaming: false };
    events.push({
      id: EventId.make(`${messageId}:item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: timestamp,
      payload: item,
    });
  }
  // Parsing preserves source order, which need not be chronological. Keep the shell's
  // activity timestamp at the transcript's end regardless of its last visible message.
  events.push({
    id: EventId.make(`${threadId}:metadata`),
    type: "thread.metadata-updated",
    threadId,
    occurredAt: appThread.updatedAt,
    payload: appThread,
  });
  return events;
}

/** Import visible CLI history directly into V2, without starting a provider process. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner;
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSinkV2;
  const ids = yield* IdAllocatorV2;
  const readProject = Effect.gen(function* () {
    const rows = yield* sql<{
      workspace_root: string;
    }>`SELECT workspace_root FROM projection_projects
      WHERE project_id = ${input.projectId} AND deleted_at IS NULL`;
    const row = rows[0];
    if (row === undefined)
      return yield* new AgentSessionImportProjectNotFoundError({ projectId: input.projectId });
    return row.workspace_root;
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(new AgentSessionScanError({ operation: "read-projects", cause })),
    ),
  );
  const workspaceRoot = yield* readProject;
  const sameRoot = (root: string) =>
    normalizeProjectPathForComparison(root) === normalizeProjectPathForComparison(workspaceRoot);
  if (input.expectedWorkspaceRoot !== undefined && !sameRoot(input.expectedWorkspaceRoot)) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* sql<{ source_json: string }>`SELECT s.source_json
    FROM agent_session_import_sources s JOIN agent_session_imports i ON i.thread_id = s.thread_id
    WHERE i.project_id = ${input.projectId}`.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeSource(row.source_json))),
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
  );
  const imported = new Set<ThreadId>();
  let skippedCount = 0;

  const recordSource = (threadId: ThreadId, source: AgentSessionImportSource) =>
    Effect.gen(function* () {
      const json = yield* encodeSource(source);
      yield* sql`INSERT INTO agent_session_import_sources (thread_id, file_path, source_json)
      VALUES (${threadId}, ${source.filePath}, ${json})
      ON CONFLICT(thread_id, file_path) DO UPDATE SET source_json = excluded.source_json`;
    });
  const hasCompletedImport = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT i.thread_id FROM agent_session_imports i
      JOIN orchestration_v2_projection_threads t ON t.thread_id = i.thread_id
      WHERE i.thread_id = ${threadId} AND i.project_id = ${input.projectId}
        AND t.project_id = ${input.projectId} AND t.deleted_at IS NULL`;
      return rows.length > 0;
    });

  yield* Stream.runForEach(scanner.recentThreads(workspaceRoot, completedSources), (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      const threadId = importedAgentThreadId(outcome.source);
      const result = yield* Effect.gen(function* () {
        if (!sameRoot(yield* readProject))
          return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
        if (yield* hasCompletedImport(threadId)) {
          // A retry may observe newer CLI text or a copied transcript. Never overwrite
          // history the user has already continued, renamed, archived, or edited in T3.
          yield* recordSource(threadId, outcome.source);
          return true;
        }
        if (outcome._tag !== "Importable") return false;
        const thread = outcome.thread;
        if (
          thread.source === "claudeAgent" &&
          !claudeSessionIdPattern.test(thread.providerSessionId)
        )
          return false;
        const driver = ProviderDriverKind.make(thread.source);
        const providerThreadId = ids.derive.providerThread({
          driver,
          nativeThreadId: thread.providerSessionId,
        });
        const createdAt = DateTime.makeUnsafe(thread.createdAt);
        const updatedAt = DateTime.makeUnsafe(thread.updatedAt);
        const appThread: OrchestrationV2AppThread = {
          createdBy: "system",
          creationSource: "server",
          id: threadId,
          projectId: input.projectId,
          title: thread.title,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: {
            instanceId: thread.providerInstanceId,
            model: thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL,
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          historyOrigin: "native",
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt,
          updatedAt,
          archivedAt: null,
          deletedAt: null,
          lastVisitedAt: null,
          settledOverride: "settled",
          settledAt: updatedAt,
        };
        const providerThread: OrchestrationV2ProviderThread = {
          id: providerThreadId,
          driver,
          providerInstanceId: thread.providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver,
            nativeId: thread.providerSessionId,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt,
          updatedAt,
        };
        yield* sink.commitCommand({
          commandId: CommandId.make(`${threadId}:history`),
          threadId,
          commandType: "thread.agent-session.import",
          acceptedAt: yield* DateTime.now,
          events: historyEvents(thread, appThread, providerThread),
          effects: [],
          prepareTransaction: Effect.gen(function* () {
            if (!sameRoot(yield* readProject))
              return yield* new AgentSessionImportProjectChangedError({
                projectId: input.projectId,
              });
            const existing =
              yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
            // V2 provider IDs are global across accounts. A copied native ID must never
            // reassign an existing T3 thread's provider projection to this import.
            const owner =
              yield* sql`SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${providerThreadId}`;
            if (existing.length > 0 || owner.length > 0)
              return yield* Effect.fail(new AgentSessionOwnershipConflict({ threadId }));
            yield* sql`INSERT INTO agent_session_imports (thread_id, project_id, provider_thread_id)
              VALUES (${threadId}, ${input.projectId}, ${providerThreadId})`;
            yield* recordSource(threadId, outcome.source);
          }),
        });
        return yield* hasCompletedImport(threadId);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session into V2", {
            provider: outcome.source.provider,
            providerInstanceId: outcome.source.providerInstanceId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (result) imported.add(threadId);
      else skippedCount += 1;
    }),
  );
  return { importedCount: imported.size, skippedCount } satisfies AgentSessionImportResult;
});

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  {
    readonly importRecent: (
      input: AgentSessionImportInput,
    ) => Effect.Effect<
      AgentSessionImportResult,
      | AgentSessionScanError
      | AgentSessionImportProjectChangedError
      | AgentSessionImportProjectNotFoundError
    >;
  }
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(
  AgentSessionImporter,
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner;
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    return AgentSessionImporter.of({
      importRecent: (input) =>
        importRecentAgentThreads(input).pipe(
          Effect.provideService(AgentSessionScanner, scanner),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(EventSinkV2, sink),
          Effect.provideService(IdAllocatorV2, ids),
        ),
    });
  }),
);
