import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Sink, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect } from "vite-plus/test";
import { HermesWorkError } from "@t3tools/contracts";
import {
  makeHermesWorkInstaller,
  hermesInstallDiagnostic,
  HermesWorkInstaller,
  hermesWorkInstallerLayer,
} from "./HermesWorkInstaller.ts";

describe("Hermes explicit installation", () => {
  it("keeps bounded actionable installer errors while redacting credentials", () => {
    const diagnostic = hermesInstallDiagnostic(
      "token=secret\ngateway_token: secret\nHERMES_GATEWAY_TOKEN=secret\nAuthorization: Bearer secret\nhttps://user:password@example.com/install?token=secret\nerror: git not found",
    );
    expect(diagnostic).toContain("git not found");
    expect(diagnostic).not.toContain("secret");
    expect(diagnostic).not.toContain("user:password");
    expect(hermesInstallDiagnostic("x".repeat(10000)).length).toBeLessThanOrEqual(1500);
  });

  it.effect("uses an existing command without invoking installation", () =>
    Effect.gen(function* () {
      let installs = 0;
      const installer = yield* makeHermesWorkInstaller({
        discover: () => Effect.succeed("/custom/bin/hermes"),
        install: () =>
          Effect.sync(() => {
            installs++;
          }),
      });
      expect(yield* installer.ensureInstalled()).toEqual({
        binaryPath: "/custom/bin/hermes",
        installed: false,
      });
      expect(installs).toBe(0);
    }),
  );
  it.effect("installs only after an explicit call and discovers the new command", () =>
    Effect.gen(function* () {
      let installed = false;
      const installer = yield* makeHermesWorkInstaller({
        discover: () => Effect.succeed(installed ? "/home/me/.local/bin/hermes" : null),
        install: () =>
          Effect.sync(() => {
            installed = true;
          }),
      });
      expect(installed).toBe(false);
      expect(yield* installer.ensureInstalled()).toEqual({
        binaryPath: "/home/me/.local/bin/hermes",
        installed: true,
      });
    }),
  );
  it.effect("reports installation errors without claiming success", () =>
    Effect.gen(function* () {
      const installer = yield* makeHermesWorkInstaller({
        discover: () => Effect.succeed(null),
        install: () =>
          Effect.fail(new HermesWorkError({ code: "unavailable", message: "Download failed." })),
      });
      const result = yield* installer.ensureInstalled().pipe(
        Effect.match({
          onSuccess: () => "unexpected success",
          onFailure: (error) => error.message,
        }),
      );
      expect(result).toBe("Download failed.");
    }),
  );
  it.effect("serializes simultaneous setup requests without reinstalling", () =>
    Effect.gen(function* () {
      let installs = 0;
      let installed = false;
      const installer = yield* makeHermesWorkInstaller({
        discover: () => Effect.succeed(installed ? "/bin/hermes" : null),
        install: () =>
          Effect.gen(function* () {
            installs++;
            yield* Effect.yieldNow;
            installed = true;
          }),
      });
      yield* Effect.all([installer.ensureInstalled(), installer.ensureInstalled()], {
        concurrency: 2,
      });
      expect(installs).toBe(1);
    }),
  );
});

it.effect("times out a stalled installation stage and releases its process scope", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let released = false;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected standard command");
        const stalled = command.command === "bash";
        if (stalled) {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true;
            }),
          );
          yield* Deferred.succeed(started, undefined);
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: stalled
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(command.command === "curl" ? 0 : 1)),
          isRunning: Effect.succeed(stalled),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const installer = yield* HermesWorkInstaller.pipe(
      Effect.provide(hermesWorkInstallerLayer),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessEnvironment, {
        HOME: "/nonexistent-hermes-test-home",
        PATH: "",
      }),
      Effect.provideService(HostProcessPlatform, "darwin"),
    );
    const fiber = yield* installer.ensureInstalled().pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 minutes");
    const result = yield* Fiber.join(fiber);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("unavailable");
      expect(result.failure.message).toContain("timed out during prerequisites");
    }
    expect(released).toBe(true);
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, TestClock.layer()])),
);
