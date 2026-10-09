import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  ProjectId,
  type PullRequestDetail,
  type PullRequestComment,
  PullRequestOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { LegacyV1ThreadImporter, LegacyV1ThreadImportError } from "./LegacyV1ThreadImporter.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2,
} from "./Orchestrator.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionMaintenanceV2 } from "./ProjectionMaintenance.ts";
import type { ProviderAdapterV2SessionRuntime, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { unavailableLayer as textGenerationUnavailableLayer } from "../textGeneration/TextGeneration.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const driver = ProviderDriverKind.make("codex");
const historyHydrationThreadId = ThreadId.make("runtime-layer-history-hydration-thread");
let hydrationSnapshotReads = 0;
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) => {
    if (input.threadId !== historyHydrationThreadId) {
      return Effect.die("sessions are not used by lifecycle tests");
    }
    const now = DateTime.nowUnsafe();
    const makeProviderThread = (threadId: ThreadId): OrchestrationV2ProviderThread => ({
      id: ProviderThreadId.make(`provider-thread:hydration:${threadId}`),
      driver,
      providerInstanceId: modelSelection.instanceId,
      providerSessionId: input.providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    });
    const runtime: ProviderAdapterV2SessionRuntime = {
      instanceId: modelSelection.instanceId,
      driver,
      providerSessionId: input.providerSessionId,
      providerSession: {
        id: input.providerSessionId,
        driver,
        providerInstanceId: modelSelection.instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? process.cwd(),
        model: input.modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      events: Stream.never,
      ensureThread: (threadInput) => Effect.succeed(makeProviderThread(threadInput.threadId)),
      resumeThread: (threadInput) => Effect.succeed(threadInput.providerThread),
      startTurn: () => Effect.die("unused startTurn"),
      steerTurn: () => Effect.die("unused steerTurn"),
      interruptTurn: () => Effect.die("unused interruptTurn"),
      respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
      readThreadSnapshot: ({ providerThread }) =>
        Effect.sync(() => {
          hydrationSnapshotReads += 1;
          const threadId = providerThread.appThreadId!;
          return {
            providerThread,
            providerTurns: [],
            messages: [
              {
                createdBy: "user",
                creationSource: "provider",
                id: MessageId.make("message:hydrated:user"),
                threadId,
                runId: null,
                nodeId: null,
                role: "user",
                text: "Existing Hermes question",
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
              {
                createdBy: "agent",
                creationSource: "provider",
                id: MessageId.make("message:hydrated:assistant"),
                threadId,
                runId: null,
                nodeId: null,
                role: "assistant",
                text: "Existing Hermes answer",
                attachments: [],
                streaming: false,
                createdAt: DateTime.add(now, { milliseconds: 1 }),
                updatedAt: DateTime.add(now, { milliseconds: 1 }),
              },
            ],
            runtimeRequests: [],
            turnItems: [
              {
                id: TurnItemId.make("turn-item:hydrated:command"),
                threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: "git status",
                startedAt: now,
                completedAt: now,
                updatedAt: DateTime.add(now, { milliseconds: 1 }),
                type: "command_execution",
                input: "git status",
                output: "clean",
              },
            ],
          };
        }),
      rollbackThread: () => Effect.die("unused rollbackThread"),
      forkThread: () => Effect.die("unused forkThread"),
    };
    return Effect.succeed(runtime);
  },
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
  listInstances: Effect.succeed([providerInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const TestLayer = Layer.merge(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(textGenerationUnavailableLayer),
  Layer.provide(NodeServices.layer),
);

const LegacyImportTestLayer = OrchestrationV2LayerLive.pipe(
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(textGenerationUnavailableLayer),
  Layer.provide(NodeServices.layer),
);

const SharedApplicationDataPlaneTestLayer = Layer.merge(
  OrchestrationLayerLive,
  OrchestrationV2LayerLive,
).pipe(
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(textGenerationUnavailableLayer),
  Layer.provide(NodeServices.layer),
);

it.layer(LegacyImportTestLayer)("OrchestrationV2 legacy import", (it) => {
  it.effect("hydrates imported transcripts before commands and propagates hydration failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenanceV2;
      const orchestrator = yield* OrchestratorV2;
      const threadManagement = yield* ThreadManagementService;
      const metadataThreadId = ThreadId.make("runtime-layer-legacy-metadata-thread");
      const failureThreadId = ThreadId.make("runtime-layer-legacy-failure-thread");
      const projectId = ProjectId.make("runtime-layer-legacy-project");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Legacy project',
          '/tmp/runtime-layer-legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES
          (
            ${metadataThreadId},
            ${projectId},
            'Legacy metadata title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          ),
          (
            ${failureThreadId},
            ${projectId},
            'Legacy failure title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:runtime-layer-legacy:1',
            ${metadataThreadId},
            NULL,
            'user',
            'First imported question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:2',
            ${metadataThreadId},
            NULL,
            'assistant',
            'First imported answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:3',
            ${metadataThreadId},
            NULL,
            'user',
            'Latest imported question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:failure',
            ${failureThreadId},
            NULL,
            'user',
            'Imported context must load before archive',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          )
      `;

      yield* importer.reconcileShells;
      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);

      yield* threadManagement.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-legacy-metadata-update"),
        threadId: metadataThreadId,
        title: "Updated after import",
      });
      const updatedProjection = yield* threadManagement.getThreadProjection(metadataThreadId);
      assert.equal(updatedProjection.thread.title, "Updated after import");
      assert.deepEqual(
        updatedProjection.messages.map((message) => message.text),
        ["First imported question", "First imported answer", "Latest imported question"],
      );

      yield* sql`
        ALTER TABLE projection_thread_messages
        RENAME TO projection_thread_messages_unavailable
      `;
      const { projectionFailure, hydrationFailure } = yield* Effect.all({
        projectionFailure: threadManagement.getThreadProjection(failureThreadId).pipe(Effect.flip),
        hydrationFailure: threadManagement
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("runtime-layer-legacy-failed-archive"),
            threadId: failureThreadId,
          })
          .pipe(Effect.flip),
      }).pipe(
        Effect.ensuring(
          sql`
            ALTER TABLE projection_thread_messages_unavailable
            RENAME TO projection_thread_messages
          `.pipe(Effect.orDie),
        ),
      );
      assert.instanceOf(projectionFailure, OrchestratorProjectionError);
      assert.instanceOf(projectionFailure.cause, LegacyV1ThreadImportError);
      assert.instanceOf(hydrationFailure, OrchestratorDispatchError);
      assert.instanceOf(hydrationFailure.cause, LegacyV1ThreadImportError);

      const projectionAfterFailure = yield* orchestrator.getThreadProjection(failureThreadId);
      assert.isNull(projectionAfterFailure.thread.archivedAt);

      yield* threadManagement.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-legacy-retried-archive"),
        threadId: failureThreadId,
      });
      const projectionAfterRetry = yield* threadManagement.getThreadProjection(failureThreadId);
      assert.isNotNull(projectionAfterRetry.thread.archivedAt);
    }),
  );
});

it.layer(TestLayer)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("honors an explicit historical createdAt on thread.create for imported threads", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-imported-created-at-thread");
      const importedAt = DateTime.makeUnsafe("2020-06-01T12:00:00.000Z");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "system",
        creationSource: "provider",
        commandId: CommandId.make("runtime-layer-imported-created-at"),
        threadId,
        projectId: ProjectId.make("runtime-layer-imported-created-at-project"),
        title: "Imported thread with historical time",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: importedAt,
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        DateTime.toEpochMillis(projection.thread.createdAt),
        DateTime.toEpochMillis(importedAt),
      );
      assert.equal(
        DateTime.toEpochMillis(projection.thread.updatedAt),
        DateTime.toEpochMillis(importedAt),
      );
    }),
  );

  it.effect("hydrates provider history once and remains idempotent across retries and reopen", () =>
    Effect.gen(function* () {
      hydrationSnapshotReads = 0;
      const orchestrator = yield* OrchestratorV2;
      const providerSessions = yield* ProviderSessionManagerV2;
      const threadId = historyHydrationThreadId;

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "system",
        creationSource: "provider",
        commandId: CommandId.make("runtime-layer-history-hydration-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-history-hydration-project"),
        title: "Imported Hermes thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-history-hydration",
      });

      const hydrationInput = {
        threadId,
        providerInstanceId: modelSelection.instanceId,
      };
      yield* orchestrator.hydrateProviderThreadSnapshot(hydrationInput);
      const first = yield* orchestrator.getThreadSnapshot(threadId);
      yield* orchestrator.hydrateProviderThreadSnapshot(hydrationInput);
      const retry = yield* orchestrator.getThreadSnapshot(threadId);

      assert.deepEqual(
        retry.projection.messages.map((message) => message.text),
        ["Existing Hermes question", "Existing Hermes answer"],
      );
      assert.equal(retry.projection.messages.length, 2);
      assert.equal(
        DateTime.toEpochMillis(retry.projection.thread.updatedAt),
        Math.max(
          ...retry.projection.messages.map((message) => DateTime.toEpochMillis(message.updatedAt)),
        ),
      );
      assert.deepEqual(
        retry.projection.turnItems.map((item) => String(item.id)),
        ["turn-item:hydrated:command"],
      );
      assert.equal(retry.snapshotSequence, first.snapshotSequence);

      const providerSessionId = retry.projection.providerThreads[0]?.providerSessionId;
      assert.exists(providerSessionId);
      yield* providerSessions.close(providerSessionId!);
      yield* orchestrator.hydrateProviderThreadSnapshot(hydrationInput);
      const reopened = yield* orchestrator.getThreadProjection(threadId);

      assert.equal(hydrationSnapshotReads, 3);
      assert.equal(reopened.messages.length, 2);
      assert.deepEqual(
        reopened.messages.map((message) => message.id),
        [MessageId.make("message:hydrated:user"), MessageId.make("message:hydrated:assistant")],
      );
      assert.equal(reopened.turnItems.length, 1);
    }),
  );

  it.effect("settle detaches the thread's live provider session", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("runtime-layer-settle-detach-thread");
      const providerSessionId = ProviderSessionId.make("runtime-layer-settle-detach-session");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-detach-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-settle-detach-project"),
        title: "Settle detach",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-detach",
      });

      // A settled thread can still own an idle-but-live provider session
      // hosting background work (monitors, dev servers); settle must detach
      // it so that work stops with the thread.
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-settle-detach-seed"),
        events: [
          {
            id: EventId.make("runtime-layer-settle-detach-session-attached"),
            type: "provider-session.attached",
            threadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              status: "ready",
              cwd: "/tmp/runtime-layer-settle-detach",
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
        ],
      });
      const beforeSettle = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(beforeSettle.providerSessions[0]?.status, "ready");

      const settle = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-settle-detach-settle"),
        threadId,
      });
      const eventTypes = settle.storedEvents.map((stored) => stored.event.type);
      assert.include(eventTypes, "thread.settled");
      assert.include(eventTypes, "provider-session.detached");

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.lengthOf(projection.providerSessions, 0);
      // Settled threads stay reachable, so unlike archive/delete the thread's
      // terminals are not cleaned up: only its idle shells close.
      assert.isNull(projection.thread.archivedAt);
      const effectIds = (yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE command_id = ${"runtime-layer-settle-detach-settle"}
      `).map((row) => row.effect_id);
      assert.include(effectIds, "effect:runtime-layer-settle-detach-settle:terminal.close-idle");
      assert.notInclude(effectIds, "effect:runtime-layer-settle-detach-settle:terminal.cleanup");
    }),
  );

  it.effect("settles a thread its own agent settled once the turn completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const threadManagement = yield* ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-settle-after-run-project");
      const threadId = ThreadId.make("runtime-layer-settle-after-run-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-after-run-create"),
        threadId,
        projectId,
        title: "Settle after run",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-after-run",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-after-run-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-settle-after-run-message"),
        text: "Fix it and then settle this thread.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
      if (run === undefined) return yield* Effect.die(new Error("Run missing."));

      const settled = yield* orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "thread.settled" })
        .pipe(Stream.runHead, Effect.forkChild);
      const result = yield* threadManagement.settleThread({
        threadId,
        commandId: CommandId.make("runtime-layer-settle-after-run-settle"),
        byOwnAgent: true,
      });
      assert.deepEqual(result, { settlesWhenTurnEnds: true });
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-settle-after-run-completed"),
        events: [
          {
            id: EventId.make("runtime-layer-settle-after-run-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* Fiber.join(settled);

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.settledOverride, "settled");
    }),
  );

  it.effect("merges an explicit provider-finished run while checkpoint capture is pending", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("runtime-layer-waiting-merge-project");
      const targetThreadId = ThreadId.make("runtime-layer-waiting-merge-target");
      const sourceThreadId = ThreadId.make("runtime-layer-waiting-merge-source");
      const baseRunId = RunId.make("runtime-layer-waiting-merge-base-run");
      const sourceRunId = RunId.make("runtime-layer-waiting-merge-source-run");
      const sourceProviderThreadId = ProviderThreadId.make(
        "runtime-layer-waiting-merge-provider-thread",
      );
      const forkTransferId = ContextTransferId.make("runtime-layer-waiting-merge-fork-transfer");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-waiting-merge-create-target"),
        threadId: targetThreadId,
        projectId,
        title: "Waiting merge target",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);

      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-waiting-merge-seed"),
        events: [
          {
            id: EventId.make("runtime-layer-waiting-merge-source-thread-event"),
            type: "thread.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...target.thread,
              id: sourceThreadId,
              title: "Waiting merge source",
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: targetThreadId,
                relationshipToParent: "fork",
                rootThreadId: targetThreadId,
              },
              forkedFrom: {
                type: "run",
                threadId: targetThreadId,
                runId: baseRunId,
              },
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-fork-transfer-event"),
            type: "context-transfer.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: forkTransferId,
              type: "fork",
              sourceThreadId: targetThreadId,
              targetThreadId: sourceThreadId,
              sourcePoint: { threadId: targetThreadId, runId: baseRunId },
              basePoint: null,
              sourceProviderInstanceId: modelSelection.instanceId,
              targetProviderInstanceId: modelSelection.instanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-provider-thread-event"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceProviderThreadId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: "native-waiting-merge-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-source-run-event"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: sourceProviderThreadId,
              userMessageId: MessageId.make("runtime-layer-waiting-merge-message"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "waiting",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.merge_back",
        createdBy: "user",
        creationSource: "mobile",
        commandId: CommandId.make("runtime-layer-waiting-merge"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdAt: now,
      });

      const mergedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const transfer = mergedTarget.contextTransfers.find(
        (candidate) => candidate.type === "merge_back",
      );
      assert.isDefined(transfer);
      assert.equal(transfer.status, "pending");
      assert.equal(transfer.sourceThreadId, sourceThreadId);
      assert.equal(transfer.targetThreadId, targetThreadId);
      assert.equal(transfer.sourcePoint.runId, sourceRunId);
      assert.isUndefined(transfer.sourcePoint.checkpointId);
      assert.equal(transfer.sourcePoint.providerThreadRef?.nativeId, "native-waiting-merge-source");
      assert.equal(transfer.basePoint?.runId, baseRunId);
      assert.isNull(transfer.error);
    }),
  );
});

