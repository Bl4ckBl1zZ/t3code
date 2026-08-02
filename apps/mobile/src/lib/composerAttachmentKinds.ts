import type { UploadChatAttachment } from "@t3tools/contracts";

/**
 * Pure attachment-kind helpers, kept free of native imports so they stay
 * testable — the picker module itself reaches for expo-crypto and
 * expo-file-system, which the test runner cannot parse.
 */

export interface DraftComposerDocumentAttachment {
  readonly id: string;
  readonly type: "file" | "pdf" | "video";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
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

/** Wire shape for startTurn: drop the client-side draft id. */
export function toUploadChatDocumentAttachments(
  attachments: ReadonlyArray<DraftComposerDocumentAttachment>,
): ReadonlyArray<UploadChatAttachment> {
  return attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl: attachment.dataUrl,
  }));
}
