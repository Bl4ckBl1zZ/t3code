import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  PersistChatAttachmentsError,
  type PersistChatAttachmentsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";

/**
 * Persists inline (data URL) composer uploads for one message into the thread's
 * attachment store. A batch over the per-message attachment limits is rejected
 * before any file is written; declared sizes must match the decoded payloads,
 * so the image budget is checked against real bytes.
 */
export const persistChatAttachments = Effect.fn("ws.assets.persistChatAttachments")(function* (
  input: PersistChatAttachmentsInput,
) {
  const limitError = getProviderAttachmentLimitError(input.attachments);
  if (limitError !== undefined) {
    return yield* new PersistChatAttachmentsError({ message: limitError });
  }
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    input.attachments.map((attachment, index) => ({ attachment, index })),
    Effect.fn("ws.assets.persistChatAttachment")(function* ({ attachment, index }) {
      const parsed = parseBase64DataUrl(attachment.dataUrl);
      if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} has an invalid payload.`,
        });
      }
      const bytes = yield* Effect.fromResult(Encoding.decodeBase64(parsed.base64)).pipe(
        Effect.mapError(
          (cause) =>
            new PersistChatAttachmentsError({
              message: `Attachment ${attachment.name} is not valid base64.`,
              cause,
            }),
        ),
      );
      if (bytes.byteLength !== attachment.sizeBytes) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} size does not match its payload.`,
        });
      }
      const rawId = createDeterministicAttachmentId(input.threadId, `${input.messageId}:${index}`);
      if (rawId === null) {
        return yield* new PersistChatAttachmentsError({
          message: "Could not allocate an attachment identifier.",
        });
      }
      const persisted = {
        type: attachment.type,
        id: ChatAttachmentId.make(rawId),
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        ...(attachment.role === undefined ? {} : { role: attachment.role }),
        ...(attachment.type === "image" && attachment.source ? { source: attachment.source } : {}),
      };
      const relativePath = attachmentRelativePath(persisted);
      if (relativePath === null) {
        return yield* new PersistChatAttachmentsError({
          message: `Unsupported attachment type for ${attachment.name}.`,
        });
      }
      yield* fileSystem.writeFile(path.join(config.attachmentsDir, relativePath), bytes).pipe(
        Effect.mapError(
          (cause) =>
            new PersistChatAttachmentsError({
              message: `Could not persist attachment ${attachment.name}.`,
              cause,
            }),
        ),
      );
      return persisted;
    }),
    { concurrency: 2 },
  );
});
