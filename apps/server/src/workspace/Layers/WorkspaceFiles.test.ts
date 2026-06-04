// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFiles } from "../Services/WorkspaceFiles.ts";
import { WorkspaceTree } from "../Services/WorkspaceTree.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFilesLive } from "./WorkspaceFiles.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";
import { WorkspaceTreeLive } from "./WorkspaceTree.ts";

const VcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer));
const WorkspaceEntriesLayer = WorkspaceEntriesLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistryLayer),
);
const WorkspaceFilesLayer = WorkspaceFilesLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLayer),
);
const WorkspaceTreeLayer = WorkspaceTreeLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistryLayer),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(WorkspaceEntriesLayer),
  Layer.provideMerge(WorkspaceFilesLayer),
  Layer.provideMerge(WorkspaceTreeLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(VcsDriverRegistryLayer),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-file-manager-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeWorkspaceFileManagerTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-file-manager-",
  });
});

const writeTextFile = Effect.fn("writeWorkspaceManagerTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

it.layer(TestLayer)("Workspace file manager services", (it) => {
  describe("WorkspaceTree.listDirectory", () => {
    it.effect("lists one directory with sorted metadata and default filters", () =>
      Effect.gen(function* () {
        const tree = yield* WorkspaceTree;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");
        yield* writeTextFile(cwd, "README.md", "# Project\n");
        yield* writeTextFile(cwd, ".env", "SECRET=1\n");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js", "");

        const result = yield* tree.listDirectory({ cwd, limit: 100 });
        const names = result.entries.map((entry) => entry.name);

        expect(names).toEqual(["src", "README.md"]);
        expect(result.entries[0]).toMatchObject({
          relativePath: "src",
          kind: "directory",
          hidden: false,
          ignored: false,
        });
        expect(result.entries[1]).toMatchObject({
          relativePath: "README.md",
          kind: "file",
          hidden: false,
          ignored: false,
        });
      }),
    );

    it.effect("supports hidden and ignored toggles plus truncation", () =>
      Effect.gen(function* () {
        const tree = yield* WorkspaceTree;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, ".env", "SECRET=1\n");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js", "");
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");

        const visible = yield* tree.listDirectory({ cwd, limit: 100 });
        expect(visible.entries.map((entry) => entry.relativePath)).toEqual(["src"]);

        const withHidden = yield* tree.listDirectory({ cwd, includeHidden: true, limit: 100 });
        expect(withHidden.entries.map((entry) => entry.relativePath)).toEqual(["src", ".env"]);

        const withIgnored = yield* tree.listDirectory({ cwd, includeIgnored: true, limit: 100 });
        expect(withIgnored.entries.map((entry) => entry.relativePath)).toEqual([
          "node_modules",
          "src",
        ]);

        const truncated = yield* tree.listDirectory({
          cwd,
          includeHidden: true,
          includeIgnored: true,
          limit: 1,
        });
        expect(truncated.truncated).toBe(true);
        expect(truncated.entries).toHaveLength(1);
      }),
    );
  });

  describe("WorkspaceFiles.readFile", () => {
    it.effect("returns text contents, EOL metadata, and a version", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFiles;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/index.ts", "line 1\r\nline 2\r\n");

        const result = yield* files.readFile({ cwd, relativePath: "src/index.ts" });

        expect(result.exists).toBe(true);
        expect(result.contents).toBe("line 1\r\nline 2\r\n");
        expect(result.eol).toBe("crlf");
        expect(result.version?.fingerprint).toContain(":");
      }),
    );

    it.effect("distinguishes missing, binary, and too-large files", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFiles;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        yield* fileSystem.writeFile(path.join(cwd, "asset.bin"), new Uint8Array([0, 1, 2]));
        yield* writeTextFile(cwd, "large.txt", "abcdef");

        const missing = yield* files.readFile({ cwd, relativePath: "missing.txt" });
        const binary = yield* files.readFile({ cwd, relativePath: "asset.bin" });
        const tooLarge = yield* files.readFile({
          cwd,
          relativePath: "large.txt",
          maxBytes: 2,
        });

        expect(missing).toMatchObject({ exists: false, contents: null });
        expect(binary).toMatchObject({ exists: true, contents: null, binary: true });
        expect(tooLarge).toMatchObject({ exists: true, contents: null, tooLarge: true });
      }),
    );
  });

  describe("WorkspaceFiles.writeFile", () => {
    it.effect("writes with optimistic concurrency and rejects stale saves", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFiles;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/index.ts", "a\n");

        const opened = yield* files.readFile({ cwd, relativePath: "src/index.ts" });
        const saved = yield* files.writeFile({
          cwd,
          relativePath: "src/index.ts",
          contents: "b\n",
          expectedVersion: opened.version,
        });
        expect(saved.version.fingerprint).not.toBe(opened.version?.fingerprint);

        const staleVersion = saved.version;
        yield* writeTextFile(cwd, "src/index.ts", "external\n");
        const conflict = yield* files
          .writeFile({
            cwd,
            relativePath: "src/index.ts",
            contents: "local\n",
            expectedVersion: staleVersion,
          })
          .pipe(Effect.flip);

        expect(conflict.code).toBe("conflict");
        const contents = yield* fileSystem.readFileString(path.join(cwd, "src/index.ts"));
        expect(contents).toBe("external\n");
      }),
    );

    it.effect("rejects create-if-missing writes when the file exists", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFiles;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "README.md", "# Project\n");

        const error = yield* files
          .writeFile({
            cwd,
            relativePath: "README.md",
            contents: "# Replacement\n",
            expectedVersion: null,
            create: true,
          })
          .pipe(Effect.flip);

        expect(error.code).toBe("conflict");
      }),
    );

    it.effect("rejects path traversal and outside-root symlinks", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFiles;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        const outside = yield* makeTempDir();
        yield* fileSystem.writeFileString(path.join(outside, "secret.txt"), "secret\n");
        yield* fileSystem.symlink(path.join(outside, "secret.txt"), path.join(cwd, "link.txt"));

        const traversal = yield* files
          .writeFile({
            cwd,
            relativePath: "../escape.txt",
            contents: "nope\n",
            expectedVersion: null,
            create: true,
          })
          .pipe(Effect.flip);
        const symlink = yield* files
          .readFile({
            cwd,
            relativePath: "link.txt",
          })
          .pipe(Effect.flip);

        expect(traversal.code).toBe("outside_root");
        expect(symlink.code).toBe("unsafe_symlink");
      }),
    );
  });

  describe("WorkspaceFiles mutations", () => {
    it.effect("renames and deletes while invalidating workspace entry search", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFiles;
        const entries = yield* WorkspaceEntries;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "docs/old-name.md", "# Old\n");

        expect((yield* entries.search({ cwd, query: "old-name", limit: 10 })).entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "docs/old-name.md" })]),
        );

        const renamed = yield* files.rename({
          cwd,
          fromRelativePath: "docs/old-name.md",
          toRelativePath: "docs/new-name.md",
        });

        expect(renamed.entry).toMatchObject({ relativePath: "docs/new-name.md" });
        expect((yield* entries.search({ cwd, query: "old-name", limit: 10 })).entries).toEqual([]);
        expect((yield* entries.search({ cwd, query: "new-name", limit: 10 })).entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "docs/new-name.md" })]),
        );

        yield* files.delete({ cwd, relativePath: "docs/new-name.md" });
        expect((yield* entries.search({ cwd, query: "new-name", limit: 10 })).entries).toEqual([]);
      }),
    );
  });
});
