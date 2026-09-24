import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";

const resolveUserData = (appDataDirectory: string) =>
  DesktopAppIdentity.resolveUserDataPath.pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopPreReadyFileSystem.layer,
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            appDataDirectory,
            userDataDirName: "t3code",
            legacyUserDataDirName: "T3 Code (Alpha)",
            path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
      ),
    ),
  );

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("keeps an existing legacy profile and otherwise uses the current one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });

      assert.equal(yield* resolveUserData(root), path.join(root, "t3code"));

      yield* fileSystem.makeDirectory(path.join(root, "T3 Code (Alpha)"));
      assert.equal(yield* resolveUserData(root), path.join(root, "T3 Code (Alpha)"));
    }),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "fails instead of treating an unreadable profile as missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(resolveUserData(root));

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});
