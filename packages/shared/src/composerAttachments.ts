/**
 * composerAttachments - one validator for every client surface.
 *
 * Web, desktop, and mobile all let a user attach files to a turn, and each used
 * to carry its own copy of the rules. They drifted: web refused non-image files
 * unless the provider was Hermes, mobile did not, so a mobile user on Claude
 * could attach a PDF that failed server-side at turn time.
 *
 * Uploads are now written into the workspace and handed to the agent as a path,
 * so the provider no longer constrains what a user may attach. What remains is
 * a small, platform-neutral set of rules that every client shares.
 *
 * @module composerAttachments
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

/** Mirrors the `ChatAttachment` union's `type` field. */
export type ComposerAttachmentKind = "image" | "file" | "pdf" | "video";

/**
 * Platform-neutral view of a pending attachment. Deliberately not `File`:
 * mobile has no `File`, it has picker assets and share payloads.
 */
export interface ComposerAttachmentDescriptor {
  readonly name: string;
  readonly sizeBytes: number;
  /** May be empty; callers get extension-based inference for free. */
  readonly mimeType: string;
}

export type ComposerAttachmentValidation =
  | {
      readonly accepted: true;
      readonly type: ComposerAttachmentKind;
      readonly mimeType: string;
      readonly name: string;
      readonly notices: ReadonlyArray<ComposerAttachmentNotice>;
    }
  | { readonly accepted: false; readonly message: string };

export type ComposerAttachmentNotice = "renamed" | "truncated";

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const ATTACHMENT_NAME_MAX_CHARS = 255;
const ATTACHMENT_MIME_MAX_CHARS = 100;

/**
 * Bidi overrides let `report.pdf<RLO>gpj.exe` render as `report.pdfexe.jpg` in a
 * chip the user is about to trust. Strip them everywhere, on every surface.
 */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) continue;
    result += character;
  }
  return result;
}

export const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".html": "text/html",
  ".ics": "text/calendar",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".log": "text/plain",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".rs": "text/rust",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".tiff": "image/tiff",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

/**
 * Reverse lookup for pickers that hand back a MIME type but no extension.
 * Android `content://` URIs do this constantly, and an extensionless blob in the
 * workspace is markedly less useful to an agent than a named one.
 */
export const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(MIME_TYPE_BY_EXTENSION).reduce<Record<string, string>>(
    (accumulator, [extension, mimeType]) => {
      accumulator[mimeType] ??= extension;
      return accumulator;
    },
    {},
  ),
);

export function inferMimeTypeFromFileName(name: string): string | null {
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex < 0) return null;
  return MIME_TYPE_BY_EXTENSION[name.slice(extensionIndex).toLowerCase()] ?? null;
}

export function inferExtensionFromMimeType(mimeType: string): string | null {
  return EXTENSION_BY_MIME_TYPE[mimeType.trim().toLowerCase()] ?? null;
}

/**
 * Maps a MIME type onto the `ChatAttachment` union's `type` discriminant. Audio
 * and archives intentionally land on `"file"`: the contract's generic branch
 * accepts them, and the agent reads them off disk like anything else.
 */
export function classifyComposerAttachment(mimeType: string, name: string): ComposerAttachmentKind {
  const resolved = (
    mimeType.trim().length > 0 ? mimeType : (inferMimeTypeFromFileName(name) ?? "")
  ).toLowerCase();
  if (resolved.startsWith("image/")) return "image";
  if (resolved === "application/pdf") return "pdf";
  if (resolved.startsWith("video/")) return "video";
  return "file";
}

/**
 * Normalizes a name for display and for the wire. Filesystem-path safety is a
 * separate, stricter concern owned by the server.
 */
export function normalizeAttachmentName(rawName: string): string {
  return stripControlCharacters(rawName.normalize("NFC").replace(BIDI_CONTROLS, "")).trim();
}

export interface SanitizedAttachmentName {
  readonly name: string;
  readonly notices: ReadonlyArray<ComposerAttachmentNotice>;
}

/**
 * Produces a wire-safe name. macOS hands back NFD from Finder drags, some
 * pickers include path separators, and a name long enough to be legal on APFS
 * still has to fit the contract's 255-char cap — so truncate rather than reject.
 */
export function sanitizeAttachmentName(rawName: string): SanitizedAttachmentName {
  const notices: Array<ComposerAttachmentNotice> = [];
  const normalized = normalizeAttachmentName(rawName);
  let name = normalized.replace(/[/\\]/gu, "-").trim();
  if (name !== normalized) notices.push("renamed");
  if (name === "." || name === "..") {
    name = "file";
    if (!notices.includes("renamed")) notices.push("renamed");
  }
  if (name.length > ATTACHMENT_NAME_MAX_CHARS) {
    name = truncatePreservingExtension(name, ATTACHMENT_NAME_MAX_CHARS);
    notices.push("truncated");
  }
  return { name, notices };
}

/**
 * Splits a trailing extension only when it looks like one. A 40-character
 * "extension" is a filename with a dot in it, and treating it as an extension
 * would truncate away the informative part of the name.
 */
export function splitFileExtension(name: string): { base: string; extension: string } {
  const match = /^(.+)(\.[A-Za-z0-9]{1,16})$/u.exec(name);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return { base: name, extension: "" };
  }
  return { base: match[1], extension: match[2] };
}

function truncatePreservingExtension(name: string, maxChars: number): string {
  const { base, extension } = splitFileExtension(name);
  const budget = maxChars - extension.length;
  if (budget <= 0) return Array.from(name).slice(0, maxChars).join("");
  return `${Array.from(base).slice(0, budget).join("")}${extension}`;
}

