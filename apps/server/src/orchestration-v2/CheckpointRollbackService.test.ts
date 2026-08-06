import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  CheckpointRollbackServiceV2,
  layer as checkpointRollbackServiceLayer,
} from "./CheckpointRollbackService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreReadError, ProjectionStoreV2 } from "./ProjectionStore.ts";
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
          getThreadProjection: () => Effect.succeed(projection),
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
          getThreadProjection: () => Effect.succeed(projection),
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
          getThreadProjection: () => Effect.succeed(projection),
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
          getThreadProjection: () => Effect.succeed(projection),
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

it.effect("wraps underlying failures with an unexpected-failure reason and cause", () => {
  const threadId = ThreadId.make("thread:rollback-unexpected-failure");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-unexpected-failure");
  const checkpointId = CheckpointId.make("checkpoint:rollback-unexpected-failure");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-unexpected-failure");
  const projectionError = new ProjectionStoreReadError({
    threadId,
    cause: new Error("database read failed"),
  });
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({}),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadProjection: () => Effect.fail(projectionError),
        }),
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.mock(RuntimePolicyV2)({}),
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

    assert.equal(error.reason, "unexpected-failure");
    assert.equal(
      error.message,
      `Failed to execute rollback target ${checkpointId} on provider thread ${providerThreadId} for thread ${threadId}.`,
    );
    assert.strictEqual(error.cause, projectionError);
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
          getThreadProjection: () => Effect.succeed(projection),
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
      // Past every surviving item, ahead of the next run's first item.
      ordinal: 100,
    });
  }).pipe(Effect.provide(testLayer));
});
