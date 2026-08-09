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

// acquireUseRelease keeps the cleanup guarantee of the old try/finally without
// a nested runtime: the body stays an Effect the test can yield directly.
const withScriptDir = <A, E, R>(
  name: string,
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(root, `wfq-${name}-`))),
    use,
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );

// flip swaps the channels: a success here means the call did NOT fail, which
// is itself the test failure, so the success type stays in the error slot.
const failureReason = <A>(
  effect: Effect.Effect<A, OrchestrationV2GetWorkflowScriptError>,
): Effect.Effect<OrchestrationV2GetWorkflowScriptError["reason"], A> =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));

describe("readWorkflowScript", () => {
  it.effect("reads a contained .js script", () =>
    withScriptDir("ok", (dir) =>
      Effect.gen(function* () {
        const scriptPath = NodePath.join(dir, "script.js");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(scriptPath, "export const meta = {}\n", "utf8"),
        );
        const result = yield* readWorkflowScript({ scriptPath });
        expect(result.contents).toContain("export const meta");
        expect(result.truncated).toBe(false);
      }),
    ),
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
      const reason = yield* withScriptDir("escape", (dir) =>
        Effect.gen(function* () {
          const target = NodePath.join(NodeOS.tmpdir(), `wfq-secret-${process.pid}.js`);
          yield* Effect.promise(() => NodeFSP.writeFile(target, "secret", "utf8"));
          const link = NodePath.join(dir, "innocent.js");
          yield* Effect.promise(() => NodeFSP.symlink(target, link));
          return yield* failureReason(readWorkflowScript({ scriptPath: link })).pipe(
            Effect.ensuring(Effect.promise(() => NodeFSP.rm(target, { force: true }))),
          );
        }),
      );
      expect(reason).toBe("outside-root");
    }),
  );

  it.effect("rejects a directory that ends in .js", () =>
    Effect.gen(function* () {
      const reason = yield* withScriptDir("dir", (dir) =>
        Effect.gen(function* () {
          const fake = NodePath.join(dir, "bundle.js");
          yield* Effect.promise(() => NodeFSP.mkdir(fake));
          return yield* failureReason(readWorkflowScript({ scriptPath: fake }));
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
    withScriptDir("big", (dir) =>
      Effect.gen(function* () {
        const scriptPath = NodePath.join(dir, "big.js");
        yield* Effect.promise(() => NodeFSP.writeFile(scriptPath, "x".repeat(300 * 1024), "utf8"));
        const result = yield* readWorkflowScript({ scriptPath });
        expect(result.truncated).toBe(true);
        expect(result.contents.length).toBe(256 * 1024);
      }),
    ),
  );

  it.effect("returns the resolved realpath, not the requested hint", () =>
    Effect.gen(function* () {
      // A contained symlink is legitimate; the caller should learn what was
      // actually read so the UI does not display a misleading path.
      const result = yield* withScriptDir("resolve", (dir) =>
        Effect.gen(function* () {
          const real = NodePath.join(dir, "real.js");
          yield* Effect.promise(() => NodeFSP.writeFile(real, "ok", "utf8"));
          const link = NodePath.join(dir, "alias.js");
          yield* Effect.promise(() => NodeFSP.symlink(real, link));
          return yield* readWorkflowScript({ scriptPath: link });
        }),
      );
      expect(NodePath.basename(result.scriptPath)).toBe("real.js");
    }),
  );
});
