import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  type ChatAttachment,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

export class AttachmentClaimError extends Schema.TaggedErrorClass<AttachmentClaimError>()(
  "AttachmentClaimError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Enforces the shared per-message attachment rule (count and image total)
 * before anything is copied or dispatched.
 */
export const validateAttachmentLimits = Effect.fn("AttachmentClaims.validateAttachmentLimits")(
  function* (attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "mimeType" | "sizeBytes">>) {
    const error = getProviderAttachmentLimitError(attachments);
    if (error !== undefined) return yield* new AttachmentClaimError({ message: error });
  },
);

export const attachmentIsPendingUpload = (attachment: ChatAttachment) =>
  parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;

/**
 * Move attachments the client uploaded ahead of the turn out of the shared
 * pending area and into the thread that is about to reference them, rewriting
 * each id to its claimed one. Rejects batches over the attachment limits
 * before copying anything.
 *
 * The pending copy is left in place: a dispatch that fails after this point
 * calls `releaseClaimedAttachments`, and the client can retry the same upload
 * against a different thread.
 */
export const claimPendingAttachments = Effect.fn("AttachmentClaims.claimPendingAttachments")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    yield* validateAttachmentLimits(input.attachments);
    if (!input.attachments.some(attachmentIsPendingUpload)) {
      return { attachments: input.attachments, claimedPaths: [] as ReadonlyArray<string> };
    }

    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claimedPaths: Array<string> = [];

    const attachments = yield* Effect.forEach(
      input.attachments,
      Effect.fn("AttachmentClaims.claimPendingAttachment")(function* (attachment) {
        if (!attachmentIsPendingUpload(attachment)) return attachment;

        const claim = planAttachmentClaim({
          attachmentsDir: config.attachmentsDir,
          threadId: input.threadId,
          attachmentId: attachment.id,
        });
        if (!claim.ok) {
          return yield* new AttachmentClaimError({
            message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
          });
        }

        const info = yield* fileSystem.stat(claim.currentPath).pipe(
          Effect.mapError(
            (cause) =>
              new AttachmentClaimError({
                message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                cause,
              }),
          ),
        );
        if (Number(info.size) !== attachment.sizeBytes) {
          return yield* new AttachmentClaimError({
            message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
          });
        }

        const claimed = {
          ...attachment,
          id: ChatAttachmentId.make(claim.finalId),
          mimeType: attachment.mimeType.toLowerCase(),
        };
        // The claimed path is derived from the id alone; the type/mime decide the
        // extension, so a mismatch here means the declared type does not describe
        // what was uploaded.
        if (
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: claimed }) !==
          claim.finalPath
        ) {
          return yield* new AttachmentClaimError({
            message: `Attachment '${attachment.name}' cannot be sent: file type does not match the upload.`,
          });
        }

        yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
          Effect.mapError(
            (cause) =>
              new AttachmentClaimError({
                message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                cause,
              }),
          ),
        );
        claimedPaths.push(claim.finalPath);
        return claimed;
      }),
      { concurrency: 1 },
    ).pipe(Effect.tapError(() => releaseClaimedAttachments(claimedPaths)));

    return { attachments, claimedPaths: claimedPaths as ReadonlyArray<string> };
  },
);

export const releaseClaimedAttachments = Effect.fn("AttachmentClaims.releaseClaimedAttachments")(
  function* (claimedPaths: ReadonlyArray<string>) {
    if (claimedPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      claimedPaths,
      (claimedPath) =>
        fileSystem.remove(claimedPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              claimedPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);
