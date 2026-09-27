// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { MessageId, ThreadId, type UploadChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { persistChatAttachments } from "./ChatAttachmentPersistence.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-persist-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const textFile: UploadChatAttachment = {
  type: "file",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 1,
  dataUrl: "data:text/plain;base64,YQ==",
};

const attachmentFiles = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return NodeFS.existsSync(config.attachmentsDir) ? NodeFS.readdirSync(config.attachmentsDir) : [];
});

describe("persistChatAttachments", () => {
  it.effect("persists 100 attachments and rejects 101 before writing any", () =>
    Effect.gen(function* () {
      const rejected = yield* persistChatAttachments({
        threadId: ThreadId.make("thread-persist"),
        messageId: MessageId.make("message-rejected"),
        attachments: Array.from({ length: 101 }, () => textFile),
      }).pipe(Effect.flip);
      expect(rejected.message).toContain("up to 100");
      expect(yield* attachmentFiles).toEqual([]);

      const persisted = yield* persistChatAttachments({
        threadId: ThreadId.make("thread-persist"),
        messageId: MessageId.make("message-accepted"),
        attachments: Array.from({ length: 100 }, () => textFile),
      });
      expect(persisted).toHaveLength(100);
      expect(yield* attachmentFiles).toHaveLength(100);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects images over the 80 MiB total before writing any", () =>
    Effect.gen(function* () {
      const image: UploadChatAttachment = {
        type: "image",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
        dataUrl: "data:image/png;base64,YQ==",
      };
      const error = yield* persistChatAttachments({
        threadId: ThreadId.make("thread-persist-budget"),
        messageId: MessageId.make("message-budget"),
        attachments: [...Array.from({ length: 8 }, () => image), { ...image, sizeBytes: 1 }],
      }).pipe(Effect.flip);
      expect(error.message).toContain("80 MiB");
      expect(yield* attachmentFiles).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});
