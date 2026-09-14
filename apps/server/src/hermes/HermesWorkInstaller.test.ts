import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";
import { HermesWorkError } from "@t3tools/contracts";
import { makeHermesWorkInstaller, hermesInstallDiagnostic } from "./HermesWorkInstaller.ts";

describe("Hermes explicit installation", () => {
  it("keeps bounded actionable installer errors while redacting credentials", () => {
    const diagnostic = hermesInstallDiagnostic(
      "Authorization: Bearer secret\nhttps://user:password@example.com/install?token=secret\nerror: git not found",
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
