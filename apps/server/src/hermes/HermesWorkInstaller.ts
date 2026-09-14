import { hermesProcessDiagnostic as hermesInstallDiagnostic } from "./HermesProcessDiagnostic.ts";
import { HermesWorkError } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { Context, Effect, FileSystem, Layer, Path, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const HERMES_INSTALL_REVISION = "abf4706384c8ab17d6f22aab0ab8c71526eac305";
export const HERMES_INSTALL_URL = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_INSTALL_REVISION}/scripts/install.sh`;
export const HERMES_INSTALL_STAGES = [
  "prerequisites",
  "repository",
  "venv",
  "python-deps",
  "node-deps",
  "path",
  "config",
  "complete",
] as const;
export { hermesProcessDiagnostic as hermesInstallDiagnostic } from "./HermesProcessDiagnostic.ts";
export interface HermesWorkInstallation {
  readonly binaryPath: string;
  readonly installed: boolean;
}
export class HermesWorkInstaller extends Context.Service<
  HermesWorkInstaller,
  {
    readonly ensureInstalled: () => Effect.Effect<HermesWorkInstallation, HermesWorkError>;
  }
>()("t3/hermes/HermesWorkInstaller") {}

export interface HermesWorkInstallerOperations {
  readonly discover: () => Effect.Effect<string | null, HermesWorkError>;
  readonly install: () => Effect.Effect<void, HermesWorkError>;
}

/** Installation only occurs when the explicit setup command calls this method. */
export const makeHermesWorkInstaller = (operations: HermesWorkInstallerOperations) =>
  Effect.gen(function* () {
    const mutex = yield* Semaphore.make(1);
    const ensureInstalled = Effect.fn("HermesWorkInstaller.ensureInstalled")(function* () {
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const existing = yield* operations.discover();
          if (existing) return { binaryPath: existing, installed: false };
          yield* operations.install();
          const binaryPath = yield* operations.discover();
          if (!binaryPath)
            return yield* new HermesWorkError({
              code: "unavailable",
              message:
                "Hermes installation finished but its command could not be started. Check the installation before retrying setup.",
            });
          return { binaryPath, installed: true };
        }),
      );
    });
    return HermesWorkInstaller.of({ ensureInstalled });
  });

export const hermesWorkInstallerLayer = Layer.effect(
  HermesWorkInstaller,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = yield* HostProcessEnvironment;
    const platform = yield* HostProcessPlatform;
    const home = environment.HOME ?? environment.USERPROFILE;
    const homeBin = home ? path.join(home, ".local", "bin") : undefined;
    const installEnvironment = {
      ...environment,
      PATH: [homeBin, environment.PATH].filter(Boolean).join(path.sep === "\\" ? ";" : ":"),
    };
    const run = Effect.fn("HermesWorkInstaller.run")(function* (
      binary: string,
      args: ReadonlyArray<string>,
    ) {
      const handle = yield* spawner.spawn(
        ChildProcess.make(binary, args, {
          env: installEnvironment,
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "5 seconds",
        }),
      );
      const [code, output] = yield* Effect.all(
        [
          handle.exitCode,
          handle.all.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (tail, chunk) => (tail + chunk).slice(-8000),
            ),
          ),
        ],
        { concurrency: 2 },
      );
      return { code, diagnostic: hermesInstallDiagnostic(output) };
    }, Effect.scoped);
    const discover = Effect.fn("HermesWorkInstaller.discover")(function* () {
      const candidates = new Set<string>();
      if (environment.HERMES_BINARY_PATH) candidates.add(environment.HERMES_BINARY_PATH);
      for (const directory of (installEnvironment.PATH ?? "")
        .split(platform === "win32" ? ";" : ":")
        .filter(Boolean))
        candidates.add(path.join(directory, platform === "win32" ? "hermes.exe" : "hermes"));
      if (homeBin) candidates.add(path.join(homeBin, "hermes"));
      if (platform !== "win32") candidates.add("/usr/local/bin/hermes");
      for (const candidate of candidates) {
        const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
        if (!exists) continue;
        const usable = yield* run(candidate, ["--version"]).pipe(
          Effect.map((result) => result.code === 0),
          Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.succeed(false) }),
          Effect.orElseSucceed(() => false),
        );
        if (usable) return candidate;
      }
      return null;
    });
    const install = Effect.fn("HermesWorkInstaller.install")(function* () {
      if (platform === "win32")
        return yield* new HermesWorkError({
          code: "unsupported",
          message:
            "Install Hermes in WSL or connect to an existing Hermes environment, then retry setup.",
        });
      if (!home)
        return yield* new HermesWorkError({
          code: "unavailable",
          message: "The environment has no home directory for installing Hermes.",
        });
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-install-" }).pipe(
        Effect.mapError(
          () =>
            new HermesWorkError({
              code: "unavailable",
              message: "Could not prepare the Hermes installer.",
            }),
        ),
      );
      const script = path.join(temporary, "install.sh");
      const download = yield* run("curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "20",
        "--max-time",
        "120",
        "--output",
        script,
        HERMES_INSTALL_URL,
      ]).pipe(
        Effect.mapError(
          () =>
            new HermesWorkError({
              code: "unavailable",
              message:
                "Could not download the official Hermes installer. Check that curl is installed and the environment can reach GitHub.",
            }),
        ),
      );
      if (download.code !== 0)
        return yield* new HermesWorkError({
          code: "unavailable",
          message:
            "Downloading the official Hermes installer failed. Check the environment's connection and retry.",
        });
      // Native staged bootstrap omits API-key setup and gateway-service installation.
      for (const stage of HERMES_INSTALL_STAGES) {
        const code = yield* run("bash", [
          script,
          "--non-interactive",
          "--skip-setup",
          "--commit",
          HERMES_INSTALL_REVISION,
          "--stage",
          stage,
        ]).pipe(
          Effect.mapError(
            () =>
              new HermesWorkError({
                code: "unavailable",
                message: `Hermes installation could not start the ${stage} stage. Check that bash is available.`,
              }),
          ),
        );
        if (code.code !== 0)
          return yield* new HermesWorkError({
            code: "unavailable",
            message: `Hermes installation failed during ${stage} (exit ${code.code}). ${code.diagnostic || "Check the installation prerequisites, then retry setup."}`,
          });
      }
    }, Effect.scoped);
    return yield* makeHermesWorkInstaller({ discover, install });
  }),
);
