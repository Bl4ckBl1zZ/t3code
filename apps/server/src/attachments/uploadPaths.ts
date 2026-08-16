// @effect-diagnostics nodeBuiltinImport:off
/**
 * uploadPaths - where a chat upload lands inside the user's workspace, and how
 * the agent is told about it.
 *
 * Pure by design: every rule here is a string transform we want to pin down with
 * a table test rather than discover from a corrupted filesystem.
 *
 * @module uploadPaths
 */
import * as NodeCrypto from "node:crypto";

import type { ChatAttachment } from "@t3tools/contracts";
import {
  formatAttachmentSize,
  normalizeAttachmentName,
  splitFileExtension,
} from "@t3tools/shared/composerAttachments";

import { IMAGE_EXTENSION_BY_MIME_TYPE } from "../imageMime.ts";

export const T3CODE_DIR = ".t3code";
export const UPLOADS_DIR = "uploads";
export const UPLOADS_RELATIVE_DIR = `${T3CODE_DIR}/${UPLOADS_DIR}`;
export const UPLOADS_GITIGNORE_RELATIVE_PATH = `${UPLOADS_RELATIVE_DIR}/.gitignore`;

/**
 * A bare `*` matches dotfiles, so this file ignores itself. The whole subtree
 * becomes invisible to `git status`, to PR diffs, and — the reason this matters
 * most — to the `git add -A` that builds checkpoint trees.
 */
export const UPLOADS_GITIGNORE_MARKER = "# T3 Code saves chat uploads here.";
export const UPLOADS_GITIGNORE_CONTENTS = `${UPLOADS_GITIGNORE_MARKER}
# They are local scratch files and are never committed.
*
`;

const SEGMENT_CHARS = 8;
const UUID_SUFFIX_PATTERN = /-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Leaves room under the 255-byte `NAME_MAX` on ext4/APFS once the `<segment>-`
 * prefix is added, with slack for the `.partial` suffix used while writing.
 */
const UPLOAD_FILE_NAME_MAX_BYTES = 180;
const WINDOWS_ILLEGAL = /[<>:"|?*\\/]/gu;
const PROMPT_BLOCK_MAX_CHARS = 4096;

function shortHash(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, SEGMENT_CHARS);
}

/**
 * A real `ThreadId` sanitizes to a ~117-character directory name, which is
 * legible to nobody and close to the per-segment limit. A fixed-width hash keeps
 * the tree browsable and is stable for the life of the thread.
 */
export function threadUploadSegment(threadId: string): string {
  return shortHash(threadId);
}

/**
 * Attachment ids are already deterministic — see `createDeterministicAttachmentId`
 * in `attachmentStore.ts`, keyed on `(threadId, "<messageId>:<index>")`. Reusing
 * the uuid half means a resend, a steer, a restart, or a session resume all
 * recompute the same path, and two files named `spec.pdf` in one message cannot
 * collide.
 */
export function attachmentUploadSegment(attachmentId: string): string {
  const match = UUID_SUFFIX_PATTERN.exec(attachmentId);
  const uuidHead = match?.[1];
  // Ids imported from v1 threads don't always match the pattern.
  return uuidHead === undefined ? shortHash(attachmentId) : uuidHead.toLowerCase();
}

