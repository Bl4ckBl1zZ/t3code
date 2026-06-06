import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  copyDesktopBuildArtifacts,
  createStagePnpmConfig,
  resolveDesktopRuntimeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "T3 Code (Alpha)");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "T3 Code (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "@t3tools/ssh": "workspace:*",
          "@t3tools/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePnpmConfig(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        patchedDependencies: {
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
      },
    );

    assert.equal(
      createStagePnpmConfig(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      undefined,
    );
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );

  it.effect("copies macOS app directory artifacts into the output directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-desktop-artifact-copy-test-",
      });
      const stageDistDir = path.join(root, "dist");
      const outputDir = path.join(root, "output");
      const stageAppAsar = path.join(
        stageDistDir,
        "mac-arm64",
        "T3 Code (Alpha).app",
        "Contents",
        "Resources",
        "app.asar",
      );
      const stageFrameworkDir = path.join(
        stageDistDir,
        "mac-arm64",
        "T3 Code (Alpha).app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
      );
      const outputAppAsar = path.join(
        outputDir,
        "T3 Code (Alpha).app",
        "Contents",
        "Resources",
        "app.asar",
      );
      const outputFrameworkBinaryLink = path.join(
        outputDir,
        "T3 Code (Alpha).app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      );

      yield* fs.makeDirectory(path.dirname(stageAppAsar), { recursive: true });
      yield* fs.writeFileString(stageAppAsar, "fresh app bundle");
      yield* fs.makeDirectory(path.join(stageFrameworkDir, "Versions", "A"), { recursive: true });
      yield* fs.writeFileString(
        path.join(stageFrameworkDir, "Versions", "A", "Electron Framework"),
        "framework",
      );
      yield* fs.symlink("A", path.join(stageFrameworkDir, "Versions", "Current"));
      yield* fs.symlink(
        "Versions/Current/Electron Framework",
        path.join(stageFrameworkDir, "Electron Framework"),
      );
      yield* fs.writeFileString(path.join(stageDistDir, "T3-Code-0.0.0-arm64.dmg"), "dmg");

      yield* fs.makeDirectory(path.dirname(outputAppAsar), { recursive: true });
      yield* fs.writeFileString(outputAppAsar, "stale app bundle");
      yield* fs.makeDirectory(path.join(outputDir, "mac-arm64"), { recursive: true });

      const copiedArtifacts = yield* copyDesktopBuildArtifacts({ stageDistDir, outputDir });

      assert.deepStrictEqual(copiedArtifacts.map((artifact) => path.basename(artifact)).sort(), [
        "T3 Code (Alpha).app",
        "T3-Code-0.0.0-arm64.dmg",
      ]);
      assert.equal(yield* fs.readFileString(outputAppAsar), "fresh app bundle");
      assert.equal(
        yield* fs.readFileString(path.join(outputDir, "T3-Code-0.0.0-arm64.dmg")),
        "dmg",
      );
      assert.equal(yield* fs.exists(path.join(outputDir, "mac-arm64")), false);
      assert.equal(
        yield* fs.readLink(outputFrameworkBinaryLink),
        "Versions/Current/Electron Framework",
      );
      assert.equal(yield* fs.exists(outputFrameworkBinaryLink), true);
    }),
  );
});
