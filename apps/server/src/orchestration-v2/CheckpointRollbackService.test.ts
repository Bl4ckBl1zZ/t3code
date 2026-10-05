import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveCodexRollbackTurnCount } from "./Adapters/CodexAdapterV2.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  CheckpointRollbackExecutionError,
  CheckpointRollbackServiceV2,
  layer as checkpointRollbackServiceLayer,
  ROLLBACK_FAILED_MESSAGE,
} from "./CheckpointRollbackService.ts";
import { OrchestrationEffectExecutionError } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreReadError, ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackThreadInput } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect("rejects a non-ready checkpoint before opening a session or restoring files", () => {
  const threadId = ThreadId.make("thread:rollback-non-ready");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
  const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    checkpoints: [{ id: checkpointId, scopeId, status: "stale" }],
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "rollback-target-invalid");
    assert.equal(
      error.message,
      `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when another provider thread became active", () => {
  const threadId = ThreadId.make("thread:rollback-inactive-provider-thread");
  const requestedProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:requested",
  );
  const activeProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:active",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-inactive-provider-thread",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-inactive-provider-thread");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-inactive-provider-thread");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_inactive_provider_thread");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: requestedProviderThreadId,
        providerSessionId,
        providerInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId: requestedProviderThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when provider selection changed before execution", () => {
  const threadId = ThreadId.make("thread:rollback-provider-selection-changed");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-selection-changed",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-selection-changed",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-selection-changed");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-selection-changed");
  const originalProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_original",
  );
  const selectedProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_selected",
  );
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: selectedProviderInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        providerInstanceId: originalProviderInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reports a missing provider turn as a structured rollback failure", () => {
  const threadId = ThreadId.make("thread:rollback-provider-turn-unavailable");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-turn-unavailable",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-turn-unavailable",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-turn-unavailable");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-turn-unavailable");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_provider_turn_unavailable");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    providerSessions: [],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 }],
    checkpointScopes: [{ id: scopeId }],
    runs: [],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () => Effect.succeed({} as never),
        }),
        Layer.mock(RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "provider-turn-unavailable");
    assert.equal(
      error.message,
      `Provider turn for rollback target ${checkpointId} is unavailable on provider thread ${providerThreadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("leaves a runless rollback marker so the discarded work stays visible", () => {
  const threadId = ThreadId.make("thread:rollback-marker");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-marker");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-marker");
  const checkpointId = CheckpointId.make("checkpoint:rollback-marker");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-marker");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_marker");
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId,
    driver: "claudeAgent",
  };
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    providerTurns: [],
    attempts: [],
    nodes: [],
    runs: [
      { id: "run-1", ordinal: 1, status: "completed", providerInstanceId, rootNodeId: null },
      { id: "run-2", ordinal: 2, status: "completed", providerInstanceId, rootNodeId: null },
    ],
    checkpoints: [
      {
        id: checkpointId,
        scopeId,
        status: "ready",
        appRunOrdinal: 0,
        runId: null,
        nodeId: "node-1",
        files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
      },
    ],
    checkpointScopes: [{ id: scopeId }],
  } as unknown as OrchestrationV2ThreadProjection;
  const written: Array<{ readonly events: ReadonlyArray<{ readonly type: string }> }> = [];
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({
          restore: () => Effect.void,
          deleteStaleRefs: () => Effect.void,
        }),
        Layer.mock(EventSinkV2)({
          write: ((input: { readonly events: ReadonlyArray<{ readonly type: string }> }) => {
            written.push(input);
            return Effect.void;
          }) as never,
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: (() =>
            Effect.succeed({ rollbackThread: () => Effect.succeed({ providerThread }) })) as never,
        }),
        Layer.mock(RuntimePolicyV2)({ resolve: (() => Effect.succeed({})) as never }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId });

    const events = written.flatMap((batch) => batch.events);
    const markers = events.filter((event) => event.type === "turn-item.updated");
    assert.equal(markers.length, 1);
    const marker = markers[0] as unknown as {
      readonly payload: Record<string, unknown>;
    };
    assert.deepInclude(marker.payload, {
      type: "checkpoint_rollback",
      threadId,
      // Runless on purpose: run-scoped items vanish with the runs they belong to.
      runId: null,
      checkpointId,
      scopeId,
      restoredFileCount: 3,
      rolledBackRunCount: 2,
      // Past every surviving item, ahead of the next run's first item: the
      // head of the discarded run's runOrdinal * 1_000_000 position band.
      ordinal: 1_000_000,
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect.each([{ targetOrdinal: 0 }, { targetOrdinal: 1 }])(
  "skips turns an earlier rollback already removed when rewinding to run %s",
  ({ targetOrdinal }) => {
    const threadId = ThreadId.make("thread:rollback-repeat");
    const providerThreadId = ProviderThreadId.make("provider-thread:rollback-repeat");
    const providerSessionId = ProviderSessionId.make("provider-session:rollback-repeat");
    const checkpointId = CheckpointId.make("checkpoint:rollback-repeat");
    const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-repeat");
    const providerInstanceId = ProviderInstanceId.make("provider_rollback_repeat");
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId,
      driver: "codex",
    };
    const counts: Array<number> = [];
    const projection = {
      thread: {
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      },
      providerThreads: [providerThread],
      providerSessions: [],
      // Turn 3 remains in the audit history after an earlier rollback.
      providerTurns: [1, 2, 3].map((ordinal) => ({
        id: `turn-${ordinal}`,
        providerThreadId,
        runAttemptId: `attempt-${ordinal}`,
        ordinal,
        status: "completed",
      })),
      attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, runId: `run-${ordinal}` })),
      nodes: [],
      runs: [1, 2, 3].map((ordinal) => ({
        id: `run-${ordinal}`,
        ordinal,
        status: ordinal === 3 ? "rolled_back" : "completed",
        providerInstanceId,
        rootNodeId: null,
        activeAttemptId: `attempt-${ordinal}`,
      })),
      checkpoints: [
        {
          id: checkpointId,
          scopeId,
          status: "ready",
          appRunOrdinal: targetOrdinal,
          runId: null,
          nodeId: "node-1",
          files: [],
        },
      ],
      checkpointScopes: [{ id: scopeId }],
    } as unknown as OrchestrationV2ThreadProjection;
    const testLayer = checkpointRollbackServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointServiceV2)({
            restore: () => Effect.void,
            deleteStaleRefs: () => Effect.void,
          }),
          Layer.mock(EventSinkV2)({ write: (() => Effect.void) as never }),
          idAllocatorLayer,
          Layer.mock(ProjectionStoreV2)({
            getThreadRecords: () => Effect.succeed(projection),
          }),
          Layer.mock(ProviderSessionManagerV2)({
            open: (() =>
              Effect.succeed({
                rollbackThread: (input: ProviderAdapterV2RollbackThreadInput) =>
                  resolveCodexRollbackTurnCount(input).pipe(
                    Effect.map((count) => {
                      counts.push(count);
                      return { providerThread };
                    }),
                  ),
              })) as never,
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: (() => Effect.succeed({})) as never }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* CheckpointRollbackServiceV2;
      yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId });
      assert.deepEqual(counts, [2 - targetOrdinal]);
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect("records a rollback that failed for good with the reason the client shows", () => {
  const threadId = ThreadId.make("thread:rollback-failure");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-failure");
  const checkpointId = CheckpointId.make("checkpoint:rollback-failure");
  const requestId = CommandId.make("command:rollback-failure");
  const thread = {
    id: threadId,
    providerInstanceId: ProviderInstanceId.make("provider_rollback_failure"),
    rollbackFailure: null,
    deletedAt: null,
  };
  const written: Array<{ readonly events: ReadonlyArray<unknown> }> = [];
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({}),
        Layer.mock(EventSinkV2)({
          write: ((input: { readonly events: ReadonlyArray<unknown> }) => {
            written.push(input);
            return Effect.succeed([]);
          }) as never,
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: (() => Effect.succeed({ thread })) as never,
        }),
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.mock(RuntimePolicyV2)({}),
      ),
    ),
  );
  const recorded = () =>
    written
      .flatMap((batch) => batch.events)
      .map(
        (event) =>
          (
            event as {
              readonly type: string;
              readonly payload: { readonly rollbackFailure: unknown };
            }
          ).payload.rollbackFailure,
      );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    // The worker hands over its own wrapper; the structured reason inside it
    // is what the user reads.
    yield* service.recordPermanentFailure({
      threadId,
      requestId,
      cause: new OrchestrationEffectExecutionError({
        effectId: "effect:rollback-failure",
        effectType: "provider-thread.rollback",
        cause: new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId,
          providerThreadId,
          checkpointId,
        }),
      }),
    });
    // A failure with no structured reason falls back to the generic message.
    yield* service.recordPermanentFailure({ threadId, requestId });

    assert.deepEqual(recorded(), [
      {
        requestId,
        message: `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
      },
      { requestId, message: ROLLBACK_FAILED_MESSAGE },
    ]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("drops a late failure from a rollback that a newer one superseded", () => {
  const threadId = ThreadId.make("thread:rollback-superseded");
  const olderRequestId = CommandId.make("command:rollback-superseded-older");
  const newerRequestId = CommandId.make("command:rollback-superseded-newer");
  const thread = {
    id: threadId,
    providerInstanceId: ProviderInstanceId.make("provider_rollback_superseded"),
    rollbackRequestId: newerRequestId,
    rollbackFailure: null,
    deletedAt: null,
  };
  const written: Array<{ readonly events: ReadonlyArray<unknown> }> = [];
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({}),
        Layer.mock(EventSinkV2)({
          write: ((input: { readonly events: ReadonlyArray<unknown> }) => {
            written.push(input);
            return Effect.succeed([]);
          }) as never,
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: (() => Effect.succeed({ thread })) as never,
        }),
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.mock(RuntimePolicyV2)({}),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    yield* service.recordPermanentFailure({ threadId, requestId: olderRequestId });
    assert.deepEqual(written, []);

    yield* service.recordPermanentFailure({ threadId, requestId: newerRequestId });
    assert.deepEqual(
      written
        .flatMap((batch) => batch.events)
        .map(
          (event) =>
            (event as { readonly payload: { readonly rollbackFailure: unknown } }).payload
              .rollbackFailure,
        ),
      [{ requestId: newerRequestId, message: ROLLBACK_FAILED_MESSAGE }],
    );
  }).pipe(Effect.provide(testLayer));
});
