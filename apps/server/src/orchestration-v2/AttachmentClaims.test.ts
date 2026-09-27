// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ChatAttachmentId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { attachmentIsPendingUpload, claimPendingAttachments } from "./AttachmentClaims.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-claims-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const stagePendingUpload = Effect.fn("test.stagePendingUpload")(function* (input: {
  readonly name: string;
  readonly bytes: Uint8Array;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const pendingId = createPendingAttachmentId();
  const attachment: ChatAttachment = {
    type: "image",
    id: ChatAttachmentId.make(pendingId),
    name: input.name,
    mimeType: "image/png",
    sizeBytes: input.bytes.byteLength,
  };
  yield* Effect.sync(() => {
    NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`), input.bytes);
  });
  return attachment;
});

const existingFiles = (count: number): ChatAttachment[] =>
  Array.from({ length: count }, (_, index) => ({
    type: "file",
    id: ChatAttachmentId.make(`existing-file-${index}`),
    name: `${index}.txt`,
    mimeType: "text/plain",
    sizeBytes: 1,
  }));

describe("AttachmentClaims", () => {
  it.effect("accepts 100 attachments and rejects 101", () =>
    Effect.gen(function* () {
      const attachments = existingFiles(100);
      const claimed = yield* claimPendingAttachments({
        threadId: ThreadId.make("thread-many"),
        attachments,
      });
      expect(claimed.attachments).toEqual(attachments);
      expect(claimed.claimedPaths).toEqual([]);

      const error = yield* claimPendingAttachments({
        threadId: ThreadId.make("thread-many"),
        attachments: existingFiles(101),
      }).pipe(Effect.flip);
      expect(error.message).toContain("up to 100");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects oversized image batches before copying a pending upload", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "pending.png",
        bytes: new Uint8Array([1]),
      });
      const images: ChatAttachment[] = Array.from({ length: 8 }, (_, index) => ({
        type: "image",
        id: ChatAttachmentId.make(`existing-image-${index}`),
        name: `${index}.png`,
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
      }));
      const error = yield* claimPendingAttachments({
        threadId: ThreadId.make("thread-image-budget"),
        attachments: [pending, ...images],
      }).pipe(Effect.flip);
      expect(error.message).toContain("80 MiB");
      const config = yield* ServerConfig.ServerConfig;
      expect(NodeFS.readdirSync(config.attachmentsDir)).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not charge non-image files against the image budget", () =>
    Effect.gen(function* () {
      const attachments: ChatAttachment[] = [
        ...Array.from({ length: 8 }, (_, index) => ({
          type: "image" as const,
          id: ChatAttachmentId.make(`budget-image-${index}`),
          name: `${index}.png`,
          mimeType: "image/png",
          sizeBytes: 10 * 1024 * 1024,
        })),
        {
          type: "video",
          id: ChatAttachmentId.make("budget-video"),
          name: "clip.mp4",
          mimeType: "video/mp4",
          sizeBytes: 50 * 1024 * 1024,
        },
      ];
      const claimed = yield* claimPendingAttachments({
        threadId: ThreadId.make("thread-video"),
        attachments,
      });
      expect(claimed.attachments).toHaveLength(9);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("claims a pending upload into the thread store and rewrites the id", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "screenshot.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      const config = yield* ServerConfig.ServerConfig;

      const claimed = yield* claimPendingAttachments({
        threadId: ThreadId.make("thread-claims-1"),
        attachments: [pending],
      });

      const attachment = claimed.attachments[0]!;
      expect(attachmentIsPendingUpload(attachment)).toBe(false);
      expect(parseThreadSegmentFromAttachmentId(attachment.id)).toBe("thread-claims-1");
      expect(claimed.claimedPaths).toHaveLength(1);
      expect(NodeFS.existsSync(claimed.claimedPaths[0]!)).toBe(true);
      // The pending copy stays behind as the retry source.
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.startsWith("pending-")),
      ).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );
});
