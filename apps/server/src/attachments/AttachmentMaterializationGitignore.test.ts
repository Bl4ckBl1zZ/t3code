/**
 * The uploads directory has to be invisible to git, and not merely tidy.
 *
 * `GitVcsDriver.captureCheckpoint` builds its tree with `git add -A -- .`, which
 * honors gitignore. If the ignore file were missing (or written after the first
 * blob) every checkpoint would carry the user's uploads. Restore runs
 * `git clean -fd` without `-x`, so ignored files survive a rollback and the
 * paths named in older turns stay valid.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ChatAttachment, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { attachmentRelativePath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as AttachmentMaterialization from "./AttachmentMaterialization.ts";
import { UPLOADS_GITIGNORE_RELATIVE_PATH } from "./uploadPaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(AttachmentMaterialization.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-uploads-gitignore-test-" }),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const THREAD_ID = "thread:project-abc:01J8Z9QK3M4N5P6R7S8T9V0W1X" as ThreadId;
const CLAUDE = "claudeAgent" as ProviderDriverKind;

const PDF: ChatAttachment = {
  type: "pdf",
  id: "thread-abc-9f2c1a4b-1111-2222-3333-444455556666",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 5,
};

const git = Effect.fn("git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  return yield* driver.execute({
    operation: "AttachmentMaterializationGitignore.test",
    cwd,
    args,
    timeoutMs: 10_000,
  });
});

const makeRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-uploads-git-" });
  yield* git(cwd, ["init"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello\n");
  yield* git(cwd, ["add", "README.md"]);
  yield* git(cwd, ["commit", "-m", "initial"]);
  return cwd;
});

const seedBlob = Effect.fn("seedBlob")(function* (attachment: ChatAttachment, contents: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem
    .writeFileString(path.join(config.attachmentsDir, attachmentRelativePath(attachment)), contents)
    .pipe(Effect.orDie);
});

it.layer(TestLayer, { excludeTestServices: true })("uploads are invisible to git", (it) => {
  describe("materialize", () => {
    it.effect("leaves the working tree clean", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const cwd = yield* makeRepo;
        yield* seedBlob(PDF, "HELLO");

        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });
        expect(result.outcome).toBe("written");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        expect(status.stdout.trim()).toBe("");
      }),
    );

    it.effect("keeps uploads out of a checkpoint tree", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const cwd = yield* makeRepo;
        yield* seedBlob(PDF, "HELLO");
        yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });

        // Mirrors how GitVcsDriver.captureCheckpoint builds its tree.
        yield* git(cwd, ["add", "-A", "--", "."]);
        const tree = yield* git(cwd, ["ls-files", "--cached"]);
        expect(tree.stdout).not.toContain(".t3code/uploads");
      }),
    );

    it.effect("survives a checkpoint restore's git clean", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeRepo;
        yield* seedBlob(PDF, "HELLO");
        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });
        const uploaded = path.join(cwd, ...(result.materialized[0]?.relativePath.split("/") ?? []));

        // `git clean -fd` without `-x` is what restoreCheckpoint runs.
        yield* git(cwd, ["clean", "-fd", "--", "."]);

        expect(yield* fileSystem.exists(uploaded)).toBe(true);
      }),
    );

    it.effect("appends to a pre-existing ignore file exactly once", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeRepo;
        const ignorePath = path.join(cwd, ...UPLOADS_GITIGNORE_RELATIVE_PATH.split("/"));
        yield* fileSystem.makeDirectory(path.dirname(ignorePath), { recursive: true });
        yield* fileSystem.writeFileString(ignorePath, "# repo owned\n!keep-me\n");
        yield* seedBlob(PDF, "HELLO");

        yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });
        yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });

        const contents = yield* fileSystem.readFileString(ignorePath).pipe(Effect.orDie);
        expect(contents.startsWith("# repo owned\n!keep-me\n")).toBe(true);
        expect(contents.split("\n").filter((line) => line.trim() === "*")).toHaveLength(1);
      }),
    );
  });
});
