import { assert, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CheckpointScopeId,
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

import {
  AttachmentMaterialization,
  type AttachmentMaterializationResult,
} from "../attachments/AttachmentMaterialization.ts";
import type {
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnMessage,
} from "./ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
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
      AttachmentMaterialization,
      AttachmentMaterialization.of({
        materialize: () => Effect.die("unused materialize"),
      }),
    ),
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
      Layer.mergeAll(
        projectionLayer,
        eventSinkLayer,
        idAllocatorLayer,
        unusedLayers,
      ) as Layer.Layer<
        | AttachmentMaterialization
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

/**
 * The turn-start wiring: uploads are materialized into the agent's working
 * directory, announced in the prompt, and stripped from the payload unless the
 * delivery policy or a failed write keeps them inline.
 */
const startThreadId = ThreadId.make("thread:provider-turn-start-uploads");
const startRunId = RunId.make("run:provider-turn-start-uploads");
const startNodeId = NodeId.make("node:provider-turn-start-uploads");
const startAttemptId = RunAttemptId.make("run-attempt:provider-turn-start-uploads");
const startProviderThreadId = ProviderThreadId.make("provider-thread:provider-turn-start-uploads");
const startProviderSessionId = ProviderSessionId.make(
  "provider-session:provider-turn-start-uploads",
);
const startMessageId = MessageId.make("message:provider-turn-start-uploads");
const startScopeId = CheckpointScopeId.make("checkpoint-scope:provider-turn-start-uploads");

const uploadImage: ChatAttachment = {
  type: "image",
  id: "uploads-1d0e7f22-1111-2222-3333-444455556666",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 12,
};
const uploadPdf: ChatAttachment = {
  type: "pdf",
  id: "uploads-9f2c1a4b-1111-2222-3333-444455556666",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 34,
};

function makeStartProjection(input: {
  readonly now: DateTime.Utc;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): OrchestrationV2ThreadProjection {
  const base = makeProjection(input.now);
  return {
    ...base,
    thread: { ...base.thread, id: startThreadId, activeProviderThreadId: startProviderThreadId },
    runs: [
      {
        ...base.runs[0]!,
        id: startRunId,
        threadId: startThreadId,
        providerThreadId: startProviderThreadId,
        userMessageId: startMessageId,
        rootNodeId: startNodeId,
        activeAttemptId: startAttemptId,
      },
    ],
    attempts: [
      {
        ...base.attempts[0]!,
        id: startAttemptId,
        runId: startRunId,
        rootNodeId: startNodeId,
        providerThreadId: startProviderThreadId,
      },
    ],
    nodes: [
      {
        ...base.nodes[0]!,
        id: startNodeId,
        threadId: startThreadId,
        runId: startRunId,
        rootNodeId: startNodeId,
        providerThreadId: startProviderThreadId,
        checkpointScopeId: startScopeId,
      },
    ],
    providerThreads: [
      {
        ...base.providerThreads[0]!,
        id: startProviderThreadId,
        providerSessionId: startProviderSessionId,
        appThreadId: startThreadId,
      },
    ],
    messages: [
      {
        id: startMessageId,
        threadId: startThreadId,
        runId: startRunId,
        nodeId: startNodeId,
        role: "user",
        text: input.text,
        attachments: input.attachments,
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: input.now,
        updatedAt: input.now,
      },
    ],
    checkpointScopes: [
      {
        id: startScopeId,
        threadId: startThreadId,
        runId: startRunId,
        nodeId: startNodeId,
        parentScopeId: null,
        providerThreadId: startProviderThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/workspace",
        createdAt: input.now,
      },
    ],
  };
}

function makeStartTestLayer(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly materialization: AttachmentMaterializationResult;
  readonly startInputs: Ref.Ref<ReadonlyArray<ProviderAdapterV2TurnMessage>>;
  readonly placementWrites: Ref.Ref<ReadonlyArray<OrchestrationV2DomainEvent>>;
  readonly now: DateTime.Utc;
}) {
  const providerSession = {
    id: startProviderSessionId,
    driver,
    providerInstanceId,
    status: "ready",
    cwd: "/workspace",
    model: "gpt-5.4",
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  } as const;

  const sessionRuntime = {
    instanceId: providerInstanceId,
    driver,
    providerSessionId: startProviderSessionId,
    providerSession,
    events: Stream.empty,
    ensureThread: () => Effect.succeed(input.projection.providerThreads[0]!),
  } as unknown as ProviderAdapterV2SessionRuntime;

  return providerTurnStartLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AttachmentMaterialization,
          AttachmentMaterialization.of({
            materialize: () => Effect.succeed(input.materialization),
          }),
        ),
        Layer.succeed(
          ProjectionStoreV2,
          ProjectionStoreV2.of({
            apply: () => Effect.void,
            getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
            getThreadShell: () => Effect.die("unused getThreadShell"),
            getThreadProjection: () => Effect.succeed(input.projection),
            getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
          }),
        ),
        Layer.succeed(
          EventSinkV2,
          EventSinkV2.of({
            write: (writeInput) =>
              Ref.update(input.placementWrites, (current) => [
                ...current,
                ...writeInput.events,
              ]).pipe(Effect.as([])),
            writeWithEffects: () => Effect.die("unused writeWithEffects"),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            commitCommand: () => Effect.die("unused commitCommand"),
            commitRejectedCommand: () => Effect.die("unused commitRejectedCommand"),
            stream: () => Stream.die("unused stream"),
            latestSequence: () => Effect.die("unused latestSequence"),
            readByCommandId: () => Stream.die("unused readByCommandId"),
          }),
        ),
        idAllocatorLayer,
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
            open: () => Effect.succeed(sessionRuntime),
            get: () => Effect.die("unused get"),
            close: () => Effect.void,
            release: () => Effect.void,
            detach: () => Effect.void,
          }),
        ),
        Layer.succeed(
          RunExecutionServiceV2,
          RunExecutionServiceV2.of({
            startRootRun: (startInput) =>
              Ref.update(input.startInputs, (current) => [...current, startInput.message]),
          }),
        ),
        Layer.succeed(
          RuntimePolicyV2,
          RuntimePolicyV2.of({
            resolve: () =>
              Effect.succeed({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: "/workspace",
              }),
          }),
        ),
      ),
    ),
  );
}