/**
 * Middle-ellipsis truncation that always keeps the extension visible. A leading
 * ellipsis would hide which of five `screenshot-*.png` files this chip is.
 */
export function middleTruncateFileName(name: string, maxChars: number): string {
  const characters = Array.from(name);
  if (characters.length <= maxChars || maxChars < 6) return name;
  const { extension } = splitFileExtension(name);
  const tailLength = Math.min(extension.length + 3, Math.floor(maxChars / 2));
  const headLength = maxChars - tailLength - 1;
  return `${characters.slice(0, headLength).join("")}…${characters.slice(-tailLength).join("")}`;
}

/** Human-readable byte size. Base-1024 to match the MiB caps it reports against. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) {
    return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  }
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

export function maxAttachmentBytesForKind(kind: ComposerAttachmentKind): number {
  return kind === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
}

/**
 * The complete client-side rule set. Three rejections survive the move to
 * workspace-materialized uploads: unusable name, empty file, over cap. Anything
 * else — audio, archives, executables, extensionless blobs — is the agent's to
 * open, not ours to gatekeep.
 */
export function validateComposerAttachment(
  descriptor: ComposerAttachmentDescriptor,
): ComposerAttachmentValidation {
  const sanitized = sanitizeAttachmentName(descriptor.name);
  const name = sanitized.name;
  if (name.length === 0) {
    return { accepted: false, message: "Attachment names must be plain file names." };
  }

  const suppliedMimeType = descriptor.mimeType.trim().toLowerCase();
  const mimeType =
    suppliedMimeType.length > 0
      ? suppliedMimeType
      : (inferMimeTypeFromFileName(name) ?? "application/octet-stream");
  if (mimeType.length > ATTACHMENT_MIME_MAX_CHARS || !MIME_TYPE.test(mimeType)) {
    return {
      accepted: false,
      message: `'${name}' has no usable file type and wasn't attached.`,
    };
  }

  // Zero bytes is both a useless upload and the practical directory-drop guard:
  // Safari surfaces a dropped folder as an empty, typeless file.
  if (!Number.isFinite(descriptor.sizeBytes) || descriptor.sizeBytes <= 0) {
    return { accepted: false, message: `'${name}' is empty and wasn't attached.` };
  }

  const type = classifyComposerAttachment(mimeType, name);
  const maxBytes = maxAttachmentBytesForKind(type);
  if (descriptor.sizeBytes > maxBytes) {
    const limit = `${Math.round(maxBytes / (1024 * 1024))} MB`;
    const actual = formatAttachmentSize(descriptor.sizeBytes);
    const subject = type === "image" ? "an image" : "a file";
    // Just over the cap rounds to the same number as the cap, and
    // "is 10 MB — over the 10 MB limit" reads like a bug.
    return {
      accepted: false,
      message:
        actual === limit
          ? `'${name}' is over the ${limit} limit for ${subject}.`
          : `'${name}' is ${actual} — over the ${limit} limit for ${subject}.`,
    };
  }

  return { accepted: true, type, mimeType, name, notices: sanitized.notices };
}

export interface PartitionedComposerAttachment<TItem> {
  readonly item: TItem;
  readonly type: ComposerAttachmentKind;
  readonly mimeType: string;
  readonly name: string;
  readonly notices: ReadonlyArray<ComposerAttachmentNotice>;
}

export interface PartitionedComposerAttachments<TItem> {
  readonly accepted: ReadonlyArray<PartitionedComposerAttachment<TItem>>;
  /** Every rejection reason, in input order, capacity overflow last. */
  readonly errors: ReadonlyArray<string>;
}

/**
 * Validates a batch against the remaining attachment slots. A capacity
 * rejection deliberately does not stop processing: every remaining item still
 * reports why it was dropped, so the composer can show all reasons at once
 * instead of one-per-retry.
 */
export function partitionComposerAttachments<TItem>(
  items: readonly TItem[],
  toDescriptor: (item: TItem) => ComposerAttachmentDescriptor,
  capacity: { readonly usedSlots: number },
): PartitionedComposerAttachments<TItem> {
  const accepted: Array<PartitionedComposerAttachment<TItem>> = [];
  const errors: string[] = [];
  const overflowing: string[] = [];
  let reserved = capacity.usedSlots;
  for (const item of items) {
    const descriptor = toDescriptor(item);
    const validation = validateComposerAttachment(descriptor);
    if (!validation.accepted) {
      errors.push(validation.message);
      continue;
    }
    if (reserved >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      overflowing.push(validation.name);
      continue;
    }
    accepted.push({
      item,
      type: validation.type,
      mimeType: validation.mimeType,
      name: validation.name,
      notices: validation.notices,
    });
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

/** Shared user-facing strings, so web and mobile cannot describe the same rule differently. */
export const ATTACHMENT_COPY = {
  dropTitle: "Drop files to add them to this chat",
  dropSubtitle: "They'll be saved into your project so the agent can read them.",
  dropLimitTitle: "Attachment limit reached",
  dropLimitSubtitle: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
  dropFolderTitle: "Folders can't be attached",
  dropFolderSubtitle: "Drop individual files, or @-mention the folder.",
  unreadableFile: (name: string) =>
    `'${name}' couldn't be read. If it's stored in iCloud or OneDrive, download it first.`,
  materializationFailedTitle: "Files weren't saved to your project",
  materializationFailedBody:
    "T3 couldn't write to .t3code/uploads in this worktree. The agent received the file contents in the message instead.",
} as const;
