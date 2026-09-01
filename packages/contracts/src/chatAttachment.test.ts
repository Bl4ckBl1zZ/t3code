import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
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