const runStart = (input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly materialization: AttachmentMaterializationResult;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const startInputs = yield* Ref.make<ReadonlyArray<ProviderAdapterV2TurnMessage>>([]);
    const placementWrites = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const layer = makeStartTestLayer({
      projection: makeStartProjection({ now, text: input.text, attachments: input.attachments }),
      materialization: input.materialization,
      startInputs,
      placementWrites,
      now,
    });
    yield* Effect.gen(function* () {
      const service = yield* ProviderTurnStartServiceV2;
      yield* service.start({ threadId: startThreadId, runId: startRunId });
    }).pipe(Effect.provide(layer));
    const captured = yield* Ref.get(startInputs);
    const placement = yield* Ref.get(placementWrites);
    return { message: captured[0], placement };
  });

it.effect("announces uploads in the prompt and stops sending non-images inline", () =>
  Effect.gen(function* () {
    const { message } = yield* runStart({
      text: "have a look",
      attachments: [uploadPdf],
      materialization: {
        materialized: [],
        promptBlock: "<t3_uploaded_files>\n1. .t3code/uploads/aa/bb-spec.pdf\n</t3_uploaded_files>",
        inlineAttachments: [],
        outcome: "written",
      },
    });

    assert.equal(
      message?.text,
      "have a look\n\n<t3_uploaded_files>\n1. .t3code/uploads/aa/bb-spec.pdf\n</t3_uploaded_files>",
    );
    assert.deepEqual(message?.attachments, []);
  }),
);

it.effect("keeps images inline while still announcing their workspace path", () =>
  Effect.gen(function* () {
    const { message } = yield* runStart({
      text: "why is this broken",
      attachments: [uploadImage],
      materialization: {
        materialized: [],
        promptBlock: "BLOCK",
        inlineAttachments: [uploadImage],
        outcome: "written",
      },
    });

    assert.isTrue(message?.text.endsWith("BLOCK"));
    assert.deepEqual(message?.attachments, [uploadImage]);
  }),
);

it.effect("sends an attachment-only message as the upload block alone", () =>
  Effect.gen(function* () {
    const { message } = yield* runStart({
      text: "",
      attachments: [uploadPdf],
      materialization: {
        materialized: [],
        promptBlock: "BLOCK",
        inlineAttachments: [],
        outcome: "written",
      },
    });

    assert.equal(message?.text, "BLOCK");
  }),
);

it.effect("still delivers attachments inline when materialization degrades", () =>
  Effect.gen(function* () {
    const { message } = yield* runStart({
      text: "have a look",
      attachments: [uploadPdf],
      materialization: {
        materialized: [],
        promptBlock: null,
        inlineAttachments: [uploadPdf],
        outcome: "failed",
      },
    });

    assert.equal(message?.text, "have a look");
    assert.deepEqual(message?.attachments, [uploadPdf]);
  }),
);

it.effect("tells the client where each upload landed", () =>
  Effect.gen(function* () {
    const { placement } = yield* runStart({
      text: "have a look",
      attachments: [uploadPdf],
      materialization: {
        materialized: [
          {
            attachment: uploadPdf,
            relativePath: ".t3code/uploads/aa/bb-spec.pdf",
            absolutePath: "/workspace/.t3code/uploads/aa/bb-spec.pdf",
            status: "written",
          },
        ],
        promptBlock: "BLOCK",
        inlineAttachments: [],
        outcome: "written",
      },
    });

    const updated = placement.find((event) => event.type === "message.updated");
    assert.isDefined(updated);
    const attachments = updated?.type === "message.updated" ? updated.payload.attachments : [];
    assert.equal(attachments[0]?.workspacePath, ".t3code/uploads/aa/bb-spec.pdf");
    assert.equal(attachments[0]?.materialization, "written");
  }),
);

it.effect("stays silent about placement when there was no workspace to write to", () =>
  Effect.gen(function* () {
    const { placement } = yield* runStart({
      text: "have a look",
      attachments: [uploadPdf],
      materialization: {
        materialized: [],
        promptBlock: null,
        inlineAttachments: [uploadPdf],
        // A projectless thread. Reporting this as a failure would put a warning
        // in front of every user who never had a workspace.
        outcome: "skipped",
      },
    });

    assert.isUndefined(placement.find((event) => event.type === "message.updated"));
  }),
);
