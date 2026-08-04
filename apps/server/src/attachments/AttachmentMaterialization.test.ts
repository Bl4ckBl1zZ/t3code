import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ChatAttachment, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as AttachmentMaterialization from "./AttachmentMaterialization.ts";
import { UPLOADS_GITIGNORE_RELATIVE_PATH } from "./uploadPaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(AttachmentMaterialization.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-attachment-materialization-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const THREAD_ID = "thread:project-abc:01J8Z9QK3M4N5P6R7S8T9V0W1X" as ThreadId;
const CLAUDE = "claude" as ProviderDriverKind;
const HERMES = "hermes" as ProviderDriverKind;

const PDF: ChatAttachment = {
  type: "pdf",
  id: "thread-abc-9f2c1a4b-1111-2222-3333-444455556666",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 5,
};

const IMAGE: ChatAttachment = {
  type: "image",
  id: "thread-abc-1d0e7f22-1111-2222-3333-444455556666",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 5,
};

const makeWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-uploads-test-" });
});

/** Puts an attachment's bytes into the blob store the service reads from. */
const seedBlob = Effect.fn("seedBlob")(function* (attachment: ChatAttachment, contents: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem
    .writeFileString(path.join(config.attachmentsDir, attachmentRelativePath(attachment)), contents)
    .pipe(Effect.orDie);
});

