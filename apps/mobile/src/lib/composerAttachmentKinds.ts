import type { UploadChatAttachment, UploadChatImageAttachment } from "@t3tools/contracts";

/**
 * Pure attachment-kind helpers, kept free of native imports so they stay
 * testable — the picker module itself reaches for expo-crypto and
 * expo-file-system, which the test runner cannot parse.
 */

/** Images carry a preview URI so the composer can show a thumbnail. */
export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

export interface DraftComposerDocumentAttachment {
  readonly id: string;
  readonly type: "file" | "pdf" | "video";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}

/** Anything the composer can hold as a pending attachment. */
export type DraftComposerAttachment = DraftComposerImageAttachment | DraftComposerDocumentAttachment;

export function isDraftComposerImageAttachment(
  attachment: DraftComposerAttachment,
): attachment is DraftComposerImageAttachment {
  return attachment.type === "image";
}

const VIDEO_MIME_PATTERN = /^video\//i;

/** The contract splits these three by MIME, so the picker must agree. */
export function documentAttachmentKind(mimeType: string): "file" | "pdf" | "video" {
  const normalized = mimeType.toLowerCase();
  if (normalized === "application/pdf") return "pdf";
  if (VIDEO_MIME_PATTERN.test(normalized)) return "video";
  return "file";
}

export function formatAttachmentSizeLimitError(name: string): string {
  return `'${name}' exceeds the 20 MB attachment limit.`;
}

/**
 * Wire shape for startTurn: drop client-only fields (draft id, preview URI)
 * from every attachment kind.
 */
export function toUploadChatAttachments(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): ReadonlyArray<UploadChatAttachment> {
  return attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl: attachment.dataUrl,
  }));
}

/** @deprecated Use toUploadChatAttachments — kept for the document-only path. */
export const toUploadChatDocumentAttachments = toUploadChatAttachments;
