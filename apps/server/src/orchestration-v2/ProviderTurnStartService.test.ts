import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { EventSinkV2 } from "./EventSink.ts";
import { ContextHandoffServiceV2 } from "./ContextHandoffService.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  layer as providerTurnStartLayer,
  ProviderTurnStartServiceV2,
} from "./ProviderTurnStartService.ts";
import { RunExecutionServiceV2 } from "./RunExecutionService.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

const threadId = ThreadId.make("thread:provider-turn-start-fail");
const runId = RunId.make("run:provider-turn-start-fail");
const nodeId = NodeId.make("node:provider-turn-start-fail");
const attemptId = RunAttemptId.make("run-attempt:provider-turn-start-fail");
const providerThreadId = ProviderThreadId.make("provider-thread:provider-turn-start-fail");

function makeProjection(now: DateTime.Utc): OrchestrationV2ThreadProjection {
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:provider-turn-start-fail"),
      title: "Provider turn start failure",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
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
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:provider-turn-start-fail"),
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "starting",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: now,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    ],
    subagents: [],
    providerSessions: [],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make("provider-session:provider-turn-start-fail"),
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

function makeTestLayer(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly committed: boolean;
  readonly writes: Ref.Ref<ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>>;
}) {
  const projectionLayer = Layer.succeed(
    ProjectionStoreV2,
    ProjectionStoreV2.of({
      apply: () => Effect.void,
      getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
      getThreadShell: () => Effect.die("unused getThreadShell"),
      getThreadProjection: () => Effect.succeed(input.projection),
      getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
    }),
  );
  const eventSinkLayer = Layer.succeed(
    EventSinkV2,
    EventSinkV2.of({
      write: () => Effect.die("unused write"),
      writeWithEffects: () => Effect.die("unused writeWithEffects"),
      writeIfRunCurrent: (writeInput) =>
        Ref.update(input.writes, (current) => [...current, writeInput.events]).pipe(
          Effect.as({ committed: input.committed, storedEvents: [] }),
        ),
      commitCommand: () => Effect.die("unused commitCommand"),
      commitRejectedCommand: () => Effect.die("unused commitRejectedCommand"),
      stream: () => Stream.die("unused stream"),
      latestSequence: () => Effect.die("unused latestSequence"),
      readByCommandId: () => Stream.die("unused readByCommandId"),
    }),
  );
  const unusedLayers = Layer.mergeAll(
    Layer.succeed(
      ContextHandoffServiceV2,
      ContextHandoffServiceV2.of({
        prepareLegacyImport: () => Effect.die("unused prepareLegacyImport"),
        prepare: () => Effect.die("unused prepare"),
        prepareForkDelta: () => Effect.die("unused prepareForkDelta"),
        beginProviderHandoff: () => Effect.die("unused beginProviderHandoff"),
        completeProviderHandoff: () => Effect.die("unused completeProviderHandoff"),
        prepareProviderHandoff: () => Effect.die("unused prepareProviderHandoff"),
      }),
    ),
    Layer.succeed(
      ProviderSessionManagerV2,
      ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.die("unused get"),
        close: () => Effect.void,
        release: () => Effect.void,
        detach: () => Effect.void,
      }),
    ),
    Layer.succeed(
      RunExecutionServiceV2,
      RunExecutionServiceV2.of({
        startRootRun: () => Effect.die("unused startRootRun"),
      }),
    ),
    Layer.succeed(
      RuntimePolicyV2,
      RuntimePolicyV2.of({
        resolve: () => Effect.die("unused resolve"),
      }),
    ),
  );
  return providerTurnStartLayer.pipe(
    Layer.provide(
      Layer.mergeAll(projectionLayer, eventSinkLayer, idAllocatorLayer, unusedLayers) as Layer.Layer<
        | ProjectionStoreV2
        | EventSinkV2
        | IdAllocatorV2
        | ContextHandoffServiceV2
        | ProviderSessionManagerV2
        | RunExecutionServiceV2
        | RuntimePolicyV2
      >,
    ),
  );
}

it.effect("terminalizes the run when the guarded permanent-failure write commits", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const writes = yield* Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>>([]);
    const layer = makeTestLayer({ projection: makeProjection(now), committed: true, writes });

    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        const service = yield* ProviderTurnStartServiceV2;
        yield* service.failPermanently({ threadId, runId });
      }).pipe(Effect.provide(layer)),
    );

    assert.isTrue(Exit.isSuccess(exit));
    const written = yield* Ref.get(writes);
    assert.equal(written.length, 1);
    assert.deepEqual(
      written[0]?.map((event) => event.type),
      ["run-attempt.updated", "node.updated", "turn-item.updated", "run.updated"],
    );
  }),
);

it.effect("reports a rejected guarded write instead of completing the permanent failure", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const writes = yield* Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>>([]);
    const layer = makeTestLayer({ projection: makeProjection(now), committed: false, writes });

    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        const service = yield* ProviderTurnStartServiceV2;
        yield* service.failPermanently({ threadId, runId });
      }).pipe(Effect.provide(layer)),
    );

    // The stale guarded write must surface as a failure so the worker keeps the
    // pending terminalization queued instead of recording a phantom success.
    assert.isTrue(Exit.isFailure(exit));
    const written = yield* Ref.get(writes);
    assert.equal(written.length, 1);
  }),
);