it.layer(TestLayer, { excludeTestServices: true })("AttachmentMaterialization", (it) => {
  describe("materialize", () => {
    it.effect("writes the blob into .t3code/uploads and announces the path", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeWorkspace;
        yield* seedBlob(PDF, "HELLO");

        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });

        expect(result.outcome).toBe("written");
        expect(result.materialized).toHaveLength(1);
        expect(result.inlineAttachments).toEqual([]);
        const entry = result.materialized[0];
        expect(entry?.status).toBe("written");
        expect(entry?.relativePath.startsWith(".t3code/uploads/")).toBe(true);
        expect(result.promptBlock).toContain(entry?.relativePath);

        const written = yield* fileSystem
          .readFileString(path.join(cwd, ...(entry?.relativePath.split("/") ?? [])))
          .pipe(Effect.orDie);
        expect(written).toBe("HELLO");
      }),
    );

    it.effect("creates a self-ignoring .gitignore before any blob exists", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeWorkspace;
        // No blob seeded: the write fails, but the ignore file must still exist.
        yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });

        const ignore = yield* fileSystem
          .readFileString(path.join(cwd, ...UPLOADS_GITIGNORE_RELATIVE_PATH.split("/")))
          .pipe(Effect.orDie);
        expect(ignore.split("\n")).toContain("*");
      }),
    );

    it.effect("leaves .t3code/vcs.json and the root .gitignore alone", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeWorkspace;
        yield* fileSystem.makeDirectory(path.join(cwd, ".t3code"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(cwd, ".t3code", "vcs.json"), '{"kind":"git"}');
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "node_modules\n");
        yield* seedBlob(PDF, "HELLO");

        yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });

        expect(
          yield* fileSystem
            .readFileString(path.join(cwd, ".t3code", "vcs.json"))
            .pipe(Effect.orDie),
        ).toBe('{"kind":"git"}');
        expect(
          yield* fileSystem.readFileString(path.join(cwd, ".gitignore")).pipe(Effect.orDie),
        ).toBe("node_modules\n");
        expect(yield* fileSystem.exists(path.join(cwd, ".t3code", ".gitignore"))).toBe(false);
      }),
    );

    it.effect("is idempotent across a resend: no second write", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeWorkspace;
        yield* seedBlob(PDF, "HELLO");

        const first = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });
        const absolute = path.join(cwd, ...(first.materialized[0]?.relativePath.split("/") ?? []));
        const beforeStat = yield* fileSystem.stat(absolute).pipe(Effect.orDie);

        const second = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });

        expect(second.materialized[0]?.status).toBe("already-present");
        expect(second.materialized[0]?.relativePath).toBe(first.materialized[0]?.relativePath);
        const afterStat = yield* fileSystem.stat(absolute).pipe(Effect.orDie);
        expect(afterStat.mtime).toEqual(beforeStat.mtime);
      }),
    );

    it.effect("skips silently when the thread has no workspace", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd: null,
          attachments: [PDF],
        });
        expect(result.outcome).toBe("skipped");
        expect(result.promptBlock).toBeNull();
        expect(result.inlineAttachments).toEqual([PDF]);
      }),
    );

    it.effect("falls back to inline for a missing blob without losing the others", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const cwd = yield* makeWorkspace;
        const orphan: ChatAttachment = {
          ...PDF,
          id: "thread-abc-deadbeef-1111-2222-3333-444455556666",
          name: "gone.pdf",
        };
        yield* seedBlob(PDF, "HELLO");

        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF, orphan],
        });

        expect(result.materialized).toHaveLength(1);
        expect(result.materialized[0]?.attachment.id).toBe(PDF.id);
        expect(result.inlineAttachments.map((a) => a.id)).toEqual([orphan.id]);
        expect(result.outcome).toBe("written");
      }),
    );

    it.effect("degrades without throwing when .t3code is a file", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeWorkspace;
        yield* fileSystem.writeFileString(path.join(cwd, ".t3code"), "not a directory");
        yield* seedBlob(PDF, "HELLO");

        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });

        expect(result.outcome).toBe("failed");
        expect(result.inlineAttachments).toEqual([PDF]);
      }),
    );

    it.effect("does not create a workspace root that does not exist", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeWorkspace;
        const missing = path.join(cwd, "not-there");
        yield* seedBlob(PDF, "HELLO");

        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd: missing,
          attachments: [PDF],
        });

        expect(result.outcome).toBe("failed");
        expect(yield* fileSystem.exists(missing)).toBe(false);
      }),
    );
  });

  describe("delivery policy", () => {
    it.effect("sends an image both to disk and inline", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const cwd = yield* makeWorkspace;
        yield* seedBlob(IMAGE, "PNG!!");

        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [IMAGE],
        });

        expect(result.materialized).toHaveLength(1);
        expect(result.inlineAttachments.map((a) => a.id)).toEqual([IMAGE.id]);
        expect(result.promptBlock).toContain("also attached to this message as an image");
      }),
    );

    it.effect("keeps a failed image inline exactly once", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const cwd = yield* makeWorkspace;
        // The blob store is shared across tests in this layer, so use an id no
        // other case seeds: this image has no bytes on disk and must degrade.
        const orphanImage: ChatAttachment = {
          ...IMAGE,
          id: "thread-abc-c0ffee11-1111-2222-3333-444455556666",
        };
        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [orphanImage],
        });

        expect(result.materialized).toEqual([]);
        expect(result.inlineAttachments.map((a) => a.id)).toEqual([orphanImage.id]);
      }),
    );

    it.effect("sends a non-image to disk only", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const cwd = yield* makeWorkspace;
        yield* seedBlob(PDF, "HELLO");

        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: CLAUDE,
          cwd,
          attachments: [PDF],
        });

        expect(result.inlineAttachments).toEqual([]);
        expect(result.promptBlock).not.toContain("also attached to this message");
      }),
    );

    it.effect("writes nothing to disk for a possibly-remote Hermes gateway", () =>
      Effect.gen(function* () {
        const service = yield* AttachmentMaterialization.AttachmentMaterialization;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeWorkspace;
        yield* seedBlob(PDF, "HELLO");

        const result = yield* service.materialize({
          threadId: THREAD_ID,
          driver: HERMES,
          cwd,
          attachments: [PDF, IMAGE],
        });

        expect(result.outcome).toBe("skipped");
        expect(result.materialized).toEqual([]);
        expect(result.inlineAttachments.map((a) => a.id)).toEqual([PDF.id, IMAGE.id]);
        expect(yield* fileSystem.exists(path.join(cwd, ".t3code"))).toBe(false);
      }),
    );
  });

  describe("resolveAttachmentDelivery", () => {
    it.effect("is the single place delivery is decided", () =>
      Effect.sync(() => {
        expect(AttachmentMaterialization.resolveAttachmentDelivery(CLAUDE, IMAGE)).toBe("both");
        expect(AttachmentMaterialization.resolveAttachmentDelivery(CLAUDE, PDF)).toBe("workspace");
        expect(AttachmentMaterialization.resolveAttachmentDelivery(HERMES, IMAGE)).toBe("inline");
        expect(AttachmentMaterialization.resolveAttachmentDelivery(HERMES, PDF)).toBe("inline");
      }),
    );
  });
});