it.layer(LegacyImportTestLayer)("OrchestrationV2 legacy import", (it) => {
  it.effect("hydrates imported transcripts before commands and propagates hydration failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenanceV2;
      const orchestrator = yield* OrchestratorV2;
      const threadManagement = yield* ThreadManagementService;
      const metadataThreadId = ThreadId.make("runtime-layer-legacy-metadata-thread");
      const failureThreadId = ThreadId.make("runtime-layer-legacy-failure-thread");
      const projectId = ProjectId.make("runtime-layer-legacy-project");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Legacy project',
          '/tmp/runtime-layer-legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES
          (
            ${metadataThreadId},
            ${projectId},
            'Legacy metadata title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          ),
          (
            ${failureThreadId},
            ${projectId},
            'Legacy failure title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:runtime-layer-legacy:1',
            ${metadataThreadId},
            NULL,
            'user',
            'First imported question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:2',
            ${metadataThreadId},
            NULL,
            'assistant',
            'First imported answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:3',
            ${metadataThreadId},
            NULL,
            'user',
            'Latest imported question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:failure',
            ${failureThreadId},
            NULL,
            'user',
            'Imported context must load before archive',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          )
      `;

      yield* importer.reconcileShells;
      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);

      yield* threadManagement.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-legacy-metadata-update"),
        threadId: metadataThreadId,
        title: "Updated after import",
      });
      const updatedProjection = yield* threadManagement.getThreadProjection(metadataThreadId);
      assert.equal(updatedProjection.thread.title, "Updated after import");
      assert.deepEqual(
        updatedProjection.messages.map((message) => message.text),
        ["First imported question", "First imported answer", "Latest imported question"],
      );

      yield* sql`
        ALTER TABLE projection_thread_messages
        RENAME TO projection_thread_messages_unavailable
      `;
      const { projectionFailure, hydrationFailure } = yield* Effect.all({
        projectionFailure: threadManagement.getThreadProjection(failureThreadId).pipe(Effect.flip),
        hydrationFailure: threadManagement
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("runtime-layer-legacy-failed-archive"),
            threadId: failureThreadId,
          })
          .pipe(Effect.flip),
      }).pipe(
        Effect.ensuring(
          sql`
            ALTER TABLE projection_thread_messages_unavailable
            RENAME TO projection_thread_messages
          `.pipe(Effect.orDie),
        ),
      );
      assert.instanceOf(projectionFailure, OrchestratorProjectionError);
      assert.instanceOf(projectionFailure.cause, LegacyV1ThreadImportError);
      assert.instanceOf(hydrationFailure, OrchestratorDispatchError);
      assert.instanceOf(hydrationFailure.cause, LegacyV1ThreadImportError);

      const projectionAfterFailure = yield* orchestrator.getThreadProjection(failureThreadId);
      assert.isNull(projectionAfterFailure.thread.archivedAt);

      yield* threadManagement.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-legacy-retried-archive"),
        threadId: failureThreadId,
      });
      const projectionAfterRetry = yield* threadManagement.getThreadProjection(failureThreadId);
      assert.isNotNull(projectionAfterRetry.thread.archivedAt);
    }),
  );
});

it.layer(TestLayer)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("applies lifecycle commands idempotently and emits archive/removal shell deltas", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-lifecycle-thread");
      const create = {
        type: "thread.create" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        commandId: CommandId.make("runtime-layer-lifecycle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-lifecycle-project"),
        title: "Lifecycle thread",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
      };

      const firstCreate = yield* orchestrator.dispatch(create);
      const retriedCreate = yield* orchestrator.dispatch(create);
      assert.equal(retriedCreate.sequence, firstCreate.sequence);
      assert.lengthOf(retriedCreate.storedEvents, 1);

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-lifecycle-metadata"),
        threadId,
        title: "Renamed lifecycle thread",
        branch: "feature/v2",
        worktreePath: "/tmp/t3-v2-worktree",
      });
      const staleWorkspaceUpdate = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-lifecycle-stale-workspace"),
          threadId,
          branch: "feature/stale",
          worktreePath: "/tmp/stale-worktree",
          expectedWorktreePath: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleWorkspaceUpdate, OrchestratorDispatchError);
      const projectionAfterStaleWorkspaceUpdate = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projectionAfterStaleWorkspaceUpdate.thread.branch, "feature/v2");
      assert.equal(projectionAfterStaleWorkspaceUpdate.thread.worktreePath, "/tmp/t3-v2-worktree");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-runtime"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-interaction"),
        threadId,
        interactionMode: "plan",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("runtime-layer-lifecycle-model"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      });

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-lifecycle-settle"),
        threadId,
      });
      const settledProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(settledProjection.thread.settledOverride, "settled");
      assert.isNotNull(settledProjection.thread.settledAt);

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-lifecycle-unsettle-historical"),
        threadId,
        reason: "user",
      });
      const historicalSettledAt = "2025-11-02T03:04:05.000Z";
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-lifecycle-settle-historical"),
        threadId,
        settledAt: historicalSettledAt,
      });
      const historicalProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(historicalProjection.thread.settledAt);
      assert.equal(DateTime.formatIso(historicalProjection.thread.settledAt!), historicalSettledAt);
      assert.equal(DateTime.formatIso(historicalProjection.thread.updatedAt), historicalSettledAt);

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-lifecycle-unsettle"),
        threadId,
        reason: "user",
      });
      const activeProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(activeProjection.thread.settledOverride, "active");
      assert.isNull(activeProjection.thread.settledAt);

      const archive = yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-lifecycle-archive"),
        threadId,
      });
      const archivedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        archivedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.include(
        archivedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      const activeOnlyShell = yield* orchestrator.getShellSnapshot({ location: "active" });
      assert.notInclude(
        activeOnlyShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.lengthOf(activeOnlyShell.archivedThreads, 0);
      const archiveOnlyShell = yield* orchestrator.getShellSnapshot({ location: "archive" });
      assert.lengthOf(archiveOnlyShell.threads, 0);
      assert.include(
        archiveOnlyShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: archive.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: archive.sequence,
          location: "active",
          threadId,
        },
      );

      const remove = yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("runtime-layer-lifecycle-delete"),
        threadId,
      });
      const deletedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        deletedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.notInclude(
        deletedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: remove.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: remove.sequence,
          location: "active",
          threadId,
        },
      );

      // Deleting the thread closes its preview sessions; archiving keeps them.
      const sql = yield* SqlClient.SqlClient;
      const cleanupEffectIds = (yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE command_id IN (${"runtime-layer-lifecycle-archive"}, ${"runtime-layer-lifecycle-delete"})
      `).map((row) => row.effect_id);
      assert.include(cleanupEffectIds, "effect:runtime-layer-lifecycle-delete:preview.cleanup");
      assert.notInclude(cleanupEffectIds, "effect:runtime-layer-lifecycle-archive:preview.cleanup");

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed lifecycle thread");
      assert.equal(projection.thread.branch, "feature/v2");
      assert.equal(projection.thread.worktreePath, "/tmp/t3-v2-worktree");
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.equal(projection.thread.modelSelection.model, "gpt-5.5");
      assert.isNotNull(projection.thread.archivedAt);
      assert.isNotNull(projection.thread.deletedAt);
    }),
  );

  it.effect("persists rejected command receipts across retries", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("runtime-layer-rejected-command"),
        threadId: ThreadId.make("runtime-layer-missing-thread"),
      };

      const first = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      const retry = yield* orchestrator.dispatch(command).pipe(Effect.flip);

      assert.equal(first._tag, "OrchestratorProjectionError");
      assert.equal(retry._tag, "OrchestratorCommandPreviouslyRejectedError");
    }),
  );

  it.effect("persists Work inbox pin metadata and protects the main thread lifecycle", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-work-main-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-work-main-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-work-main-project"),
        title: "Main",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-work-main-metadata"),
        threadId,
        pinned: true,
        workInboxRole: "main",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.equal(projection.thread.workInboxRole, "main");
      assert.isNotNull(projection.thread.pinnedAt);
      assert.equal(shell?.workInboxRole, "main");
      assert.deepEqual(shell?.pinnedAt, projection.thread.pinnedAt);

      const settleError = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("runtime-layer-work-main-settle"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(settleError._tag, "OrchestratorDispatchError");
    }),
  );

  for (const action of ["answer", "dismiss", "reject-callback-dismiss"] as const) {
    it.effect(`handles V2 question action ${action} without a live session`, () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const sink = yield* EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`question-${action}`);
        const requestId = RuntimeRequestId.make(`request-${action}`);
        const nodeId = NodeId.make(`question-node-${action}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "mobile",
          commandId: CommandId.make(`question-create-${action}`),
          threadId,
          projectId: ProjectId.make("questions-project"),
          title: "Question",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/questions",
        });
        yield* sink.write({
          commandId: CommandId.make(`question-seed-${action}`),
          events: [
            {
              id: EventId.make(`request-event-${action}`),
              type: "runtime-request.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                kind: "user_input",
                status: "pending",
                responseMode: action === "reject-callback-dismiss" ? "callback" : "message",
                nativeRequestRef: { driver, nativeId: `async-${action}`, strength: "strong" },
                responseCapability: {
                  type: "live",
                  providerSessionId: ProviderSessionId.make("detached-session"),
                },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              id: EventId.make(`question-item-event-${action}`),
              type: "turn-item.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`question-item-${action}`),
                threadId,
                runId: null,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "user_input_request",
                requestId,
                questions: [{ id: "q", header: "Question", question: "Which spec?", options: [] }],
              },
            },
          ],
        });
        const command = {
          type: "runtime-request.respond" as const,
          commandId: CommandId.make(`question-respond-${action}`),
          threadId,
          requestId,
          ...(action === "answer"
            ? {
                answers: { q: "Use this spec" },
                attachmentsByQuestionId: {
                  // More than the old eight-attachment limit.
                  q: Array.from({ length: 9 }, (_, index) => ({
                    type: "file" as const,
                    id: index === 0 ? "spec_file" : `spec_file_${index}`,
                    name: index === 0 ? "spec.txt" : `spec-${index}.txt`,
                    mimeType: "text/plain",
                    sizeBytes: 4,
                  })),
                },
              }
            : { dismiss: true }),
        };
        if (action === "reject-callback-dismiss") {
          const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests[0]?.status,
            "pending",
          );
          return;
        }
        if (action === "answer") {
          // Answers share the message rule: up to 100 files, images up to 80 MiB in total.
          const image = {
            type: "image" as const,
            id: "budget_image",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 10 * 1024 * 1024,
          };
          const overCount = yield* orchestrator
            .dispatch({
              ...command,
              commandId: CommandId.make("question-respond-over-count"),
              attachmentsByQuestionId: {
                q: Array.from({ length: 101 }, () => ({
                  ...image,
                  type: "file" as const,
                  mimeType: "text/plain",
                  sizeBytes: 4,
                })),
              },
            })
            .pipe(Effect.flip);
          assert.include(String(overCount.cause), "up to 100");
          const overBudget = yield* orchestrator
            .dispatch({
              ...command,
              commandId: CommandId.make("question-respond-over-budget"),
              attachmentsByQuestionId: { q: Array.from({ length: 9 }, () => image) },
            })
            .pipe(Effect.flip);
          assert.include(String(overBudget.cause), "80 MiB");
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests[0]?.status,
            "pending",
          );
        }
        yield* orchestrator.dispatch(command);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          projection.runtimeRequests[0]?.status,
          action === "answer" ? "resolved" : "cancelled",
        );
        assert.equal(projection.messages.length, action === "answer" ? 1 : 0);
        if (action === "answer") {
          assert.include(projection.messages[0]!.text, "Which spec?\nUse this spec");
          assert.equal(projection.messages[0]!.attachments[0]?.name, "spec.txt");
          // The same command can be retried after a dropped response without sending twice.
          yield* orchestrator.dispatch(command);
          assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
        }
      }),
    );
  }

  it.effect("answers a native subagent's question while refusing messages to it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const parentId = ThreadId.make("runtime-native-child-parent");
      const childId = ThreadId.make("runtime-native-child");
      const requestId = RuntimeRequestId.make("runtime-native-child-request");
      const nodeId = NodeId.make("runtime-native-child-question-node");
      const itemId = TurnItemId.make("runtime-native-child-question-item");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-native-child-parent-create"),
        createdBy: "user",
        creationSource: "web",
        threadId: parentId,
        projectId: ProjectId.make("runtime-native-child-project"),
        title: "Native child parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const parent = yield* orchestrator.getThreadProjection(parentId);
      // A Codex native subagent asks an async (message-mode) question on its
      // own child thread, as CodexAdapterV2 writes it.
      yield* eventSink.write({
        commandId: CommandId.make("runtime-native-child-seed"),
        events: [
          {
            id: EventId.make("runtime-native-child-thread-event"),
            type: "thread.created",
            threadId: childId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...parent.thread,
              id: childId,
              title: "Native child",
              createdBy: "agent",
              creationSource: "provider",
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: parentId,
                relationshipToParent: "subagent",
                rootThreadId: parentId,
              },
              forkedFrom: { type: "node", nodeId: NodeId.make("runtime-native-child-subagent") },
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-native-child-question-node-event"),
            type: "node.updated",
            threadId: childId,
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId: childId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "user_input_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("runtime-native-child-question-request-event"),
            type: "runtime-request.updated",
            threadId: childId,
            nodeId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
          {
            id: EventId.make("runtime-native-child-question-item-event"),
            type: "turn-item.updated",
            threadId: childId,
            nodeId,
            occurredAt: now,
            payload: {
              id: itemId,
              type: "user_input_request",
              threadId: childId,
              runId: null,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "waiting",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              requestId,
              responseMode: "message",
              questions: [{ id: "scope", header: "Scope", question: "Which files?", options: [] }],
            },
          },
        ],
      });

      const refused = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("runtime-native-child-send"),
          createdBy: "user",
          creationSource: "web",
          threadId: childId,
          messageId: MessageId.make("runtime-native-child-send-message"),
          text: "Also check the tests.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorSubagentThreadReadOnlyError");
      assert.deepEqual((yield* orchestrator.getThreadProjection(childId)).messages, []);

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("runtime-native-child-answer"),
        threadId: childId,
        requestId,
        answers: { scope: "Only the adapters" },
      });
      const answered = yield* orchestrator.getThreadProjection(childId);
      assert.equal(answered.runtimeRequests[0]?.status, "resolved");
      assert.equal(answered.turnItems.find((item) => item.id === itemId)?.status, "completed");
      assert.deepEqual(
        answered.messages.map((message) => message.text),
        ["Which files?\nOnly the adapters"],
      );
    }),
  );

  it.effect("leaves an unanswered optional question out of the response message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("question-optional");
      const requestId = RuntimeRequestId.make("request-optional");
      const nodeId = NodeId.make("question-node-optional");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "mobile",
        commandId: CommandId.make("question-create-optional"),
        threadId,
        projectId: ProjectId.make("questions-project"),
        title: "Question",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/questions",
      });
      yield* sink.write({
        commandId: CommandId.make("question-seed-optional"),
        events: [
          {
            id: EventId.make("request-event-optional"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId,
              providerTurnId: null,
              kind: "user_input",
              status: "pending",
              responseMode: "message",
              nativeRequestRef: { driver, nativeId: "async-optional", strength: "strong" },
              responseCapability: {
                type: "live",
                providerSessionId: ProviderSessionId.make("detached-session"),
              },
              createdAt: now,
              resolvedAt: null,
            },
          },
          {
            id: EventId.make("question-item-event-optional"),
            type: "turn-item.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("question-item-optional"),
              threadId,
              runId: null,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "waiting",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "user_input_request",
              requestId,
              questions: [
                { id: "spec", header: "Question", question: "Which spec?", options: [] },
                {
                  id: "notes",
                  header: "Question",
                  question: "Anything else?",
                  options: [],
                  required: false,
                },
              ],
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("question-respond-optional"),
        threadId,
        requestId,
        answers: { spec: "Use this spec" },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.messages[0]?.text, "Which spec?\nUse this spec");
    }),
  );

  it.effect("persists active order in shells and clears it on re-entry", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("active-order-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "mobile",
        commandId: CommandId.make("active-order-create"),
        threadId,
        projectId: ProjectId.make("active-order-project"),
        title: "Order",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("active-order-set"),
        threadId,
        activeOrderKey: "n",
      });
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.activeOrderKey, "n");
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.activeOrderKey,
        "n",
      );
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("active-order-settle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("active-order-reopen"),
        threadId,
        reason: "user",
      });
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.activeOrderKey);
    }),
  );

  it.effect("carries pinOrderKey through pin, reorder, and unpin", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-pin-order-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pin-order-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-pin-order-project"),
        title: "Pinned",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      // Fresh pin places the thread with an order key in one command.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-pin-order-pin"),
        threadId,
        pinned: true,
        pinOrderKey: "m",
      });
      const pinned = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(pinned.thread.pinnedAt);
      assert.equal(pinned.thread.pinOrderKey, "m");
      const pinnedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.equal(pinnedShell?.pinOrderKey, "m");

      // A reorder carries only the key: pin state must be untouched, so a
      // reorder racing an unpin cannot silently re-pin the thread.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-pin-order-reorder"),
        threadId,
        pinOrderKey: "g",
      });
      const reordered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(reordered.thread.pinOrderKey, "g");
      assert.deepEqual(reordered.thread.pinnedAt, pinned.thread.pinnedAt);

      // Unpinning drops the arranged position with the pin: a later re-pin is a
      // fresh placement, not a resurrection of a slot the run has moved past.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-pin-order-unpin"),
        threadId,
        pinned: false,
      });
      const unpinned = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(unpinned.thread.pinnedAt ?? null);
      assert.isNull(unpinned.thread.pinOrderKey ?? null);
      const unpinnedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.isNull(unpinnedShell?.pinOrderKey ?? null);
    }),
  );

  it.effect("persists an in-place timeline clear boundary on the thread and shell", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-cleared-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-cleared-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-cleared-project"),
        title: "Cleared chat",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-clear-timeline"),
        threadId,
        clearTimeline: true,
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.isNotNull(projection.thread.timelineClearedAt);
      assert.deepEqual(shell?.timelineClearedAt, projection.thread.timelineClearedAt);
    }),
  );

  it.effect("keeps the auto-settle opt-out stamp until the user turns it back on", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-auto-settle-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-auto-settle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-auto-settle-project"),
        title: "Long-running",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const setAutoSettle = (id: string, autoSettle: boolean) =>
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(id),
          threadId,
          autoSettle,
        });
      const shellOf = Effect.map(orchestrator.getShellSnapshot(), (snapshot) =>
        snapshot.threads.find((candidate) => candidate.id === threadId),
      );

      yield* setAutoSettle("runtime-layer-auto-settle-off", false);
      const off = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(off.thread.autoSettleDisabledAt ?? null);
      assert.deepEqual((yield* shellOf)?.autoSettleDisabledAt, off.thread.autoSettleDisabledAt);

      // Re-sending the current choice keeps the original stamp and does not
      // bump updatedAt, so duplicates never churn ordering.
      yield* setAutoSettle("runtime-layer-auto-settle-off-again", false);
      const again = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(again.thread.autoSettleDisabledAt, off.thread.autoSettleDisabledAt);
      assert.deepEqual(again.thread.updatedAt, off.thread.updatedAt);

      yield* setAutoSettle("runtime-layer-auto-settle-on", true);
      const on = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(on.thread.autoSettleDisabledAt ?? null);
      assert.isNull((yield* shellOf)?.autoSettleDisabledAt ?? null);
    }),
  );

  it.effect("consumes a restart marker atomically and never dispatches it twice", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const threadId = ThreadId.make("restart-continuation-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("restart-create"),
        threadId,
        projectId: ProjectId.make("restart-project"),
        title: "Restart",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/restart-test",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-original"),
        threadId,
        messageId: MessageId.make("restart-original"),
        createdBy: "user",
        creationSource: "web",
        text: "Work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      )!;
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: CommandId.make("restart-started"),
        events: [
          {
            id: EventId.make("restart-run-started"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("restart-native-reference"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...providerThread,
              nativeThreadRef: { driver, nativeId: "saved-provider-thread", strength: "strong" },
            },
          },
        ],
      });
      const messageId = MessageId.make("restart-recovery-message");
      yield* orchestrator.dispatch({
        type: "run.restart-continuation.prepare",
        commandId: CommandId.make("restart-prepare"),
        threadId,
        runId: run.id,
        messageId,
        reason: "restart",
      });
      const marked = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      assert.equal(marked.restartContinuation?.status, "pending");
      yield* sink.write({
        commandId: CommandId.make("restart-process-loss"),
        events: [
          {
            id: EventId.make("restart-run-cancelled"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...marked, status: "cancelled", completedAt: now },
          },
        ],
      });
      const command = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("restart-recovery"),
        threadId,
        messageId,
        text: "Continue",
        attachments: [],
        createdBy: "agent" as const,
        creationSource: "server" as const,
        restartContinuation: { sourceRunId: run.id },
        dispatchMode: { type: "start_immediately" as const },
      };
      yield* orchestrator.dispatch(command);
      yield* orchestrator.dispatch(command);
      const resumed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(resumed.runs.length, 2);
      assert.equal(resumed.runs[0]?.restartContinuation?.status, "consumed");
      assert.equal(
        resumed.messages.find((message) => message.id === messageId)?.restartContinuation,
        true,
      );
      assert.equal(resumed.runs[1]?.providerThreadId, providerThread.id);
      const rejected = yield* orchestrator
        .dispatch({
          ...command,
          commandId: CommandId.make("restart-duplicate"),
          messageId: MessageId.make("restart-other-message"),
        })
        .pipe(Effect.flip);
      assert.equal(rejected._tag, "OrchestratorDispatchError");
      const nextRun = resumed.runs[1]!;
      yield* sink.write({
        commandId: CommandId.make("restart-next-running"),
        events: [
          {
            id: EventId.make("restart-next-running-event"),
            type: "run.updated",
            threadId,
            runId: nextRun.id,
            occurredAt: now,
            payload: { ...nextRun, status: "running" },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "run.restart-continuation.prepare",
        commandId: CommandId.make("restart-next-prepare"),
        threadId,
        runId: nextRun.id,
        messageId: MessageId.make("restart-next-message"),
        reason: "restart",
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("restart-archive"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("restart-unarchive"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.restartContinuation?.status,
        "cancelled",
      );
      yield* orchestrator.dispatch({
        type: "run.restart-continuation.prepare",
        commandId: CommandId.make("restart-branch-prepare"),
        threadId,
        runId: nextRun.id,
        messageId: MessageId.make("restart-branch-message"),
        reason: "restart",
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("restart-change-branch"),
        threadId,
        branch: "different",
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.restartContinuation?.status,
        "cancelled",
      );
      yield* orchestrator.dispatch({
        type: "run.restart-continuation.prepare",
        commandId: CommandId.make("restart-stop-prepare"),
        threadId,
        runId: nextRun.id,
        messageId: MessageId.make("restart-stop-message"),
        reason: "restart",
      });
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("restart-explicit-stop"),
        threadId,
        runId: nextRun.id,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.restartContinuation?.status,
        "cancelled",
      );
    }),
  );

  it.effect("rejects stale automatic settlement and preserves its activity timestamp", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-auto-settle-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-auto-settle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-auto-settle-project"),
        title: "Auto settle",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const nodeId = NodeId.make("auto-settle-question-node");
      const blocking = {
        id: RuntimeRequestId.make("auto-settle-blocking"),
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input" as const,
        status: "pending" as const,
        responseMode: "callback" as const,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("auto-settle-session"),
        },
        createdAt: now,
        resolvedAt: null,
      };
      yield* sink.write({
        commandId: CommandId.make("auto-settle-request-seed"),
        events: [
          {
            id: EventId.make("auto-settle-blocking-event"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: blocking,
          },
          {
            id: EventId.make("auto-settle-message-event"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              ...blocking,
              id: RuntimeRequestId.make("auto-settle-message"),
              responseMode: "message",
              createdAt: DateTime.add(now, { seconds: 1 }),
            },
          },
        ],
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pendingRuntimeRequest?.id,
        blocking.id,
      );
      yield* sink.write({
        commandId: CommandId.make("auto-settle-request-resolve"),
        events: [
          {
            id: EventId.make("auto-settle-resolved-event"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: { ...blocking, status: "resolved", resolvedAt: now },
          },
        ],
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pendingRuntimeRequest?.responseMode,
        "message",
      );
      const sequence = yield* orchestrator.getThreadEventSequence(threadId);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-auto-settle-edit"),
        threadId,
        title: "Changed",
      });
      const stale = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("runtime-layer-auto-settle-stale"),
          threadId,
          automatic: { expectedSequence: sequence },
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "OrchestratorDispatchError");
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-auto-settle-pin"),
        threadId,
        pinned: true,
      });
      const settledAt = DateTime.formatIso(
        (yield* orchestrator.getThreadProjection(threadId)).thread.createdAt,
      );
      yield* TestClock.adjust("1 minute");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-auto-settle-fresh"),
        threadId,
        automatic: { expectedSequence: yield* orchestrator.getThreadEventSequence(threadId) },
        settledAt,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.isNotNull(projection.thread.pinnedAt);
      assert.equal(DateTime.formatIso(projection.thread.settledAt!), settledAt);
      assert.equal(DateTime.formatIso(projection.thread.updatedAt), settledAt);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-auto-settle-resume"),
        threadId,
        reason: "user",
      });
      const pinned = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("runtime-layer-auto-settle-active"),
          threadId,
          automatic: { expectedSequence: yield* orchestrator.getThreadEventSequence(threadId) },
        })
        .pipe(Effect.flip);
      assert.equal(pinned._tag, "OrchestratorDispatchError");
    }),
  );

  it.effect("records the real settle time and guards automatic deletion", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-auto-delete-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-auto-delete-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-auto-delete-project"),
        title: "Auto delete",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* TestClock.adjust("10 days");
      const settledAt = "1970-01-01T00:00:00.000Z";
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-auto-delete-settle"),
        threadId,
        settledAt,
      });
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.equal(DateTime.formatIso(shell!.settledAt!), settledAt);
      assert.equal(
        DateTime.formatIso(shell!.settledRecordedAt!),
        DateTime.formatIso(yield* DateTime.now),
      );

      const sequence = yield* orchestrator.getThreadEventSequence(threadId);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-auto-delete-edit"),
        threadId,
        title: "Changed",
      });
      const stale = yield* orchestrator
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make("runtime-layer-auto-delete-stale"),
          threadId,
          automatic: { expectedSequence: sequence },
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "OrchestratorDispatchError");
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.deletedAt);

      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("runtime-layer-auto-delete-fresh"),
        threadId,
        automatic: { expectedSequence: yield* orchestrator.getThreadEventSequence(threadId) },
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.deletedAt);
    }),
  );

  it.effect("rejects settling a thread while a run is active", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-active-settle-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-active-settle-project"),
        title: "Active settle",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-active-settle",
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-active-settle-initial"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-active-settle-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const error = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("runtime-layer-active-settle"),
          threadId,
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "OrchestratorDispatchError");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.isNull(projection.thread.settledOverride);
      assert.isNull(projection.thread.settledAt);
    }),
  );

  it.effect("settles past held automatic runs but not held user messages", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-settle-automatic-queued");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-create"),
        threadId,
        projectId: ProjectId.make("settle-automatic-project"),
        title: "Settle automatic queued",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-automatic",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-active"),
        threadId,
        messageId: MessageId.make("settle-automatic-active"),
        text: "Active",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      // This server never dispatches notification wakes itself, so the
      // automatic message is queued plainly and marked as a notification when
      // the restart below is simulated.
      const automaticMessageIds = new Set<string>();
      const queueMessage = (id: string, automatic: boolean) => {
        if (automatic) automaticMessageIds.add(id);
        return orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: automatic ? "agent" : "user",
          creationSource: automatic ? "provider" : "web",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: id,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
      };
      yield* queueMessage("settle-automatic-notification", true);

      // Simulate a restart: the active run ends and recovery holds the queue.
      const holdQueueAfterRestart = (commandId: string) =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const now = yield* DateTime.now;
          yield* eventSink.commitCommand({
            commandId: CommandId.make(commandId),
            threadId,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events: [
              ...projection.runs
                .filter((run) => run.status === "starting" || run.status === "queued")
                .map((run) => ({
                  id: EventId.make(`${commandId}:${run.id}`),
                  type: "run.updated" as const,
                  threadId,
                  runId: run.id,
                  occurredAt: now,
                  payload:
                    run.status === "queued"
                      ? { ...run, queueHeld: true }
                      : { ...run, status: "cancelled" as const, completedAt: now },
                })),
              ...projection.messages
                .filter(
                  (message) =>
                    automaticMessageIds.has(message.id) && message.notification === undefined,
                )
                .map((message) => ({
                  id: EventId.make(`${commandId}:${message.id}`),
                  type: "message.updated" as const,
                  threadId,
                  occurredAt: now,
                  payload: {
                    ...message,
                    notification: {
                      source: { kind: "background_task" as const },
                      outcome: "updated" as const,
                      summary: "Background activity updated",
                    },
                  },
                })),
            ],
            effects: [],
          });
        });
      yield* holdQueueAfterRestart("settle-automatic-restart");

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle-automatic-settle"),
        threadId,
      });
      const settled = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(settled.thread.settledAt);
      assert.isTrue(settled.runs.every((run) => run.status === "cancelled"));

      // A held message the user typed still blocks settling.
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("settle-automatic-unsettle"),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-active-2"),
        threadId,
        messageId: MessageId.make("settle-automatic-active-2"),
        text: "Active again",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* queueMessage("settle-automatic-user-queued", false);
      yield* holdQueueAfterRestart("settle-automatic-restart-2");
      const error = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-automatic-settle-2"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
    }),
  );

  it.effect("cancels queued work when a thread is archived", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-archive-queued-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-archive-queued-project"),
        title: "Archive queued work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-archive-queued",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-archive-queued-active-message"),
        text: "Keep the provider occupied.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-next-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-archive-queued-next-message"),
        text: "Do not run this after archive.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const beforeArchive = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = beforeArchive.runs.find((run) => run.status === "starting");
      const queuedRun = beforeArchive.runs.find((run) => run.status === "queued");
      assert.isDefined(activeRun);
      assert.isDefined(queuedRun);

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-archive-queued-archive"),
        threadId,
      });

      const archived = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(archived.thread.archivedAt);
      assert.equal(archived.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
      assert.equal(
        archived.attempts.find((attempt) => attempt.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.equal(archived.nodes.find((node) => node.runId === queuedRun.id)?.status, "cancelled");
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);

      const promoteError = yield* orchestrator
        .dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("runtime-layer-archive-queued-promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: activeRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(promoteError._tag, "OrchestratorDispatchError");

      const afterPromotion = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterPromotion.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
    }),
  );

  it.effect("promotes only one queued run after each terminal run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-serialized-queue-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-serialized-queue-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-serialized-queue-project"),
        title: "Serialized queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-serialized-queue-active"),
        threadId,
        messageId: MessageId.make("runtime-layer-serialized-queue-active"),
        text: "Active",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-serialized-queue-first"),
        threadId,
        messageId: MessageId.make("runtime-layer-serialized-queue-first"),
        text: "First queued",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-serialized-queue-second"),
        threadId,
        messageId: MessageId.make("runtime-layer-serialized-queue-second"),
        text: "Second queued",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs.find((run) => run.status === "starting");
      const queuedRuns = before.runs
        .filter((run) => run.status === "queued")
        .toSorted((left, right) => left.ordinal - right.ordinal);
      const firstQueuedRun = queuedRuns[0];
      const secondQueuedRun = queuedRuns[1];
      assert.isDefined(activeRun);
      assert.isDefined(firstQueuedRun);
      assert.isDefined(secondQueuedRun);
      assert.isFalse(
        before.turnItems.some(
          (item) =>
            item.type === "user_message" &&
            (item.messageId === firstQueuedRun.userMessageId ||
              item.messageId === secondQueuedRun.userMessageId),
        ),
        "queued messages must not exist as turn items before dispatch",
      );

      const promotedRunIds = yield* Queue.unbounded<RunId>();
      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting"
            ? Queue.offer(promotedRunIds, stored.event.payload.id)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const activeCompletedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("runtime-layer-serialized-queue-active-completed"),
            type: "run.updated",
            threadId,
            runId: activeRun.id,
            ...(activeRun.rootNodeId === null ? {} : { nodeId: activeRun.rootNodeId }),
            providerInstanceId: activeRun.providerInstanceId,
            occurredAt: activeCompletedAt,
            payload: {
              ...activeRun,
              status: "completed",
              completedAt: activeCompletedAt,
            },
          },
        ],
      });

      assert.equal(yield* Queue.take(promotedRunIds), firstQueuedRun.id);
      const afterFirstPromotion = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
        "starting",
      );
      assert.equal(
        afterFirstPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
        "queued",
      );
      const promotedMessageItem = afterFirstPromotion.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === firstQueuedRun.userMessageId,
      );
      assert.isDefined(promotedMessageItem);
      if (promotedMessageItem.type !== "user_message") {
        assert.fail("promoted queue item must be a user message");
      }
      assert.equal(promotedMessageItem.inputIntent, "queued_turn");
      assert.isTrue(
        promotedMessageItem.startedAt !== null &&
          DateTime.toEpochMillis(promotedMessageItem.startedAt) >=
            DateTime.toEpochMillis(activeCompletedAt),
      );

      const promotedFirst = afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id);
      assert.isDefined(promotedFirst);
      const firstCompletedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("runtime-layer-serialized-queue-first-completed"),
            type: "run.updated",
            threadId,
            runId: promotedFirst.id,
            ...(promotedFirst.rootNodeId === null ? {} : { nodeId: promotedFirst.rootNodeId }),
            providerInstanceId: promotedFirst.providerInstanceId,
            occurredAt: firstCompletedAt,
            payload: {
              ...promotedFirst,
              status: "completed",
              completedAt: firstCompletedAt,
            },
          },
        ],
      });

      assert.equal(yield* Queue.take(promotedRunIds), secondQueuedRun.id);
      const afterSecondPromotion = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterSecondPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
        "completed",
      );
      assert.equal(
        afterSecondPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
        "starting",
      );
    }),
  );

  it.effect.each(["usage_limit", "provider_error"] as const)(
    "handles a queued message after a %s failure",
    (failureClass) =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const eventSink = yield* EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-failed-queue-${failureClass}`);

        // The terminal-run reactor handles events one at a time in write
        // order. A sentinel thread's queue promotion written after the failure
        // proves the failure was handled, since a usage limit emits nothing.
        const sentinelThreadId = ThreadId.make(`${threadId}:sentinel`);
        for (const id of [threadId, sentinelThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${id}:create`),
            threadId: id,
            projectId: ProjectId.make(`${id}:project`),
            title: "Failed queue",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: process.cwd(),
          });
          for (const index of [0, 1]) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`${id}:message:${index}`),
              threadId: id,
              messageId: MessageId.make(`${id}:message:${index}`),
              text: index === 0 ? "Active" : "Queued",
              attachments: [],
              modelSelection,
              dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
            });
          }
        }

        const before = yield* orchestrator.getThreadProjection(threadId);
        const activeRun = before.runs.find((run) => run.status === "starting");
        const queuedRun = before.runs.find((run) => run.status === "queued");
        assert.isDefined(activeRun);
        assert.isDefined(queuedRun);
        assert.isNotNull(activeRun.rootNodeId);

        const promotedRunIds = yield* Queue.unbounded<RunId>();
        const heldRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type !== "run.updated"
              ? Effect.void
              : stored.event.payload.status === "starting"
                ? Queue.offer(promotedRunIds, stored.event.payload.id)
                : stored.event.payload.queueHeld === true
                  ? Queue.offer(heldRunIds, stored.event.payload.id)
                  : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:error`),
              type: "turn-item.updated",
              threadId,
              runId: activeRun.id,
              nodeId: activeRun.rootNodeId,
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${threadId}:error`),
                type: "error",
                threadId,
                runId: activeRun.id,
                nodeId: activeRun.rootNodeId,
                providerThreadId: activeRun.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed",
                title: "Provider failure",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: failureClass,
                  message: "Provider failed.",
                  code: "provider_failed",
                  retryable: null,
                  ...(failureClass === "usage_limit"
                    ? { resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })) }
                    : {}),
                },
              },
            },
            {
              id: EventId.make(`${threadId}:failed`),
              type: "run.updated",
              threadId,
              runId: activeRun.id,
              nodeId: activeRun.rootNodeId,
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: now,
              payload: { ...activeRun, status: "failed", completedAt: now },
            },
          ],
        });

        if (failureClass === "provider_error") {
          assert.equal(yield* Queue.take(heldRunIds), queuedRun.id);
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(held.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });
          assert.equal(yield* Queue.take(promotedRunIds), queuedRun.id);
          return;
        }
        const sentinel = yield* orchestrator.getThreadProjection(sentinelThreadId);
        const sentinelActive = sentinel.runs.find((run) => run.status === "starting");
        const sentinelQueued = sentinel.runs.find((run) => run.status === "queued");
        assert.isDefined(sentinelActive);
        assert.isDefined(sentinelQueued);
        const sentinelPromoted = yield* Queue.unbounded<RunId>();
        const sentinelSequence = yield* orchestrator.getThreadEventSequence(sentinelThreadId);
        yield* eventSink
          .stream({ threadId: sentinelThreadId, afterSequence: sentinelSequence })
          .pipe(
            Stream.runForEach((stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "starting"
                ? Queue.offer(sentinelPromoted, stored.event.payload.id)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
        yield* Effect.yieldNow;
        const sentinelCompletedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${sentinelThreadId}:completed`),
              type: "run.updated",
              threadId: sentinelThreadId,
              runId: sentinelActive.id,
              providerInstanceId: sentinelActive.providerInstanceId,
              occurredAt: sentinelCompletedAt,
              payload: { ...sentinelActive, status: "completed", completedAt: sentinelCompletedAt },
            },
          ],
        });
        assert.equal(yield* Queue.take(sentinelPromoted), sentinelQueued.id);

        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
        // Not held: the limit alone parks it, so it runs once a continuation
        // finishes instead of waiting for a manual resume.
        assert.notEqual(after.runs.find((run) => run.id === queuedRun.id)?.queueHeld, true);
        assert.isFalse(after.turnItems.some((item) => item.runId === queuedRun.id));
        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        );
        assert.equal(shell?.latestRunId, activeRun.id);
        assert.equal(shell?.status, "failed");
        assert.equal(shell?.lastErrorClass, "usage_limit");
      }),
  );

  it.effect("holds a queue across restart and drains it only once resumed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-queue-hold-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queue-hold-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-queue-hold-project"),
        title: "Hold the queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-queue-hold",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queue-hold-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queue-hold-active-message"),
        text: "Keep the provider occupied.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queue-hold-queued-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queue-hold-queued-message"),
        text: "Run this next.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = before.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);
      const activeRun = before.runs.find((run) => run.id !== queuedRun.id);
      assert.isDefined(activeRun);

      // Stand in for restart recovery: hold the queue, then finish the run that
      // was occupying the provider so only the hold can keep the queue parked.
      const heldAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("runtime-layer-queue-hold-held"),
            type: "run.updated",
            threadId,
            runId: queuedRun.id,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: heldAt,
            payload: { ...queuedRun, queueHeld: true },
          },
          {
            id: EventId.make("runtime-layer-queue-hold-active-completed"),
            type: "run.updated",
            threadId,
            runId: activeRun.id,
            ...(activeRun.rootNodeId === null ? {} : { nodeId: activeRun.rootNodeId }),
            providerInstanceId: activeRun.providerInstanceId,
            occurredAt: heldAt,
            payload: { ...activeRun, status: "completed", completedAt: heldAt },
          },
        ],
      });

      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
      const stillHeld = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stillHeld.runs.find((run) => run.id === queuedRun.id)?.status, "queued");

      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("runtime-layer-queue-hold-resume"),
        threadId,
      });

      const afterResume = yield* orchestrator.getThreadProjection(threadId);
      const resumedRun = afterResume.runs.find((run) => run.id === queuedRun.id);
      assert.equal(resumedRun?.queueHeld ?? false, false);
      // Resuming is what starts the head; the user does not have to send again.
      assert.equal(resumedRun?.status, "starting");
    }),
  );

  it.effect("edits and removes queued runs", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-queued-edit-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-queued-edit-project"),
        title: "Edit queued work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-queued-edit",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-active-message"),
        text: "Keep the provider occupied.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-queued-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-queued-message"),
        text: "Original queued text.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = before.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-edit"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text.",
      });

      const afterEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterEdit.messages.find((message) => message.id === queuedRun.userMessageId)?.text,
        "Updated queued text.",
      );
      const editedItem = afterEdit.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === queuedRun.userMessageId,
      );
      assert.isUndefined(editedItem, "editing queue state must not create a timeline turn item");

      const emptyEditError = yield* orchestrator
        .dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("runtime-layer-queued-edit-empty"),
          threadId,
          runId: queuedRun.id,
          text: "   ",
        })
        .pipe(Effect.flip);
      assert.equal(emptyEditError._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("runtime-layer-queued-edit-cancel"),
        threadId,
        runId: queuedRun.id,
      });

      const afterCancel = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterCancel.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
      assert.equal(
        afterCancel.attempts.find((attempt) => attempt.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.equal(
        afterCancel.nodes.find((node) => node.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.isFalse(
        afterCancel.visibleTurnItems.some(
          (row) => row.item.type === "user_message" && row.item.runId === queuedRun.id,
        ),
        "removed queued message must not surface as a transcript row",
      );
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);

      const cancelAgainError = yield* orchestrator
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("runtime-layer-queued-edit-cancel-again"),
          threadId,
          runId: queuedRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(cancelAgainError._tag, "OrchestratorDispatchError");
    }),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("pending provider interruption", (it) => {
  it.effect("interrupts a pending provider start without launching provider work", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const orchestrator = yield* OrchestratorV2;
      const threadManagement = yield* ThreadManagementService;
      const effectWorker = yield* OrchestrationEffectWorkerV2;
      const projectId = ProjectId.make("runtime-layer-pending-interrupt-project");
      const threadId = ThreadId.make("runtime-layer-pending-interrupt-thread");

      yield* applicationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make("runtime-layer-pending-interrupt-project-create"),
        projectId,
        title: "Pending interrupt project",
        workspaceRoot: "/tmp/runtime-layer-pending-interrupt-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-06-22T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-create"),
        threadId,
        projectId,
        title: "Pending interrupt",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-pending-interrupt-message"),
        text: "Do not reach the provider.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const starting = yield* orchestrator.getThreadProjection(threadId);
      const run = starting.runs[0];
      assert.isDefined(run);
      assert.equal(run.status, "starting");

      const interrupt = yield* threadManagement.interruptThread({
        projectId,
        commandId: CommandId.make("runtime-layer-pending-interrupt-command"),
        threadId,
        runId: run.id,
        reason: "Cancelled before provider start",
      });
      assert.equal(interrupt.type, "interrupt_requested");

      const interrupted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(interrupted.runs[0]?.status, "interrupted");
      assert.equal(interrupted.attempts[0]?.status, "interrupted");
      assert.equal(
        interrupted.nodes.find((node) => node.kind === "root_turn")?.status,
        "interrupted",
      );
      assert.deepEqual(
        interrupted.turnItems.filter((item) => item.runId === run.id).map((item) => item.type),
        ["user_message", "run_interrupt_request", "run_interrupt_result"],
      );
      assert.deepEqual(interrupted.providerTurns, []);
      assert.isFalse(yield* effectWorker.runOnce);
    }),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("snooze projection", (it) => {
  it.effect("carries snooze state through the V2 shell projection", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const orchestrator = yield* OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-snoozed-project");
      const threadId = ThreadId.make("runtime-layer-snoozed-thread");
      const snoozedUntil = "2099-07-25T09:00:00.000Z";

      yield* applicationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make("runtime-layer-snoozed-project-create"),
        projectId,
        title: "Snoozed shell projection",
        workspaceRoot: "/tmp/runtime-layer-snoozed-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-thread-create"),
        threadId,
        projectId,
        title: "Snoozed thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze"),
        threadId,
        snoozedUntil,
      });

      const firstProjection = yield* orchestrator.getThreadProjection(threadId);
      const firstSnoozedAt = firstProjection.thread.snoozedAt;
      const firstUpdatedAt = firstProjection.thread.updatedAt;
      assert.isNotNull(firstSnoozedAt);

      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-again"),
        threadId,
        snoozedUntil,
      });

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
      assert.deepEqual(thread.snoozedAt, firstSnoozedAt);
      assert.deepEqual(thread.updatedAt, firstUpdatedAt);

      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-wake"),
        threadId,
        reason: "user",
      });
      const woken = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(woken.thread.lastSnoozeWakeAt, yield* DateTime.now);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-after-wake"),
        threadId,
        snoozedUntil,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-snoozed-message"),
        text: "Wake this thread.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const awakened = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awakened.thread.snoozedUntil);
      assert.isNull(awakened.thread.snoozedAt);
    }),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("visited projection", (it) => {
  it.effect("carries the visited watermark through the V2 shell projection", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const orchestrator = yield* OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-visited-project");
      const threadId = ThreadId.make("runtime-layer-visited-thread");
      const visitedAt = "2026-07-24T01:00:00.000Z";

      yield* applicationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make("runtime-layer-visited-project-create"),
        projectId,
        title: "Visited shell projection",
        workspaceRoot: "/tmp/runtime-layer-visited-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-visited-thread-create"),
        threadId,
        projectId,
        title: "Visited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const created = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(created.thread.lastVisitedAt);
      const createdUpdatedAt = created.thread.updatedAt;

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit"),
        threadId,
        visitedAt,
      });
      const visited = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(visited.thread.lastVisitedAt);
      assert.equal(DateTime.formatIso(visited.thread.lastVisitedAt!), visitedAt);
      // Visiting records read state, not activity: updatedAt must not move.
      assert.deepEqual(visited.thread.updatedAt, createdUpdatedAt);

      // Monotonic: an older watermark (a replay or a stale device) cannot
      // rewind the marker.
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit-stale"),
        threadId,
        visitedAt: "2026-07-24T00:30:00.000Z",
      });
      const afterStaleVisit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(DateTime.formatIso(afterStaleVisit.thread.lastVisitedAt!), visitedAt);

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread!.lastVisitedAt!), visitedAt);
      assert.deepEqual(thread!.updatedAt, createdUpdatedAt);

      // No completed run yet → nothing to mark unread against.
      const markUnread = yield* orchestrator
        .dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make("runtime-layer-visited-thread-mark-unread"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(markUnread, OrchestratorDispatchError);
    }),
  );

  it.effect("decides a visit from the thread row without reading the transcript", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const orchestrator = yield* OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-visit-reads-project");
      const threadId = ThreadId.make("runtime-layer-visit-reads-thread");
      const visitedAt = "2026-07-24T01:00:00.000Z";

      yield* applicationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make("runtime-layer-visit-reads-project-create"),
        projectId,
        title: "Visit reads",
        workspaceRoot: "/tmp/runtime-layer-visit-reads-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-07-24T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-visit-reads-thread-create"),
        threadId,
        projectId,
        title: "Visit reads thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

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
      yield* orchestrator
        .dispatch({
          type: "thread.visit",
          commandId: CommandId.make("runtime-layer-visit-reads-thread-visit"),
          threadId,
          visitedAt,
        })
        .pipe(Effect.withTracer(tracer));

      assert.isNotEmpty(statements);
      for (const table of [
        "orchestration_v2_projection_messages",
        "orchestration_v2_projection_turn_items",
        "orchestration_v2_projection_runs",
      ]) {
        assert.isFalse(
          statements.some((statement) => statement.includes(`FROM ${table}`)),
          `thread.visit read ${table}`,
        );
      }
      const visited = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(DateTime.formatIso(visited.thread.lastVisitedAt!), visitedAt);
    }),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("permanent provider start failure", (it) => {
  it.effect("terminalizes a provider turn that permanently fails to start", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const orchestrator = yield* OrchestratorV2;
      const effectWorker = yield* OrchestrationEffectWorkerV2;
      const projectId = ProjectId.make("runtime-layer-permanent-start-failure-project");
      const threadId = ThreadId.make("runtime-layer-permanent-start-failure-thread");

      yield* applicationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make("runtime-layer-permanent-start-failure-project-create"),
        projectId,
        title: "Permanent start failure",
        workspaceRoot: "/tmp/runtime-layer-permanent-start-failure-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-07-25T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-permanent-start-failure-create"),
        threadId,
        projectId,
        title: "Permanent start failure",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-permanent-start-failure-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-permanent-start-failure-message"),
        text: "Hello",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0];
      assert.isDefined(run);
      if (run === undefined) return;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.isTrue(yield* effectWorker.runOnce);
        yield* TestClock.adjust("2 seconds");
      }

      const after = yield* orchestrator.getThreadProjection(threadId);
      const failedRun = after.runs.find((candidate) => candidate.id === run.id);
      const failedAttempt = after.attempts.find(
        (candidate) => candidate.id === run.activeAttemptId,
      );
      const failedRootNode = after.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const errorItem = after.turnItems.find(
        (candidate) => candidate.runId === run.id && candidate.type === "error",
      );

      assert.equal(failedRun?.status, "failed");
      assert.isNotNull(failedRun?.completedAt);
      assert.equal(failedAttempt?.status, "failed");
      assert.equal(failedRootNode?.status, "failed");
      assert.equal(errorItem?.status, "failed");
      if (errorItem?.type === "error") {
        assert.equal(errorItem.failure.code, "provider_turn_start_failed");
        // The reason the attempts gave up, not a guess about the transport.
        assert.equal(errorItem.failure.message, "sessions are not used by lifecycle tests");
        assert.equal(errorItem.failure.class, "provider_error");
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it.layer(SharedApplicationDataPlaneTestLayer)("shared application data plane", (it) => {
  it.effect("orders retained project transactions and V2 thread transactions in one source", () =>
    Effect.gen(function* () {
      const applicationEngine = yield* OrchestrationEngineService;
      const applicationEvents = yield* OrchestrationEventStore;
      const orchestrator = yield* OrchestratorV2;
      const projectionSnapshot = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("runtime-layer-shared-project");
      const threadId = ThreadId.make("runtime-layer-shared-thread");
      const projectCommand = {
        type: "project.create" as const,
        commandId: CommandId.make("runtime-layer-shared-project-create"),
        projectId,
        title: "Shared application source",
        workspaceRoot: "/tmp/runtime-layer-shared-project",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: "2026-06-20T00:00:00.000Z",
      };

      const projectResult = yield* applicationEngine.dispatch(projectCommand);
      const projectRetry = yield* applicationEngine.dispatch(projectCommand);
      assert.equal(projectRetry.sequence, projectResult.sequence);

      const delivered = yield* Queue.unbounded<ApplicationStoredEvent>();
      yield* applicationEvents.streamApplicationEvents().pipe(
        Stream.take(2),
        Stream.runForEach((event) => Queue.offer(delivered, event)),
        Effect.forkScoped,
      );

      const projectEvent = yield* Queue.take(delivered);
      assert.equal(projectEvent.sequence, projectResult.sequence);

      const threadResult = yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-shared-thread-create"),
        threadId,
        projectId,
        title: "Shared thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const threadEvent = yield* Queue.take(delivered);

      assert.equal(threadEvent.sequence, threadResult.sequence);
      assert.isAbove(threadEvent.sequence, projectEvent.sequence);
      assert.isTrue("aggregateKind" in projectEvent);
      assert.isTrue("event" in threadEvent);
      assert.equal((yield* projectionSnapshot.getProjectShellById(projectId))._tag, "Some");

      const retainedReceipts = yield* sql<{
        readonly aggregate_kind: string;
        readonly aggregate_id: string;
      }>`
        SELECT aggregate_kind, aggregate_id
        FROM orchestration_command_receipts
        ORDER BY result_sequence ASC
      `;
      assert.deepEqual(retainedReceipts, [
        { aggregate_kind: "project", aggregate_id: projectId },
        { aggregate_kind: "thread", aggregate_id: threadId },
      ]);

      const retiredWrites = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_events) +
          (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS count
      `;
      assert.equal(retiredWrites[0]?.count, 0);
    }),
  );
});

it.layer(TestLayer)("V2 pull request metadata", (it) => {
  it.effect(
    "persists host snapshots without creating activity and rejects stale stack anchors",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const threadId = ThreadId.make("runtime-pr-sync");
        const projectId = ProjectId.make("runtime-pr-project");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("runtime-pr-create"),
          threadId,
          projectId,
          title: "PR metadata",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/pr",
          worktreePath: null,
        });
        const reference = {
          projectId,
          repository: "org/repo",
          number: 1,
          url: "https://github.com/org/repo/pull/1",
        };
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-pr-link"),
          threadId,
          linkPullRequest: reference,
          linkPullRequestSource: "agent",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const anchor = before.thread.pullRequests![0]!;
        yield* TestClock.adjust("1 minute");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-pr-sync"),
          threadId,
          syncPullRequest: {
            reference: anchor,
            stack: null,
            snapshot: {
              state: "open",
              title: "Live title",
              headBranch: "feature/pr",
              baseBranch: "main",
              isDraft: true,
              updatedAt: "2026-09-11T00:00:00.000Z",
              syncedAt: "2026-09-11T00:00:00.000Z",
            },
          },
        });
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(after.thread.updatedAt, before.thread.updatedAt);
        assert.equal(after.thread.pullRequests?.[0]?.snapshot?.title, "Live title");
        assert.equal(
          (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.snapshot?.isDraft,
          true,
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-pr-unlink"),
          threadId,
          unlinkPullRequest: reference,
        });
        const error = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("runtime-pr-stale-stack"),
            threadId,
            linkPullRequest: { ...reference, number: 2, url: "https://github.com/org/repo/pull/2" },
            linkPullRequestSource: "stack",
            expectedPullRequestLink: anchor,
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, OrchestratorDispatchError);
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).thread.linkedPullRequests,
          [],
        );
        const staleBranch = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("runtime-pr-stale-branch"),
            threadId,
            branchPullRequest: reference,
            expectedBranch: "different-branch",
          })
          .pipe(Effect.flip);
        assert.instanceOf(staleBranch, OrchestratorDispatchError);
      }),
  );
});

it.layer(TestLayer)("usage-limit recovery", (it) => {
  it.effect.each([
    "resume",
    "queued-resume",
    "cancel",
    "rearm",
    "snooze-race",
    "new-message",
    "archive",
    "settle",
    "replacement",
    "manual-snooze",
    "manual-snooze-after-recovery",
    "invalid-snooze",
    "snooze-only",
    "snooze-resume",
    "cancel-resume-keep-snooze",
    "wake-preserve-resume",
    "independent-patches",
    "expired-snooze",
    "wake",
  ] as const)("guards a scheduled usage-limit continuation against %s", (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const events = yield* EventSinkV2;
      const threadId = ThreadId.make(`recovery:${scenario}`);
      const projectId = ProjectId.make(`recovery:project:${scenario}`);
      const sql = yield* SqlClient.SqlClient;
      const projectAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Recovery project',
          ${process.cwd()},
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          ${projectAt},
          ${projectAt},
          NULL
        )
      `;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`recovery:create:${scenario}`),
        threadId,
        projectId,
        title: "Limited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:message:${scenario}`),
        threadId,
        messageId: MessageId.make(`recovery:message:${scenario}`),
        text: "Work on this.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      if (scenario === "queued-resume") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`recovery:queued:${scenario}`),
          threadId,
          messageId: MessageId.make(`recovery:queued:${scenario}`),
          text: "Run after recovery.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const now = yield* DateTime.now;
      const resetAt =
        scenario === "invalid-snooze"
          ? "not-a-date"
          : DateTime.formatIso(DateTime.add(now, { minutes: 1 })).replace(
              "Z",
              scenario === "wake" ? "+00:00" : "Z",
            );
      yield* events.write({
        commandId: CommandId.make(`recovery:failure:${scenario}`),
        events: [
          {
            id: EventId.make(`recovery:run:${scenario}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
          {
            id: EventId.make(`recovery:error:${scenario}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`recovery:error:${scenario}`),
              type: "error",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached.",
                code: "usageLimitExceeded",
                retryable: null,
                resetAt,
              },
            },
          },
        ],
      });
      if (scenario === "queued-resume") {
        const queuedRun = projection.runs[1]!;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:held:queued-resume"),
              type: "run.updated",
              threadId,
              runId: queuedRun.id,
              occurredAt: now,
              payload: { ...queuedRun, queueHeld: true },
            },
          ],
        });
        const resumeHeldQueue = yield* orchestrator
          .dispatch({
            type: "queue.resume",
            commandId: CommandId.make("recovery:resume-held:queued-resume"),
            threadId,
          })
          .pipe(Effect.exit);
        assert.equal(resumeHeldQueue._tag, "Failure");
        assert.isTrue((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.queueHeld);
      }
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.isNull(limitRecoveryCommand(shell, false, DateTime.toEpochMillis(now)));
      if (scenario === "invalid-snooze") {
        const result = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:invalid-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.limitRecovery ?? null);
        assert.isNull(current.thread.snoozedUntil);
        return;
      }
      const snooze = [
        "snooze-only",
        "manual-snooze-after-recovery",
        "snooze-resume",
        "wake",
        "cancel-resume-keep-snooze",
        "wake-preserve-resume",
      ].includes(scenario);
      const autoResume = scenario !== "snooze-only" && scenario !== "wake";
      const arm = limitRecoveryCommand(shell, autoResume, DateTime.toEpochMillis(now), snooze);
      assert.isNotNull(arm);
      yield* orchestrator.dispatch(arm!);
      let armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.deepEqual(armedShell.limitRecovery, {
        runId: run.id,
        resetAt,
        autoResume,
        snooze,
        requestId: arm!.commandId,
      });
      if (snooze)
        assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
      if (scenario === "cancel-resume-keep-snooze" || scenario === "wake-preserve-resume") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:independent-choice:${scenario}`),
          threadId,
          limitRecovery: {
            runId: run.id,
            resetAt,
            autoResume: scenario === "wake-preserve-resume",
            snooze: scenario === "cancel-resume-keep-snooze",
          },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        if (scenario === "cancel-resume-keep-snooze") {
          assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
          // Failed runtime timestamps advance with metadata. Acknowledging the
          // same failed run must not turn cancellation into an early wake.
          assert.equal(
            DateTime.toEpochMillis(armedShell.snoozedAt!),
            DateTime.toEpochMillis(armedShell.updatedAt),
          );
          assert.isFalse(armedShell.limitRecovery!.autoResume);
        } else {
          assert.isNull(armedShell.snoozedUntil);
          assert.isNull(armedShell.snoozedAt);
          assert.isTrue(armedShell.limitRecovery!.autoResume);
        }
      }
      if (scenario === "independent-patches") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-snooze"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, snooze: true },
        });
        let current = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        // This is also the payload an older auto-resume-only client sends.
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-cancel-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
        current = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        assert.equal(DateTime.toEpochMillis(current.thread.snoozedUntil!), Date.parse(resetAt));
        assert.equal(
          DateTime.toEpochMillis(current.thread.snoozedAt!),
          DateTime.toEpochMillis(current.thread.updatedAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.isTrue(armedShell.limitRecovery!.autoResume);
        assert.isTrue(armedShell.limitRecovery!.snooze);
      }
      if (scenario === "manual-snooze" || scenario === "manual-snooze-after-recovery") {
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`recovery:manual-snooze:${scenario}`),
          threadId,
          snoozedUntil: resetAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:manual-cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.equal(
          DateTime.toEpochMillis(
            (yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil!,
          ),
          Date.parse(resetAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(`recovery:manual-wake:${scenario}`),
          threadId,
          reason: "user",
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      if (scenario === "wake") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:wake:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      assert.isNull(limitRecoveryCommand(armedShell, true, DateTime.toEpochMillis(now)));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:early:${scenario}`),
        messageId: MessageId.make(`recovery:early:${scenario}`),
        threadId,
        usageLimitContinuationOfRunId: run.id,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        scenario === "queued-resume" ? 2 : 1,
      );
      yield* TestClock.adjust("1 minute");
      const resume = limitRecoveryCommand(
        armedShell,
        true,
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      if (autoResume && scenario !== "cancel-resume-keep-snooze") assert.isNotNull(resume);
      else assert.isNull(resume);
      if (scenario === "snooze-race") {
        const wakeAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("recovery:raced-snooze"),
          threadId,
          snoozedUntil: wakeAt,
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        yield* TestClock.adjust("1 minute");
        const current = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          current,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      if (scenario === "expired-snooze") {
        const staleSnooze = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:expired-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(staleSnooze._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.snoozedUntil);
        assert.isFalse(current.thread.limitRecovery!.snooze);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
      }

      if (scenario === "cancel" || scenario === "rearm")
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
      if (scenario === "archive")
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`recovery:archive:${scenario}`),
          threadId,
        });
      if (scenario === "new-message")
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`recovery:new-message:${scenario}`),
          threadId,
          messageId: MessageId.make(`recovery:new-message:${scenario}`),
          text: "I will continue manually.",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
      if (scenario === "settle")
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`recovery:settle:${scenario}`),
          threadId,
        });
      if (scenario === "replacement") {
        const current = yield* orchestrator.getThreadProjection(threadId);
        const error = current.turnItems.find((item) => item.type === "error")!;
        if (error.type !== "error") throw new Error("Expected provider error");
        yield* events.write({
          commandId: CommandId.make(`recovery:replacement:${scenario}`),
          events: [
            {
              id: EventId.make(`recovery:replacement:${scenario}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...error,
                failure: {
                  ...error.failure,
                  class: "provider_error",
                  message: "A replacement failure.",
                },
              },
            },
          ],
        });
      }
      if (scenario === "rearm") {
        yield* orchestrator.dispatch(resume!);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:rearm:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        const rearmedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          rearmedShell,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      if (resume !== null) {
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
      }
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        after.runs,
        before.runs.length +
          (scenario === "resume" ||
          scenario === "queued-resume" ||
          scenario === "snooze-resume" ||
          scenario === "wake-preserve-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      assert.lengthOf(
        after.messages,
        before.messages.length +
          (scenario === "resume" ||
          scenario === "queued-resume" ||
          scenario === "snooze-resume" ||
          scenario === "wake-preserve-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      if (scenario === "queued-resume") {
        assert.equal(after.runs[1]?.status, "queued");
        assert.isTrue(after.runs[1]?.queueHeld);
        const continuation = after.runs[2]!;
        const completedAt = yield* DateTime.now;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:continuation-completed:queued-resume"),
              type: "run.updated",
              threadId,
              runId: continuation.id,
              occurredAt: completedAt,
              payload: { ...continuation, status: "completed", completedAt },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("recovery:resume-held-after-limit:queued-resume"),
          threadId,
        });
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.runs[1]?.status, "starting");
        assert.isFalse(resumed.runs[1]?.queueHeld);
      }
    }),
  );
});

/** A watched pull request as the host reports it: open, mergeable, with a failing lint check. */
const watchedPullRequestDetail = (input: {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly at: string;
}) =>
  ({
    provider: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: [],
      search: false,
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
    },
    viewerPermissions: {
      actions: [],
      comment: true,
      resolve: true,
      verdicts: [],
      requestReviewers: false,
    },
    projectId: input.projectId,
    projectTitle: "Watch wake",
    workspaceRoot: "/workspace/watch",
    repository: "pingdotgg/t3code",
    number: input.number,
    title: "Watched pull request",
    body: "",
    url: `https://github.com/pingdotgg/t3code/pull/${input.number}`,
    author: { login: "agent-user", name: null, avatarUrl: null },
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headBranch: "feature",
    headSha: "abc1234def",
    baseBranch: "main",
    createdAt: input.at,
    updatedAt: input.at,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [{ name: "lint", status: "failure", description: null, url: null }],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    viewer: "agent-user",
  }) as PullRequestDetail;

it.layer(TestLayer)("V2 pull request watch", (it) => {
  // A wake starts a run, which resolves the project's runtime policy.
  const seedProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Watch project',
          ${`/tmp/${projectId}`},
          NULL,
          '[]',
          '2026-10-01T00:00:00.000Z',
          '2026-10-01T00:00:00.000Z',
          NULL
        )
      `;
    });
  const createWatchThread = (threadId: ThreadId, projectId: ProjectId) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      yield* seedProject(projectId);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}-create`),
        threadId,
        projectId,
        title: "Watch",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
    });

  it.effect("starts, records, and stops a pull request watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const threadId = ThreadId.make("runtime-pull-request-watch");
      const projectId = ProjectId.make("pr-watch-project");
      yield* createWatchThread(threadId, projectId);
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      const url = "https://github.com/pingdotgg/t3code/pull/7";
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );

      // Watching an unlinked pull request links it in the same command.
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-start"),
        threadId,
        ...key,
        watching: true,
        link: { url, source: "agent" },
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "agent",
      );
      const started = yield* watchOf;
      assert.isDefined(started);
      if (started === undefined) return;

      // A legacy client re-linking the same pull request keeps its watch.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("pr-watch-legacy-relink"),
        threadId,
        linkedPullRequest: { projectId, repository: key.repository, number: key.number, url },
      });
      assert.deepEqual(yield* watchOf, started);

      const recorded = { ...started, headSha: "abc123", failedChecks: ["lint"], wakes: 1 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-record"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: recorded,
      });
      assert.deepEqual(yield* watchOf, recorded);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* watchOf, recorded);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-stop"),
        threadId,
        ...key,
        watching: false,
      });
      // A wake read before the stop must neither wake the agent nor bring the watch back.
      const late = yield* orchestrator
        .dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make("pr-watch-late-record"),
          threadId,
          ...key,
          startedAt: started.startedAt,
          watch: { ...recorded, wakes: 2 },
          wake: {
            messageId: MessageId.make("pr-watch-late-wake"),
            text: "Update",
            notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7" },
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(late, OrchestratorDispatchError);
      assert.isUndefined(yield* watchOf);
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(messages, []);
    }),
  );

  it.effect.each(["manual", "automatic"])("settling ends every pull request watch: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const maintenance = yield* ProjectionMaintenanceV2;
      const threadId = ThreadId.make(`runtime-pull-request-watch-settle-${mode}`);
      yield* createWatchThread(threadId, ProjectId.make(`pr-watch-settle-project-${mode}`));
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      for (const number of [7, 8]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-settle-start-${mode}-${number}`),
          threadId,
          ...key,
          number,
          watching: true,
          link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
        });
      }
      const before = yield* orchestrator.getThreadShell(threadId);
      const started = before?.pullRequests?.[0]?.watch;
      assert.isDefined(started);
      if (started === undefined || before === null) return;
      if (mode === "automatic") {
        // A watched thread is still working, so automatic settlement leaves it alone.
        const refused: unknown = yield* orchestrator
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(`pr-watch-settle-${mode}-refused`),
            threadId,
            automatic: { expectedSequence: yield* orchestrator.getThreadEventSequence(threadId) },
          })
          .pipe(Effect.flip);
        assert.instanceOf(refused, OrchestratorDispatchError);
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
          before.pullRequests,
        );
      }
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`pr-watch-settle-${mode}`),
        threadId,
      });
      const expected = before.pullRequests?.map(({ watch: _watch, ...link }) => link);
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);

      for (const wake of [
        undefined,
        {
          messageId: MessageId.make(`pr-watch-settle-late-wake-${mode}`),
          text: "Update",
          notification: {
            source: { kind: "monitor" as const },
            outcome: "updated" as const,
            summary: "#7",
          },
        },
      ]) {
        const late: unknown = yield* orchestrator
          .dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`pr-watch-settle-late-${mode}-${wake !== undefined}`),
            threadId,
            ...key,
            number: 7,
            startedAt: started.startedAt,
            watch: { ...started, headSha: "late", wakes: 1 },
            ...(wake === undefined ? {} : { wake }),
          })
          .pipe(Effect.flip);
        assert.instanceOf(late, OrchestratorDispatchError);
      }
      const restart = {
        type: "thread.pull-request.watch" as const,
        threadId,
        ...key,
        number: 7,
        watching: true,
      };
      const blocked = yield* orchestrator
        .dispatch({ ...restart, commandId: CommandId.make(`pr-watch-settle-blocked-${mode}`) })
        .pipe(Effect.flip);
      assert.instanceOf(blocked, OrchestratorDispatchError);
      assert.deepEqual((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, []);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`pr-watch-settle-unsettle-${mode}`),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        ...restart,
        commandId: CommandId.make(`pr-watch-settle-restart-${mode}`),
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);
    }),
  );

  it.effect("archiving ends watches, and an archived or subagent thread cannot start one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-archive");
      const projectId = ProjectId.make("pr-watch-archive-project");
      yield* createWatchThread(threadId, projectId);
      const watch = {
        type: "thread.pull-request.watch" as const,
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" as const },
      };
      const watched = (id: ThreadId) =>
        Effect.map(
          orchestrator.getThreadShell(id),
          (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
        );
      yield* orchestrator.dispatch({
        ...watch,
        commandId: CommandId.make("pr-watch-archive-start"),
      });
      assert.isTrue(yield* watched(threadId));

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("pr-watch-archive"),
        threadId,
      });
      assert.isFalse(yield* watched(threadId));
      const refused = yield* orchestrator
        .dispatch({ ...watch, commandId: CommandId.make("pr-watch-archive-restart") })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("pr-watch-unarchive"),
        threadId,
      });
      assert.isFalse(yield* watched(threadId));

      // A subagent reports to its parent thread, which owns the pull request.
      const childThreadId = ThreadId.make("runtime-pull-request-watch-subagent");
      const parent = (yield* orchestrator.getThreadProjection(threadId)).thread;
      const now = yield* DateTime.now;
      yield* (yield* EventSinkV2).write({
        commandId: CommandId.make("pr-watch-subagent-seed"),
        events: [
          {
            id: EventId.make("pr-watch-subagent-created"),
            type: "thread.created",
            threadId: childThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...parent,
              id: childThreadId,
              title: "Subagent",
              createdBy: "agent",
              creationSource: "server",
              lineage: {
                parentThreadId: threadId,
                relationshipToParent: "subagent",
                rootThreadId: threadId,
              },
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      const subagentRefused = yield* orchestrator
        .dispatch({
          ...watch,
          threadId: childThreadId,
          commandId: CommandId.make("pr-watch-subagent-start"),
        })
        .pipe(Effect.flip);
      assert.equal(subagentRefused._tag, "OrchestratorDispatchError");
      assert.isFalse(yield* watched(childThreadId));
    }),
  );

  it.effect(
    "reads a watched pull request once a pass, waits out rate limits, and skips quiet passes",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const projectId = ProjectId.make("pr-watch-shared-project");
        const threadIds = ["one", "two"].map((name) =>
          ThreadId.make(`runtime-pull-request-watch-shared-${name}`),
        );
        yield* seedProject(projectId);
        const watchFrom = (threadId: ThreadId) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`create:${threadId}`),
              threadId,
              projectId,
              title: "Watch shared",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* orchestrator.dispatch({
              type: "thread.pull-request.watch",
              commandId: CommandId.make(`watch:${threadId}`),
              threadId,
              host: "github.com",
              repository: "pingdotgg/t3code",
              number: 9,
              watching: true,
              link: { url: "https://github.com/pingdotgg/t3code/pull/9", source: "agent" },
            });
          });
        for (const threadId of threadIds) yield* watchFrom(threadId);
        const rateLimited = new PullRequestOperationError({
          operation: "getChangeRequest",
          detail: "github requests are paused until the rate limit resets",
          cause: new PullRequestProviderError({
            provider: "github",
            operation: "getChangeRequest",
            reason: "rate-limited",
            detail: "paused",
          }),
        });
        let host: "rate-limited" | "open" | "closed" = "rate-limited";
        let reads = 0;
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              // Watches other tests left in the shared database stay rate limited and uncounted.
              Layer.mock(PullRequestService)({
                detail: (input) =>
                  Effect.suspend(() => {
                    if (input.projectId !== projectId) return Effect.fail(rateLimited);
                    reads += 1;
                    return host === "rate-limited"
                      ? Effect.fail(rateLimited)
                      : Effect.succeed({
                          ...watchedPullRequestDetail({
                            projectId,
                            number: 9,
                            at: "2026-10-02T12:00:00.000Z",
                          }),
                          state: host,
                          checks: [
                            { name: "lint", status: "success", description: null, url: null },
                          ],
                        } as PullRequestDetail);
                  }),
                activity: (input) =>
                  host === "rate-limited" || input.projectId !== projectId
                    ? Effect.fail(rateLimited)
                    : Effect.succeed({
                        comments: [],
                        commentCount: 0,
                        commentsTruncated: false,
                        reviewThreads: [],
                        commits: [],
                      }),
              }),
            ),
          ),
        );
        const summaries = (threadId: ThreadId) =>
          Effect.map(orchestrator.getThreadRecords(threadId, ["messages"]), ({ messages }) =>
            messages.flatMap((message) => message.notification?.summary ?? []),
          );
        const watching = (threadId: ThreadId) =>
          Effect.map(
            orchestrator.getThreadShell(threadId),
            (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
          );

        // However long the host stays rate limited, the watch waits instead of giving up, and
        // both threads share one read a pass.
        for (let pass = 0; pass < 20; pass += 1) yield* reactor.sweep;
        assert.equal(reads, 20);
        for (const threadId of threadIds) {
          assert.isTrue(yield* watching(threadId));
          assert.deepEqual(yield* summaries(threadId), []);
        }

        host = "open";
        yield* reactor.sweep;
        assert.equal(reads, 21);
        for (const threadId of threadIds) {
          assert.deepEqual(yield* summaries(threadId), ["#9: checks passed"]);
        }

        // Nothing in flight and nothing moved, so the next pass spends no request.
        yield* reactor.sweep;
        assert.equal(reads, 21);

        // A new watch on the quiet pull request takes its first look on the next pass.
        const late = ThreadId.make("runtime-pull-request-watch-shared-late");
        yield* watchFrom(late);
        yield* reactor.sweep;
        assert.equal(reads, 22);
        assert.deepEqual(yield* summaries(late), ["#9: checks passed"]);
        for (const threadId of threadIds) {
          assert.deepEqual(yield* summaries(threadId), ["#9: checks passed"]);
        }
        threadIds.push(late);

        // The quiet reread finds the pull request closed, ends every watch, and says so.
        host = "closed";
        yield* TestClock.adjust("10 minutes");
        yield* reactor.sweep;
        assert.equal(reads, 23);
        for (const threadId of threadIds) {
          assert.isFalse(yield* watching(threadId));
          assert.deepEqual(yield* summaries(threadId), [
            "#9: checks passed",
            "#9: closed, stopped watching",
          ]);
        }
      }),
  );

  it.effect("reports how long an ended watch was quiet", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-ended");
      const projectId = ProjectId.make("pr-watch-ended-project");
      yield* createWatchThread(threadId, projectId);
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 11 };
      const watching = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-ended-${id}`),
          threadId,
          ...key,
          watching: on,
          ...(on
            ? {
                link: {
                  url: "https://github.com/pingdotgg/t3code/pull/11",
                  source: "agent" as const,
                },
              }
            : {}),
        });
      yield* watching(true, "start");

      let headSha = "aaaaaaa";
      const ended: Array<unknown> = [];
      const capture = Logger.make(({ message }) => {
        const [text, fields] = Array.isArray(message) ? message : [message];
        // Watches other tests left in the shared database may end here too.
        if (text === "pull request watch ended" && fields?.threadId === threadId) {
          ended.push(fields);
        }
      });
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(PullRequestService)({
              detail: () =>
                Effect.sync(
                  () =>
                    ({
                      ...watchedPullRequestDetail({
                        projectId,
                        number: key.number,
                        at: "2026-10-02T00:00:00.000Z",
                      }),
                      headSha,
                      checks: [],
                    }) as PullRequestDetail,
                ),
              activity: () =>
                Effect.succeed({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                }),
            }),
          ),
        ),
      );
      const sweep = reactor.sweep.pipe(Effect.provide(Logger.layer([capture])));

      // The first read learns the head. A push 6 hours later, then 2 quiet hours.
      yield* sweep;
      yield* TestClock.adjust("6 hours");
      headSha = "bbbbbbb";
      yield* sweep;
      yield* TestClock.adjust("2 hours");
      yield* sweep;
      yield* watching(false, "stop");
      // The end is reported once.
      yield* sweep;
      yield* sweep;

      assert.deepEqual(ended, [
        {
          threadId,
          pullRequest: "github.com/pingdotgg/t3code#11",
          reason: "stopped",
          minutes: 480,
          quietMinutes: 120,
          longestQuietMinutes: 360,
          wakes: 0,
          reads: 3,
          partial: false,
        },
      ]);
    }),
  );

  it.effect("with a host fingerprint, a watch reads only what moved", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projectId = ProjectId.make("pr-watch-fingerprint-project");
      const threadId = ThreadId.make("runtime-pull-request-watch-fingerprint");
      yield* createWatchThread(threadId, projectId);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-fingerprint-start"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 11,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/11", source: "agent" },
      });

      const rateLimited = new PullRequestOperationError({
        operation: "watchFingerprint",
        detail: "paused",
        cause: new PullRequestProviderError({
          provider: "github",
          operation: "getChangeRequestWatchFingerprint",
          reason: "rate-limited",
          detail: "paused",
        }),
      });
      let fingerprint: { status: string; remarks: string } | "rate-limited" = {
        status: "OPEN pending",
        remarks: "0",
      };
      type CheckStatus = "pending" | "success" | "failure";
      // What the host says now, and what a read answers: a read right after a cache fill can
      // still answer from before a change until the cache is invalidated.
      let checks: { lint: CheckStatus; test: CheckStatus } = { lint: "pending", test: "pending" };
      let cachedChecks: typeof checks | null = null;
      let comments: Array<PullRequestComment> = [];
      let detailReads = 0;
      let activityReads = 0;
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(PullRequestService)({
              // Watches other tests left in the shared database stay paused and unread.
              watchFingerprint: (input) =>
                Effect.suspend(() =>
                  fingerprint === "rate-limited" || input.projectId !== projectId
                    ? Effect.fail(rateLimited)
                    : Effect.succeed(fingerprint),
                ),
              invalidate: () =>
                Effect.sync(() => {
                  cachedChecks = null;
                }),
              detail: () =>
                Effect.sync(() => {
                  detailReads += 1;
                  const answer = cachedChecks ?? checks;
                  cachedChecks = null;
                  return {
                    ...watchedPullRequestDetail({
                      projectId,
                      number: 11,
                      at: "2026-10-02T12:00:00.000Z",
                    }),
                    checks: Object.entries(answer).map(([name, status]) => ({
                      name,
                      status,
                      description: null,
                      url: null,
                    })),
                  } as PullRequestDetail;
                }),
              activity: () =>
                Effect.sync(() => {
                  activityReads += 1;
                  return {
                    comments,
                    commentCount: comments.length,
                    commentsTruncated: false,
                    reviewThreads: [],
                    commits: [],
                  };
                }),
            }),
          ),
        ),
      );
      const reads = () => ({ detail: detailReads, activity: activityReads });
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      // The first look reads everything.
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 1, activity: 1 });

      // While checks run, the cheap detail is read every pass: check counts by state cannot
      // tell which check finished, so a failure can arrive with the fingerprint unchanged.
      checks = { lint: "failure", test: "pending" };
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 2, activity: 1 });
      assert.deepEqual(yield* summaries, ["#11: checks failed"]);

      // When the fingerprint moves, a cached answer from before the move is not trusted, and
      // the moved status takes the detail read alone.
      yield* TestClock.adjust("1 millis");
      cachedChecks = checks;
      checks = { lint: "failure", test: "success" };
      fingerprint = { status: "OPEN settled", remarks: "0" };
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 3, activity: 1 });

      // Nothing in flight and nothing moved, so the passes read nothing.
      for (let pass = 0; pass < 5; pass += 1) yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 3, activity: 1 });

      // A new comment moves the remarks, which take the activity read too.
      yield* TestClock.adjust("1 millis");
      comments = [
        {
          id: "comment-1",
          kind: "issue-comment",
          author: { login: "reviewer", name: null, avatarUrl: null },
          body: "Please rename this.",
          createdAt: "2999-01-01T00:00:00.000Z",
          url: null,
          path: null,
          reviewState: null,
        },
      ];
      fingerprint = { status: "OPEN settled", remarks: "1" };
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 4, activity: 2 });
      assert.deepEqual(yield* summaries, ["#11: checks failed", "#11: new comments"]);

      // While the host is rate limited, a pass reads nothing and the watch stays on.
      fingerprint = "rate-limited";
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 4, activity: 2 });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);

      // Edits inside review threads leave no trace in the fingerprint, so the activity is read
      // again after half an hour regardless.
      fingerprint = { status: "OPEN settled", remarks: "1" };
      yield* TestClock.adjust("30 minutes");
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 5, activity: 3 });
      assert.deepEqual(yield* summaries, ["#11: checks failed", "#11: new comments"]);
    }),
  );

  it.effect("ends a watch it cannot read, and tells the agent", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-unreadable");
      yield* createWatchThread(threadId, ProjectId.make("pr-watch-unreadable-project"));
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-unreadable-start"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 8,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/8", source: "agent" },
      });
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(PullRequestService)({
              detail: () => Effect.die("host unreachable"),
              activity: () => Effect.die("host unreachable"),
            }),
          ),
        ),
      );
      for (let pass = 0; pass < 15; pass += 1) yield* reactor.sweep;

      const thread = yield* orchestrator.getThreadShell(threadId);
      assert.isUndefined(thread?.pullRequests?.[0]?.watch);
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(
        messages.flatMap((message) => message.notification?.summary ?? []),
        ["#8: stopped watching, could not read it"],
      );
      assert.deepEqual(
        messages.map((message) => [message.createdBy, message.creationSource]),
        [["agent", "server"]],
      );
    }),
  );

  it.effect.each([
    "single page",
    "paginated",
    "page failure",
    "repeated cursor",
    "missing comments",
    "thread list truncated",
  ])("wakes a watched thread once: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make(`runtime-pull-request-watch-wake-${mode}`);
      const projectId = ProjectId.make(`pr-watch-wake-project-${mode}`);
      yield* createWatchThread(threadId, projectId);
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      const url = "https://github.com/pingdotgg/t3code/pull/7";
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`pr-watch-wake-link-${mode}`),
        threadId,
        linkPullRequest: { projectId, repository: key.repository, number: key.number, url },
        linkPullRequestSource: "agent",
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`pr-watch-wake-start-${mode}`),
        threadId,
        ...key,
        watching: true,
      });

      const at = "2026-10-02T12:00:00.000Z";
      const detail = watchedPullRequestDetail({ projectId, number: key.number, at });
      const initialWatch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(initialWatch);
      const remark: PullRequestComment = {
        id: "review-1",
        kind: "review-comment",
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "One more thing.",
        createdAt: "2999-01-01T00:00:03.000Z",
        url: null,
        path: "src/index.ts",
        reviewState: null,
      };
      const firstTen = Array.from({ length: 10 }, (_, index) => ({
        ...remark,
        id: `old-${index}`,
        createdAt: "1900-01-01T00:00:00.000Z",
      }));
      const eleventh = {
        ...remark,
        id: "reply-11",
        body: "Eleventh reply.",
        createdAt: "2999-01-01T00:00:01.000Z",
      };
      const twelfth = {
        ...remark,
        id: "reply-12",
        body: "Twelfth reply.",
        createdAt: "2999-01-01T00:00:02.000Z",
      };
      const incomplete = mode !== "single page" && mode !== "paginated";
      let recovering = false;
      let pagesRead = 0;
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(PullRequestService)({
              detail: () => Effect.succeed(detail),
              activity: () =>
                Effect.succeed({
                  comments:
                    mode === "single page"
                      ? [remark]
                      : [...firstTen, { ...remark, kind: "issue-comment" }],
                  commentCount: mode === "single page" ? 1 : 13,
                  commentsTruncated: mode !== "single page",
                  reviewThreadsTruncated: mode === "thread list truncated" && !recovering,
                  reviewThreads:
                    mode === "single page"
                      ? []
                      : [
                          {
                            id: "review-thread",
                            path: "src/index.ts",
                            line: 1,
                            side: "right",
                            isResolved: false,
                            isOutdated: false,
                            comments: firstTen,
                            commentCount: 12,
                            nextCommentsCursor: "after-10",
                          },
                        ],
                  commits: [],
                }),
              threadComments: (input) => {
                pagesRead += 1;
                assert.equal(input.threadId, "review-thread");
                if (input.cursor === "after-10") {
                  return Effect.succeed({ comments: [eleventh], nextCursor: "after-11" });
                }
                assert.equal(input.cursor, "after-11");
                if (!recovering && mode === "page failure") {
                  return Effect.fail(
                    new PullRequestOperationError({
                      operation: "threadComments",
                      detail: "Page unavailable",
                    }),
                  );
                }
                if (!recovering && mode === "repeated cursor") {
                  return Effect.succeed({ comments: [eleventh], nextCursor: "after-11" });
                }
                if (!recovering && mode === "missing comments") {
                  return Effect.succeed({ comments: [], nextCursor: null });
                }
                // Overlapping pages must not report the same reply twice.
                return Effect.succeed({ comments: [eleventh, twelfth], nextCursor: null });
              },
            }),
          ),
        ),
      );
      if (incomplete) {
        yield* reactor.sweep;
        const held = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
        assert.equal(held?.remarksThrough, initialWatch?.remarksThrough);
        assert.deepEqual(held?.remarkIds, initialWatch?.remarkIds);
        assert.deepEqual(held?.failedChecks, ["lint"]);
        const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
        assert.deepEqual(
          messages.map((message) => message.notification?.summary),
          ["#7: checks failed"],
        );
        // Keep the two notifications ordered independently of their random message IDs.
        yield* TestClock.adjust("1 millis");
        recovering = true;
      }
      yield* reactor.sweep;
      // A thread whose count has not moved is not paged again.
      const pagesBefore = pagesRead;
      yield* reactor.sweep;
      assert.equal(pagesRead, pagesBefore);

      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(
        messages.flatMap((message) =>
          message.notification === undefined ? [] : [message.notification.summary],
        ),
        incomplete
          ? ["#7: checks failed", "#7: new comments"]
          : ["#7: checks failed, new comments"],
      );
      if (mode !== "single page") {
        const wake = messages.at(-1);
        assert.include(wake?.text ?? "", "3 new comments");
        assert.include(wake?.text ?? "", "Eleventh reply.");
        assert.include(wake?.text ?? "", "Twelfth reply.");
      }
      const watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.equal(watch?.remarksThrough, remark.createdAt);
      assert.deepEqual(watch?.remarkIds, [remark.id]);
      assert.deepEqual(
        { headSha: watch?.headSha, failedChecks: watch?.failedChecks, wakes: watch?.wakes },
        { headSha: "abc1234def", failedChecks: ["lint"], wakes: incomplete ? 1 : 0 },
      );
    }),
  );
});
