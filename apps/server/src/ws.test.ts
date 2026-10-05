import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ExternalLauncher from "./process/externalLauncher.ts";

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
  withLateEditorConfig,
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

it.effect(
  "a fresh workspace refresh bypasses only the targeted instance's discovery caches",
  () => {
    const driver = ProviderDriverKind.make("claudeAgent");
    const instanceIds = [ProviderInstanceId.make("claude"), ProviderInstanceId.make("claude_work")];
    const invalidated: Array<string> = [];
    const instances = instanceIds.map(
      (instanceId) =>
        ({
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: instanceId },
          displayName: undefined,
          enabled: true,
          invalidateCaches: Effect.sync(() => {
            invalidated.push(instanceId);
          }),
          snapshot: {
            maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
              provider: driver,
              packageName: "@example/claude",
            }),
            getSnapshot: Effect.never,
            refresh: Effect.never,
            streamChanges: Stream.empty,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        }) satisfies ProviderInstance,
    );
    const versionCache = new Map([
      ["@example/claude", { expiresAt: Number.MAX_SAFE_INTEGER, version: "1.0.0" }],
    ]);

    return Effect.gen(function* () {
      // Without a cwd this is not a workspace rescan, so caches keep their timers.
      yield* bypassOwnedProviderCachesForRefresh({ instanceId: instanceIds[1]!, fresh: true });
      assert.deepEqual(invalidated, []);

      yield* bypassOwnedProviderCachesForRefresh({
        instanceId: instanceIds[1]!,
        cwd: "/workspace",
        fresh: true,
      });
      assert.deepEqual(invalidated, [instanceIds[1]!]);
      assert.isTrue(versionCache.has("@example/claude"));
    }).pipe(
      Effect.provideService(ProviderVersionCache, versionCache),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ModelManifest.ModelManifest)({
            forceRefresh: Effect.die("a workspace rescan must not refetch the model manifest"),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed(instances),
          }),
        ),
      ),
    );
  },
);

// Only the fields the late-editor fold reads or rewrites.
const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        // Holds the late snapshot until the settings change has gone out.
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("sends no late snapshot when the scan matches the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["vscode"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["vscode"]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      },
    ).pipe(Stream.runCollect);

    assert.equal(events.length, 0);
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

// The real launcher on Windows over a filesystem whose probes park until
// released, like a host too busy to finish discovery inside the snapshot timeout.
const makeParkedWindowsLauncher = Effect.gen(function* () {
  const parkedProbes = yield* Queue.unbounded<void>();
  const release = yield* Deferred.make<void>();
  const launcher = yield* ExternalLauncher.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Queue.offer(parkedProbes, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ type: "File" } as FileSystem.File.Info),
            ),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
        ),
      ),
    ),
  );
  const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-late-editors-test", PATHEXT: ".EXE" },
          }),
        ),
      ),
    );
  return {
    editors: {
      resolveAvailableEditors: () => onWindows(launcher.resolveAvailableEditors()),
      resolveFileManagerRevealKind: () => onWindows(launcher.resolveFileManagerRevealKind()),
    },
    probeParked: Queue.take(parkedProbes),
    releaseProbes: Deferred.succeed(release, undefined),
  };
});

it.effect("recovers editors after a real scan outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const snapshotFiber = yield* resolveAvailableEditorsForConfig(
      editors.resolveAvailableEditors(),
    ).pipe(Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(5));
    const snapshotEditors = yield* Fiber.join(snapshotFiber);
    assert.deepEqual(snapshotEditors, []);

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: snapshotEditors }),
      Stream.empty,
      editors,
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.availableEditors.includes("vscode"), true);
    }
  }).pipe(Effect.scoped),
);

it.effect("recovers a reveal kind whose real probe outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    // The snapshot's bounded probe timed out: file manager, but no reveal kind.
    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: editors.resolveFileManagerRevealKind,
      },
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(6));
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);