function truncateToByteLength(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let result = "";
  let usedBytes = 0;
  // Iterating the string yields whole code points, so emoji never split.
  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (usedBytes + characterBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

function fallbackExtension(input: {
  readonly mimeType: string;
  readonly type: ChatAttachment["type"];
}): string {
  switch (input.type) {
    case "image":
      return IMAGE_EXTENSION_BY_MIME_TYPE[input.mimeType.toLowerCase()] ?? ".img";
    case "pdf":
      return ".pdf";
    case "video":
      return ".mp4";
    case "file":
      return "";
  }
}

/**
 * Makes a name safe to write on every filesystem we support, while keeping it
 * recognisable to the user who uploaded it.
 *
 * Case is deliberately preserved: the per-attachment hash prefix already
 * guarantees uniqueness, so lowercasing would only cost legibility.
 */
export function sanitizeUploadFileName(input: {
  readonly name: string;
  readonly mimeType: string;
  readonly type: ChatAttachment["type"];
}): string {
  let name = normalizeAttachmentName(input.name)
    .replace(WINDOWS_ILLEGAL, "-")
    // Agents write `cat <path>` unquoted constantly; spaces are not worth the risk.
    .replace(/\s+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+/u, "")
    // Trailing dots and spaces are illegal on Windows.
    .replace(/[-.]+$/u, "");
  // A leading dot is safe to keep: the filename always starts with the
  // attachment's hash segment, so `.env` stays `.env` rather than becoming `env`.

  const { base, extension } = splitFileExtension(name);
  if (extension.length > 0) {
    const budget = UPLOAD_FILE_NAME_MAX_BYTES - extension.length;
    name = `${truncateToByteLength(base, Math.max(budget, 1))}${extension}`;
  } else {
    name = truncateToByteLength(name, UPLOAD_FILE_NAME_MAX_BYTES);
  }

  if (name.length === 0 || name === "." || name === "..") {
    return `file${fallbackExtension(input)}`;
  }
  return name;
}

export function threadUploadsRelativeDir(threadId: string): string {
  return `${UPLOADS_RELATIVE_DIR}/${threadUploadSegment(threadId)}`;
}

/** Workspace-relative, POSIX. Deterministic for a given (thread, attachment). */
export function uploadRelativePath(input: {
  readonly threadId: string;
  readonly attachment: ChatAttachment;
}): string {
  const fileName = sanitizeUploadFileName({
    name: input.attachment.name,
    mimeType: input.attachment.mimeType,
    type: input.attachment.type,
  });
  return `${threadUploadsRelativeDir(input.threadId)}/${attachmentUploadSegment(
    input.attachment.id,
  )}-${fileName}`;
}

export interface UploadedFilePromptEntry {
  readonly relativePath: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /**
   * True when the attachment is also delivered inline as a vision block. Without
   * this, the model sees a screenshot *and* reads "the user uploaded
   * screenshot.png", which reads like two separate files.
   */
  readonly alsoInline: boolean;
}

/**
 * The block appended to the turn text. XML-delimited to match the existing
 * `<t3_code_orchestration_instructions>` convention, so it nests cleanly when
 * `t3OrchestrationPromptForFirstRun` wraps a run-1 prompt and reads as
 * machine-generated rather than as the user's own words.
 */
export function uploadedFilesPromptBlock(
  entries: ReadonlyArray<UploadedFilePromptEntry>,
): string | null {
  if (entries.length === 0) return null;
  const noun = entries.length === 1 ? "file" : "files";
  const lines = [
    "<t3_uploaded_files>",
    `The user uploaded ${entries.length} ${noun} with this message. T3 Code saved`,
    "them into your working directory; read them with your own file tools at the",
    "paths below. They are gitignored scratch files — do not commit them, and do",
    "not ask the user to resend them.",
    "",
  ];
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.relativePath}`);
    lines.push(
      `   original name: ${JSON.stringify(entry.name)} — ${entry.mimeType}, ${formatAttachmentSize(
        entry.sizeBytes,
      )}`,
    );
    if (entry.alsoInline) {
      lines.push("   (also attached to this message as an image)");
    }
  });
  lines.push("</t3_uploaded_files>");
  const block = lines.join("\n");
  return block.length <= PROMPT_BLOCK_MAX_CHARS
    ? block
    : `${block.slice(0, PROMPT_BLOCK_MAX_CHARS)}\n</t3_uploaded_files>`;
}

/**
 * An attachment-only message ends up as the block alone, which is what stops
 * every adapter's "turn requires non-empty text" guard from firing.
 */
export function appendUploadedFilesBlock(text: string, block: string | null): string {
  if (block === null) return text;
  return text.trim().length === 0 ? block : `${text}\n\n${block}`;
}
