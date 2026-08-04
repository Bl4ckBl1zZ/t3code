import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readBackgroundOutputTail } from "./backgroundTail.ts";

const withTempFile = <A, E>(
  contents: string,
  use: (path: string, fileSystem: FileSystem.FileSystem) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = path.join(directory, "task.output");
    yield* fileSystem.writeFileString(file, contents);
    return yield* use(file, fileSystem);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("reads a whole small output file", () =>
  withTempFile("step 1\nstep 2\n", (path, fileSystem) =>
    Effect.gen(function* () {
      const snapshot = yield* readBackgroundOutputTail({ fileSystem, path, maxBytes: 1_024 });
      assert.deepStrictEqual(snapshot, {
        output: "step 1\nstep 2\n",
        truncated: false,
        size: 14,
      });
    }),
  ),
);

it.effect("reads only the tail of a large file and says it is truncated", () =>
  withTempFile(
    Array.from({ length: 500 }, (_unused, index) => `line ${index}`).join("\n"),
    (path, fileSystem) =>
      Effect.gen(function* () {
        const snapshot = yield* readBackgroundOutputTail({ fileSystem, path, maxBytes: 64 });
        assert.isNotNull(snapshot);
        assert.isTrue(snapshot?.truncated);
        // Snapped to a line boundary rather than opening mid-line.
        assert.isTrue(snapshot?.output.startsWith("line "));
        assert.isTrue((snapshot?.output.length ?? 0) <= 64);
        assert.isTrue(snapshot?.output.endsWith("line 499"));
      }),
  ),
);

it.effect("reports nothing for a file the command has not created yet", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const snapshot = yield* readBackgroundOutputTail({
      fileSystem,
      path: "/definitely/not/a/real/task.output",
      maxBytes: 1_024,
    });
    // Normal in the first moments after launch, and not an error worth raising.
    assert.isNull(snapshot);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("treats an empty file as no output rather than as missing", () =>
  withTempFile("", (path, fileSystem) =>
    Effect.gen(function* () {
      const snapshot = yield* readBackgroundOutputTail({ fileSystem, path, maxBytes: 1_024 });
      assert.deepStrictEqual(snapshot, { output: "", truncated: false, size: 0 });
    }),
  ),
);
