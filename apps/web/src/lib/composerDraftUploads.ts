import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";

import {
  type ComposerAttachment,
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { releaseAttachmentUploads } from "./attachmentUploadQueue";

// Only images have an upload URL to release: the signed-upload contract accepts
// image mime types alone, so the composer's other attachment kinds never enter
// the queue.
const uploadableImages = (
  attachments: ReadonlyArray<ComposerAttachment>,
): ComposerImageAttachment[] =>
  attachments.filter(
    (attachment): attachment is ComposerImageAttachment => attachment.type === "image",
  );

/** Releases the uploads a draft's attachments hold, such as one discarded for good. */
export function releaseDraftAttachmentUploads(
  attachments: ReadonlyArray<ComposerAttachment>,
): void {
  releaseAttachmentUploads(uploadableImages(attachments));
}

export function releaseComposerDraftUploads(target: ScopedThreadRef | DraftId): void {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  if (draft) {
    releaseDraftAttachmentUploads(draft.images);
  }
}

export function releaseProjectDraftUploads(projectRef: ScopedProjectRef): void {
  const store = useComposerDraftStore.getState();
  for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
    if (
      session.environmentId === projectRef.environmentId &&
      session.projectId === projectRef.projectId
    ) {
      releaseAttachmentUploads(uploadableImages(store.draftsByThreadKey[draftKey]?.images ?? []));
    }
  }
}
