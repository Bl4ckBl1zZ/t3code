import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { BROWSER_AGENT_EXTENSION_SOURCE_DIR_NAME } from "@t3tools/shared/browserAgent";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

export interface BrowserAgentExtensionInstall {
  readonly sourceDir: string;
  readonly destinationDir: string;
}

export interface DesktopBrowserAgentExtensionShape {
  readonly syncInstallFolder: Effect.Effect<Option.Option<BrowserAgentExtensionInstall>>;
}

export class DesktopBrowserAgentExtension extends Context.Service<
  DesktopBrowserAgentExtension,
  DesktopBrowserAgentExtensionShape
>()("@t3tools/desktop/app/DesktopBrowserAgentExtension") {}

const INSTALL_DIR_NAME = "Chrome Extension";

const { logInfo: logExtensionInfo, logWarning: logExtensionWarning } =
  DesktopObservability.makeComponentLogger("desktop-browser-agent-extension");

let tempInstallCounter = 0;

const nextTempInstallCounter = Effect.sync(() => {
  tempInstallCounter += 1;
  return tempInstallCounter;
});

export function resolveBrowserAgentExtensionInstallPath(
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): string {
  return environment.path.join(
    environment.appDataDirectory,
    environment.userDataDirName,
    INSTALL_DIR_NAME,
  );
}

export function resolveBrowserAgentExtensionSourceCandidates(
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): readonly string[] {
  const candidates = [
    environment.path.join(environment.appRoot, "apps", BROWSER_AGENT_EXTENSION_SOURCE_DIR_NAME),
    environment.path.join(environment.resourcesPath, BROWSER_AGENT_EXTENSION_SOURCE_DIR_NAME),
    ...environment.resolveResourcePathCandidates(BROWSER_AGENT_EXTENSION_SOURCE_DIR_NAME),
  ];
  return Array.from(new Set(candidates));
}

const findSourceDir = Effect.fn("desktop.browserAgentExtension.findSourceDir")(function* (
  candidates: readonly string[],
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;

  for (const candidate of candidates) {
    const fileInfo = yield* fileSystem.stat(candidate).pipe(Effect.option);
    if (Option.isSome(fileInfo) && fileInfo.value.type === "Directory") {
      return Option.some(candidate);
    }
  }

  return Option.none();
});

const replaceDirectory = Effect.fn("desktop.browserAgentExtension.replaceDirectory")(
  function* (input: {
    readonly sourceDir: string;
    readonly destinationDir: string;
  }): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempId = yield* nextTempInstallCounter;
    const tempDir = `${input.destinationDir}.tmp-${process.pid}-${tempId}`;

    const install = Effect.gen(function* () {
      yield* fileSystem.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore);
      yield* fileSystem.makeDirectory(path.dirname(input.destinationDir), {
        recursive: true,
      });
      yield* fileSystem.copy(input.sourceDir, tempDir);
      yield* fileSystem
        .remove(input.destinationDir, { recursive: true, force: true })
        .pipe(Effect.ignore);
      yield* fileSystem.rename(tempDir, input.destinationDir);
    });

    yield* install.pipe(
      Effect.ensuring(
        fileSystem.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  },
);

const syncInstallFolder = Effect.fn("desktop.browserAgentExtension.syncInstallFolder")(function* (
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): Effect.fn.Return<
  Option.Option<BrowserAgentExtensionInstall>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const sourceDir = yield* findSourceDir(resolveBrowserAgentExtensionSourceCandidates(environment));
  if (Option.isNone(sourceDir)) {
    yield* logExtensionWarning("browser agent extension source folder not found", {
      candidates: resolveBrowserAgentExtensionSourceCandidates(environment),
    });
    return Option.none();
  }

  const install = {
    sourceDir: sourceDir.value,
    destinationDir: resolveBrowserAgentExtensionInstallPath(environment),
  } satisfies BrowserAgentExtensionInstall;

  yield* replaceDirectory(install);
  yield* logExtensionInfo("synced browser agent extension install folder", install);
  return Option.some(install);
});

export const layer = Layer.effect(
  DesktopBrowserAgentExtension,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return DesktopBrowserAgentExtension.of({
      syncInstallFolder: syncInstallFolder(environment).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catch((error) =>
          logExtensionWarning("failed to sync browser agent extension install folder", {
            message: error.message,
            destinationDir: resolveBrowserAgentExtensionInstallPath(environment),
          }).pipe(Effect.as(Option.none())),
        ),
      ),
    });
  }),
);
