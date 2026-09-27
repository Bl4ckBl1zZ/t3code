import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "./chatAttachment.ts";

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});

it("tolerates attachment types from newer builds", () => {
  const decoded = Schema.decodeUnknownSync(ChatAttachment)({
    type: "audio",
    id: "att-audio",
    name: "note.m4a",
    mimeType: "audio/mp4",
    sizeBytes: 4_096,
  });

  assert.strictEqual(decoded.type, "audio");
});

it("rejects malformed known attachment types instead of tolerating them", () => {
  // An oversized file must fail its own branch rather than sliding into the
  // catch-all with its size constraint unchecked.
  assert.throws(() =>
    Schema.decodeUnknownSync(ChatAttachment)({
      type: "file",
      id: "att-file",
      name: "archive.zip",
      mimeType: "application/zip",
      sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(ChatAttachment)({
      type: "image",
      id: "att-image",
      name: "diagram.svg",
      mimeType: "text/plain",
      sizeBytes: 3,
    }),
  );
});

it("accepts 50 MB uploaded file references while keeping the 10 MB image cap", () => {
  for (const [type, mimeType] of [
    ["file", "application/zip"],
    ["pdf", "application/pdf"],
    ["video", "video/mp4"],
  ]) {
    assert.strictEqual(
      Schema.decodeUnknownSync(ChatAttachment)({
        type,
        mimeType,
        id: "pending-file",
        name: "document",
        sizeBytes: 50 * 1024 * 1024,
      }).sizeBytes,
      50 * 1024 * 1024,
    );
  }
  assert.throws(() =>
    Schema.decodeUnknownSync(ChatAttachment)({
      type: "image",
      mimeType: "image/png",
      id: "pending-image",
      name: "photo.png",
      sizeBytes: 11 * 1024 * 1024,
    }),
  );
});

it("getProviderAttachmentLimitError caps the count and the image total, not file bytes", () => {
  const image = { type: "image", mimeType: "image/png", sizeBytes: 10 * 1024 * 1024 } as const;
  const pdf = { type: "pdf", mimeType: "application/pdf", sizeBytes: 50 * 1024 * 1024 } as const;
  const file = { type: "file", mimeType: "text/plain", sizeBytes: 1 } as const;

  assert.strictEqual(
    getProviderAttachmentLimitError(Array.from({ length: 100 }, () => file)),
    undefined,
  );
  assert.include(
    getProviderAttachmentLimitError(Array.from({ length: 101 }, () => file)),
    "up to 100 files",
  );
  assert.strictEqual(
    getProviderAttachmentLimitError([...Array.from({ length: 8 }, () => image), pdf, pdf]),
    undefined,
  );
  assert.include(
    getProviderAttachmentLimitError([
      ...Array.from({ length: 8 }, () => image),
      { ...image, sizeBytes: 1 },
    ]),
    "80 MiB",
  );
});
