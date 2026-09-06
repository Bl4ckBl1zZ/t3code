import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import {
  CheckpointServiceV2,
  checkpointRefForScopeOrdinal,
  layer as checkpointServiceLayer,
} from "./CheckpointService.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";

it.effect("materializes the baseline and summarizes V2 checkpoints with numstat", () => {
  const scope: OrchestrationV2CheckpointScope = {
    id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
    threadId: ThreadId.make("thread:materialize-baseline"),
    runId: RunId.make("run:materialize-baseline:3"),
    nodeId: NodeId.make("node:materialize-baseline:3"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/repo",
    createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
  };
  const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
    Effect.succeed(true),
  );
  const diffCheckpoints = vi.fn((input: CheckpointStore.DiffCheckpointsInput) =>
    input.format === "numstat"
      ? Effect.succeed("20000\t15000\tlarge.txt\0")
      : Effect.die("V2 summaries must not request a full patch"),
  );
  const testLayer = checkpointServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        idAllocatorLayer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          hasCheckpointRef,
          captureCheckpoint: () => Effect.void,
          diffCheckpoints,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const baseline = yield* checkpoints.materializeBaselineCheckpoint({
      scope,
      ordinalWithinScope: 2,
    });

    assert.equal(baseline.ordinalWithinScope, 2);
    assert.equal(
      baseline.ref,
      checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 2,
      }),
    );
    assert.equal(baseline.status, "ready");
    assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
      cwd: scope.cwd,
      checkpointRef: baseline.ref,
    });
    const captured = yield* checkpoints.capture({
      scope,
      runId: scope.runId,
      nodeId: scope.nodeId,
      ordinalWithinScope: 3,
      appRunOrdinal: 3,
      capturedAt: scope.createdAt,
    });
    assert.equal(captured.status, "ready");
    assert.deepEqual(captured.files, [
      { path: "large.txt", kind: "modified", additions: 20000, deletions: 15000 },
    ]);
  }).pipe(Effect.provide(testLayer));
});
