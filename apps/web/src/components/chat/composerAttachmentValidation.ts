import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
} from "@t3tools/contracts";

export type ComposerAttachmentKind = "image" | "file" | "pdf" | "video";

export type ComposerAttachmentValidation =
  | { readonly accepted: true; readonly type: ComposerAttachmentKind; readonly mimeType: string }
  | { readonly accepted: false; readonly message: string };

const SAFE_NAME = /^[^/\\]+$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

export function composerAttachmentAccept(provider: ProviderDriverKind): string | undefined {
  return provider === ProviderDriverKind.make("hermes") ? undefined : "image/*";
}

function inferKnownMimeType(name: string): string | null {
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex < 0) return null;
  return MIME_TYPE_BY_EXTENSION[name.slice(extensionIndex).toLowerCase()] ?? null;
}

function isSafeAttachmentName(name: string): boolean {
  if (!SAFE_NAME.test(name)) return false;
  // "." and ".." are directory traversal segments, not file names.
  if (name === "." || name === "..") return false;
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false;
  }
  return true;
}

export function validateComposerAttachment(
  file: Pick<File, "name" | "size" | "type">,
  provider: ProviderDriverKind,
): ComposerAttachmentValidation {
  const name = file.name.trim();
  if (name.length === 0 || name.length > 255 || !isSafeAttachmentName(name)) {
    return { accepted: false, message: "Attachment names must be safe, plain file names." };
  }
  const suppliedMimeType = file.type.trim().toLowerCase();
  const mimeType =
    suppliedMimeType.length > 0 ? suppliedMimeType : (inferKnownMimeType(name) ?? "");
  if (mimeType.length === 0 || mimeType.length > 100 || !MIME_TYPE.test(mimeType)) {
    return {
      accepted: false,
      message: `'${name}' has no trustworthy MIME type and cannot be attached.`,
    };
  }
  if (mimeType.startsWith("audio/")) {
    return {
      accepted: false,
      message: `Audio attachment '${name}' is unsupported because this protocol has no sound input path.`,
    };
  }
  const type: ComposerAttachmentKind = mimeType.startsWith("image/")
    ? "image"
    : mimeType === "application/pdf"
      ? "pdf"
      : mimeType.startsWith("video/")
        ? "video"
        : "file";
  if (type !== "image" && provider !== ProviderDriverKind.make("hermes")) {
    return {
      accepted: false,
      message: `${type === "pdf" ? "PDF" : type === "video" ? "Video" : "File"} attachments are currently supported only in Hermes conversations.`,
    };
  }
  const maxBytes =
    type === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  if (file.size > maxBytes) {
    return {
      accepted: false,
      message: `'${name}' exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB attachment limit.`,
    };
  }
  return { accepted: true, type, mimeType };
}

export interface PartitionedComposerAttachments<TFile> {
  /** Files that passed validation and fit within the remaining attachment slots. */
  readonly accepted: ReadonlyArray<{
    readonly file: TFile;
    readonly type: ComposerAttachmentKind;
    readonly mimeType: string;
  }>;
  /** Every rejection reason, including capacity rejections, in file order. */
  readonly errors: ReadonlyArray<string>;
}

/**
 * Validates a batch of files against the provider rules and the remaining
 * attachment capacity. Unlike a short-circuiting loop, a capacity rejection
 * does not stop processing: every remaining file still reports why it was
 * dropped so the composer can surface all reasons at once.
 */
export function partitionComposerAttachments<TFile extends Pick<File, "name" | "size" | "type">>(
  files: readonly TFile[],
  provider: ProviderDriverKind,
  usedSlots: number,
): PartitionedComposerAttachments<TFile> {
  const accepted: Array<{ file: TFile; type: ComposerAttachmentKind; mimeType: string }> = [];
  const errors: string[] = [];
  const overflowing: string[] = [];
  let reserved = usedSlots;
  for (const file of files) {
    const validation = validateComposerAttachment(file, provider);
    if (!validation.accepted) {
      errors.push(validation.message);
      continue;
    }
    if (reserved >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      overflowing.push(file.name.trim() || "attachment");
      continue;
    }
    accepted.push({ file, type: validation.type, mimeType: validation.mimeType });
    reserved += 1;
  }
  if (overflowing.length > 0) {
    errors.push(
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message. Skipped ${overflowing
        .map((name) => `'${name}'`)
        .join(", ")}.`,
    );
  }
  return { accepted, errors };
}
