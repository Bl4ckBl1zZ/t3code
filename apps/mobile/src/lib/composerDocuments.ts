import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";

import { estimateBase64ByteSize } from "./base64";
import {
  documentAttachmentKind,
  formatAttachmentSizeLimitError,
  type DraftComposerDocumentAttachment,
} from "./composerAttachmentKinds";
import { uuidv4 } from "./uuid";

/**
 * Non-image composer attachments: PDFs, videos, and generic files.
 *
 * Images keep their own path in composerImages.ts because they carry a preview
 * URI and a tighter size cap; everything here shares the 20 MB file limit and
 * renders as a chip rather than a thumbnail.
 */
async function loadDocumentPicker() {
  return await import("expo-document-picker");
}

async function loadFileSystem() {
  return await import("expo-file-system");
}

/**
 * Opens the system document browser. An unrestricted type filter keeps PDFs,
 * videos and arbitrary documents in one affordance — the server validates the
 * MIME against the contract, so the picker stays permissive rather than
 * maintaining a second allowlist that could drift.
 */
export async function pickComposerDocuments(input: {
  readonly existingCount: number;
}): Promise<{
  readonly documents: ReadonlyArray<DraftComposerDocumentAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      documents: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    };
  }

  let documentPicker: Awaited<ReturnType<typeof loadDocumentPicker>>;
  let fileSystem: Awaited<ReturnType<typeof loadFileSystem>>;
  try {
    documentPicker = await loadDocumentPicker();
    fileSystem = await loadFileSystem();
  } catch (error) {
    return {
      documents: [],
      error:
        error instanceof Error ? error.message : "File attachments are unavailable right now.",
    };
  }

  const result = await documentPicker.getDocumentAsync({
    type: "*/*",
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return { documents: [], error: null };

  const documents: DraftComposerDocumentAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets.slice(0, remainingSlots)) {
    const name = asset.name.length > 0 ? asset.name : "file";
    const mimeType = asset.mimeType?.toLowerCase() ?? "application/octet-stream";
    let base64: string;
    try {
      const file = new fileSystem.File(asset.uri);
      base64 = await file.base64();
    } catch {
      error = `Failed to read '${name}'.`;
      continue;
    }

    const sizeBytes = asset.size ?? estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      error = formatAttachmentSizeLimitError(name);
      continue;
    }

    documents.push({
      id: uuidv4(),
      type: documentAttachmentKind(mimeType),
      name,
      mimeType,
      sizeBytes,
      dataUrl: `data:${mimeType};base64,${base64}`,
    });
  }

  if (documents.length === 0 && error === null && result.assets.length > remainingSlots) {
    error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
  }
  return { documents, error };
}

export {
  documentAttachmentKind,
  formatAttachmentSizeLimitError,
  toUploadChatDocumentAttachments,
  type DraftComposerDocumentAttachment,
} from "./composerAttachmentKinds";
