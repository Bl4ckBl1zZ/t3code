// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { OrchestrationV2GetWorkflowScriptError } from "@t3tools/contracts";

import { readWorkflowScript } from "./WorkflowScriptQuery.ts";

/**
 * These tests write into the real ~/.claude/projects root because containment
 * is resolved against the real homedir; each test namespaces itself under a
 * unique directory and removes it afterwards.
 */
const root = NodePath.join(NodeOS.homedir(), ".claude", "projects");

async function withScriptDir<A>(name: string, run: (dir: string) => Promise<A>): Promise<A> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(root, `wfq-${name}-`));
  try {
    return await run(dir);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

// flip swaps the channels: a success here means the call did NOT fail, which
// is itself the test failure, so the success type stays in the error slot.
const failureReason = <A>(
  effect: Effect.Effect<A, OrchestrationV2GetWorkflowScriptError>,
): Effect.Effect<OrchestrationV2GetWorkflowScriptError["reason"], A> =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));

describe("readWorkflowScript", () => {
  it.effect("reads a contained .js script", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        withScriptDir("ok", async (dir) => {
          const scriptPath = NodePath.join(dir, "script.js");
          await NodeFSP.writeFile(scriptPath, "export const meta = {}\n", "utf8");
          return Effect.runPromise(readWorkflowScript({ scriptPath }));
        }),
      );
      expect(result.contents).toContain("export const meta");
      expect(result.truncated).toBe(false);
    }),
  );

  it.effect("rejects a relative path without touching the filesystem", () =>
    Effect.gen(function* () {
      const reason = yield* failureReason(readWorkflowScript({ scriptPath: "relative/x.js" }));
      expect(reason).toBe("invalid-path");
    }),
  );

  it.effect("rejects a non-.js extension", () =>
    Effect.gen(function* () {
      const reason = yield* failureReason(
        readWorkflowScript({ scriptPath: NodePath.join(root, "notes.md") }),
      );
      expect(reason).toBe("invalid-path");
    }),
  );

  it.effect("rejects an absolute .js path outside the root", () =>
    Effect.gen(function* () {
      const outside = NodePath.join(NodeOS.tmpdir(), `wfq-outside-${process.pid}.js`);
      yield* Effect.promise(() => NodeFSP.writeFile(outside, "nope", "utf8"));
      const reason = yield* failureReason(readWorkflowScript({ scriptPath: outside }));
      yield* Effect.promise(() => NodeFSP.rm(outside, { force: true }));
      expect(reason).toBe("outside-root");
    }),
  );

  it.effect("rejects a symlinked leaf that escapes the root", () =>
    Effect.gen(function* () {
      // The case that motivates realpathing the FILE and not just its parent:
      // the link itself sits inside a contained directory.
      const reason = yield* Effect.promise(() =>
        withScriptDir("escape", async (dir) => {
          const target = NodePath.join(NodeOS.tmpdir(), `wfq-secret-${process.pid}.js`);
          await NodeFSP.writeFile(target, "secret", "utf8");
          const link = NodePath.join(dir, "innocent.js");
          await NodeFSP.symlink(target, link);
          const outcome = await Effect.runPromise(
            Effect.flip(readWorkflowScript({ scriptPath: link })),
          );
          await NodeFSP.rm(target, { force: true });
          return outcome.reason;
        }),
      );
      expect(reason).toBe("outside-root");
    }),
  );

  it.effect("rejects a directory that ends in .js", () =>
    Effect.gen(function* () {
      const reason = yield* Effect.promise(() =>
        withScriptDir("dir", async (dir) => {
          const fake = NodePath.join(dir, "bundle.js");
          await NodeFSP.mkdir(fake);
          const outcome = await Effect.runPromise(
            Effect.flip(readWorkflowScript({ scriptPath: fake })),
          );
          return outcome.reason;
        }),
      );
      expect(reason).toBe("not-regular-file");
    }),
  );

  it.effect("reports not-found for a missing script rather than a read failure", () =>
    Effect.gen(function* () {
      const reason = yield* failureReason(
        readWorkflowScript({ scriptPath: NodePath.join(root, "definitely-absent-script.js") }),
      );
      expect(reason).toBe("not-found");
    }),
  );

  it.effect("truncates an oversized script instead of failing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        withScriptDir("big", async (dir) => {
          const scriptPath = NodePath.join(dir, "big.js");
          await NodeFSP.writeFile(scriptPath, "x".repeat(300 * 1024), "utf8");
          return Effect.runPromise(readWorkflowScript({ scriptPath }));
        }),
      );
      expect(result.truncated).toBe(true);
      expect(result.contents.length).toBe(256 * 1024);
    }),
  );

  it.effect("returns the resolved realpath, not the requested hint", () =>
    Effect.gen(function* () {
      // A contained symlink is legitimate; the caller should learn what was
      // actually read so the UI does not display a misleading path.
      const result = yield* Effect.promise(() =>
        withScriptDir("resolve", async (dir) => {
          const real = NodePath.join(dir, "real.js");
          await NodeFSP.writeFile(real, "ok", "utf8");
          const link = NodePath.join(dir, "alias.js");
          await NodeFSP.symlink(real, link);
          return Effect.runPromise(readWorkflowScript({ scriptPath: link }));
        }),
      );
      expect(NodePath.basename(result.scriptPath)).toBe("real.js");
    }),
  );
});
