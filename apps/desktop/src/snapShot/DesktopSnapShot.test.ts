// @effect-diagnostics nodeBuiltinImport:off -- The mocked native capture writes its output through its Promise boundary.
import * as NodeFSP from "node:fs/promises";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type DesktopSnapShotEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const mocks = vi.hoisted(() => ({
  screen: vi.fn(() => "granted"),
  trusted: vi.fn(() => true),
  register: vi.fn(() => true),
  unregister: vi.fn(),
  permissions: vi.fn(),
  capture: vi.fn(),
  read: vi.fn(),
  warm: vi.fn(),
  cool: vi.fn(),
  close: vi.fn(),
  startPair: vi.fn(async () => vi.fn()),
}));
vi.mock("electron", () => ({
  systemPreferences: {
    getMediaAccessStatus: mocks.screen,
    isTrustedAccessibilityClient: mocks.trusted,
    getAnimationSettings: () => ({ prefersReducedMotion: true, shouldRenderRichAnimation: false }),
  },
  globalShortcut: { register: mocks.register, unregister: mocks.unregister },
  desktopCapturer: { getSources: mocks.permissions },
  shell: { openExternal: mocks.permissions },
  BrowserWindow: { getFocusedWindow: () => undefined },
  nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 100, height: 80 }) }) },
}));
vi.mock("./ActiveWindow.ts", () => ({
  activeWindow: async () => ({
    platform: "macos",
    id: 42,
    title: "main.ts",
    bounds: { x: 10, y: 20, width: 100, height: 80 },
    owner: { name: "Editor", processId: 123 },
  }),
}));
vi.mock("./MacSnapShot.ts", () => ({ captureMacWindowSnapshot: mocks.capture }));
vi.mock("./MacModifierPairShortcutProcess.ts", () => ({
  startMacModifierPairShortcutProcess: mocks.startPair,
}));
vi.mock("./SnapShotAccessibilityProcess.ts", () => ({
  makeSnapShotAccessibilityProcessPool: () => ({
    read: mocks.read,
    warm: mocks.warm,
    cool: mocks.cool,
    close: mocks.close,
  }),
}));
vi.mock("./SnapShotTransition.ts", () => ({
  SnapShotTransition: class {
    dispose() {}
    dismiss() {}
    async complete() {}
  },
}));
import * as DesktopSnapShot from "./DesktopSnapShot.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.screen.mockReturnValue("granted");
  mocks.trusted.mockReturnValue(true);
});
const enabled: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  snapShotEnabled: true,
  snapShotIncludeAccessibility: false,
  snapShotFlash: false,
  snapShotAnimations: false,
  snapShotShortcut: {
    key: "2",
    modKey: true,
    shiftKey: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  },
};

const withCapture = <A, E>(
  run: (
    service: DesktopSnapShot.DesktopSnapShot["Service"],
    events: DesktopSnapShotEvent[],
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-snapshot-test-" });
      const events: DesktopSnapShotEvent[] = [];
      mocks.capture.mockImplementation(async (_active, outputPath) => {
        const png = Buffer.from([137, 80, 78, 71]);
        await NodeFSP.writeFile(outputPath, png);
        return { source: { name: "main.ts" }, png };
      });
      const service = yield* DesktopSnapShot.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopEnvironment.layer({
              dirname: "/repo/apps/desktop/dist-electron",
              homeDirectory: directory,
              platform: "darwin",
              processArch: "arm64",
              appVersion: "0.0.38",
              appPath: "/repo/apps/desktop",
              isPackaged: false,
              resourcesPath: "/repo/resources",
              runningUnderArm64Translation: false,
            }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: directory }))),
            Layer.mock(DesktopClientSettings.DesktopClientSettings)({
              get: Effect.succeed(Option.none()),
            }),
            Layer.mock(DesktopWindow.DesktopWindow)({
              activate: Effect.void,
              dispatchSnapShotEvent: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            }),
          ),
        ),
      );
      return yield* run(service, events);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("does not capture or request access at startup; disabled capture is rejected", () =>
  withCapture((service) =>
    Effect.gen(function* () {
      yield* service.initialize;
      const failure = yield* service.capture.pipe(Effect.flip);
      assert.equal(failure.operation, "disabled");
      assert.equal(mocks.capture.mock.calls.length, 0);
      assert.equal(mocks.permissions.mock.calls.length, 0);
      assert.equal(mocks.register.mock.calls.length, 0);
    }),
  ),
);

it.effect("keeps capture data queued until explicit acknowledgement", () =>
  withCapture((service, events) =>
    Effect.gen(function* () {
      yield* service.configure(enabled);
      yield* service.capture;
      const pending = yield* service.listPending;
      assert.equal(pending.length, 1);
      assert.deepEqual(
        events.map((event) => event.type),
        ["requested", "ready"],
      );
      assert.equal(pending[0]!.source.appName, "Editor");
      assert.equal(pending[0]!.source.accessibility, undefined);
      assert.equal(mocks.read.mock.calls.length, 0);
      const capture = yield* service.read(pending[0]!.id);
      assert.equal(capture.dataUrl, "data:image/png;base64,iVBORw==");
      yield* service.acknowledge(capture.id);
      assert.deepEqual(yield* service.listPending, []);
    }),
  ),
);

it.effect(
  "keeps the shortcut across unrelated settings saves and releases only its own binding",
  () =>
    withCapture((service) =>
      Effect.gen(function* () {
        yield* service.configure(enabled);
        yield* service.configure({ ...enabled, wordWrap: false });
        assert.equal(mocks.register.mock.calls.length, 1);
        yield* service.configure({ ...enabled, snapShotEnabled: false });
        assert.deepEqual(mocks.unregister.mock.calls, [["CommandOrControl+Shift+2"]]);
      }),
    ),
);

it.effect("reports revoked permission and recovers registration after access returns", () =>
  withCapture((service) =>
    Effect.gen(function* () {
      mocks.screen.mockReturnValue("denied");
      yield* service.configure(enabled);
      assert.equal((yield* service.state).shortcutRegistered, false);
      assert.equal(mocks.register.mock.calls.length, 0);
      mocks.screen.mockReturnValue("granted");
      assert.equal((yield* service.state).shortcutRegistered, true);
      assert.equal(mocks.permissions.mock.calls.length, 0);
    }),
  ),
);
