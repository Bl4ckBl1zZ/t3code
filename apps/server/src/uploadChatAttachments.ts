import {
  type ChatAttachment,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { createAttachmentId, resolveAttachmentPath } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";

export function persistUploadChatAttachments<E>(input: {
  readonly attachments: readonly UploadChatAttachment[];
  readonly attachmentsDir: string;
  readonly attachmentScopeId: string;
  readonly toError: (message: string) => E;
}): Effect.Effect<readonly ChatAttachment[], E, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* Effect.fail(
              input.toError(`Invalid image attachment payload for '${attachment.name}'.`),
            );
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* Effect.fail(
              input.toError(`Image attachment '${attachment.name}' is empty or too large.`),
            );
          }

          const attachmentId = createAttachmentId(input.attachmentScopeId);
          if (!attachmentId) {
            return yield* Effect.fail(input.toError("Failed to create a safe attachment id."));
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: input.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* Effect.fail(
              input.toError(`Failed to resolve persisted path for '${attachment.name}'.`),
            );
          }

          yield* fileSystem
            .makeDirectory(path.dirname(attachmentPath), { recursive: true })
            .pipe(
              Effect.mapError(() =>
                input.toError(`Failed to create attachment directory for '${attachment.name}'.`),
              ),
            );
          yield* fileSystem
            .writeFile(attachmentPath, bytes)
            .pipe(
              Effect.mapError(() =>
                input.toError(`Failed to persist attachment '${attachment.name}'.`),
              ),
            );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );
  });
}
