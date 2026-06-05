import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopBrowserAgentExtension from "./DesktopBrowserAgentExtension.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const makeEnvironmentLayer = (input: {
  readonly rootDir: string;
  readonly homeDirectory: string;
}) =>
  DesktopEnvironment.layer({
    dirname: `${input.rootDir}/apps/desktop/dist-electron`,
    homeDirectory: input.homeDirectory,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.0.24",
    appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
    isPackaged: false,
    resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));

const makeBrowserAgentExtensionLayer = (input: {
  readonly rootDir: string;
  readonly homeDirectory: string;
}) =>
  DesktopBrowserAgentExtension.layer.pipe(
    Layer.provideMerge(makeEnvironmentLayer(input)),
    Layer.provideMerge(NodeServices.layer),
  );

describe("DesktopBrowserAgentExtension", () => {
  it.effect("resolves the stable local app-data install path and source candidates", () =>
    Effect.gen(function* () {
      const rootDir = "/repo";
      const homeDirectory = "/Users/alice";
      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(makeEnvironmentLayer({ rootDir, homeDirectory })),
      );

      assert.equal(
        DesktopBrowserAgentExtension.resolveBrowserAgentExtensionInstallPath(environment),
        "/Users/alice/Library/Application Support/t3code/Chrome Extension",
      );
      assert.include(
        DesktopBrowserAgentExtension.resolveBrowserAgentExtensionSourceCandidates(environment),
        "/repo/apps/chrome-extension",
      );
    }),
  );

  it.effect("fully replaces the local extension folder from the app source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const rootDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-extension-root-",
      });
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-extension-home-",
      });
      const sourceDir = `${rootDir}/apps/chrome-extension`;
      const sourceNestedDir = `${sourceDir}/nested`;
      yield* fileSystem.makeDirectory(sourceNestedDir, { recursive: true });
      yield* fileSystem.writeFileString(`${sourceDir}/manifest.json`, "{}");
      yield* fileSystem.writeFileString(`${sourceNestedDir}/content.js`, "export {};\n");

      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(makeEnvironmentLayer({ rootDir, homeDirectory })),
      );
      const destinationDir =
        DesktopBrowserAgentExtension.resolveBrowserAgentExtensionInstallPath(environment);
      yield* fileSystem.makeDirectory(destinationDir, { recursive: true });
      yield* fileSystem.writeFileString(`${destinationDir}/stale.txt`, "remove me");

      const result = yield* Effect.gen(function* () {
        const browserAgentExtension =
          yield* DesktopBrowserAgentExtension.DesktopBrowserAgentExtension;
        return yield* browserAgentExtension.syncInstallFolder;
      }).pipe(Effect.provide(makeBrowserAgentExtensionLayer({ rootDir, homeDirectory })));

      assert.deepEqual(
        Option.map(result, (install) => install.sourceDir),
        Option.some(sourceDir),
      );
      assert.isFalse(yield* fileSystem.exists(`${destinationDir}/stale.txt`));
      assert.equal(
        yield* fileSystem.readFileString(`${destinationDir}/nested/content.js`),
        "export {};\n",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
