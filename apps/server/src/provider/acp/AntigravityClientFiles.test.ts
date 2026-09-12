import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import {
  readAntigravityClientTextFile,
  writeAntigravityClientTextFile,
} from "./AntigravityClientFiles.ts";

it.layer(NodeServices.layer)("Antigravity client files", (it) => {
  it.effect("reads native one-based line ranges and writes nested workspace files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const target = path.join(root, "nested", "file.txt");
      const input = { fileSystem, path, allowedRoots: [root] };
      yield* writeAntigravityClientTextFile({
        ...input,
        request: { sessionId: "test", path: target, content: "one\ntwo\nthree\n" },
      });
      const result = yield* readAntigravityClientTextFile({
        ...input,
        request: { sessionId: "test", path: target, line: 2, limit: 1 },
      });
      assert.deepEqual(result, { content: "two" });
    }),
  );
  it.effect.skipIf(!symlinksSupported)(
    "rejects leaf and ancestor symlinks outside the workspace",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped();
        const root = path.join(temp, "workspace");
        const outside = path.join(temp, "outside");
        yield* fileSystem.makeDirectory(root);
        yield* fileSystem.makeDirectory(outside);
        yield* fileSystem.writeFileString(path.join(outside, "file.txt"), "outside");
        yield* fileSystem.symlink(path.join(outside, "file.txt"), path.join(root, "leaf"));
        yield* fileSystem.symlink(outside, path.join(root, "parent"));
        const input = { fileSystem, path, allowedRoots: [root] };
        const read = yield* readAntigravityClientTextFile({
          ...input,
          request: { sessionId: "test", path: path.join(root, "leaf") },
        }).pipe(Effect.exit);
        const write = yield* writeAntigravityClientTextFile({
          ...input,
          request: {
            sessionId: "test",
            path: path.join(root, "parent", "new", "file.txt"),
            content: "changed",
          },
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(read));
        assert.isTrue(Exit.isFailure(write));
        assert.equal(yield* fileSystem.readFileString(path.join(outside, "file.txt")), "outside");
        assert.isFalse(yield* fileSystem.exists(path.join(outside, "new")));
      }),
  );
});
