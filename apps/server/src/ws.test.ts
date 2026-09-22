import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import * as ModelManifest from "./provider/ModelManifest.ts";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  ProviderVersionCache,
} from "./provider/providerMaintenance.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import {
  bypassOwnedProviderCachesForRefresh,
  hasCompatibleOrchestrationProtocol,
  resolveAvailableEditorsForConfig,
  resolveFileManagerRevealKindForConfig,
} from "./ws.ts";

it("admits clients that speak this protocol or name none at all", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  // Every client shipped before negotiation. They speak this wire already.
  assert.isTrue(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws?wsTicket=t")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION + 1}`),
    ),
  );
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

it.effect("does not block server config when file manager reveal discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveFileManagerRevealKindForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const revealKind = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.isUndefined(revealKind);
  }),
);

for (const mode of ["all", "targeted", "background"] as const) {
  it.effect(`only an explicit provider refresh bypasses T3-owned caches (${mode})`, () => {
    const driver = ProviderDriverKind.make("codex");
    const instanceIds = [ProviderInstanceId.make("codex"), ProviderInstanceId.make("codex_work")];
    const packageNames = ["@example/personal", "@example/work"];
    const versionCache = new Map(
      packageNames.map((name) => [name, { expiresAt: Number.MAX_SAFE_INTEGER, version: "1.0.0" }]),
    );
    const invalidated: Array<string> = [];
    const freshMaintenance: Array<string> = [];
    let manifestRefreshed = false;
    const instances = instanceIds.map((instanceId, index) => {
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: driver,
        packageName: packageNames[index]!,
      });
      const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
        Effect.sync(() => {
          assert.isTrue(options?.fresh);
          freshMaintenance.push(instanceId);
          return maintenanceCapabilities;
        });
      return {
        instanceId,
        driverKind: driver,
        continuationIdentity: { driverKind: driver, continuationKey: instanceId },
        displayName: undefined,
        enabled: true,
        invalidateCaches: Effect.sync(() => {
          invalidated.push(instanceId);
        }),
        snapshot: {
          maintenanceCapabilities,
          // The second instance only carries static maintenance data.
          ...(index === 0 ? { resolveMaintenance } : {}),
          getSnapshot: Effect.never,
          refresh: Effect.never,
          streamChanges: Stream.empty,
        },
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
      } satisfies ProviderInstance;
    });
    const expected =
      mode === "background" ? [] : mode === "targeted" ? [instanceIds[1]!] : instanceIds;

    return Effect.gen(function* () {
      yield* bypassOwnedProviderCachesForRefresh({
        ...(mode === "targeted" ? { instanceId: instanceIds[1]! } : {}),
        ...(mode !== "background" ? { refreshModels: true } : {}),
      });
      assert.equal(manifestRefreshed, mode !== "background");
      assert.deepEqual(invalidated.toSorted(), expected.toSorted());
      assert.deepEqual(
        freshMaintenance,
        expected.filter((instanceId) => instanceId === instanceIds[0]),
      );
      for (let index = 0; index < instanceIds.length; index++) {
        assert.equal(
          versionCache.has(packageNames[index]!),
          !expected.includes(instanceIds[index]!),
        );
      }
    }).pipe(
      Effect.provideService(ProviderVersionCache, versionCache),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ModelManifest.ModelManifest)({
            forceRefresh: Effect.sync(() => {
              manifestRefreshed = true;
              return ModelManifest.BUNDLED_MODEL_MANIFEST;
            }),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed(instances),
          }),
        ),
      ),
    );
  });
}
