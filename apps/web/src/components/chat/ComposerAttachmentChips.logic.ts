import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

/**
 * Where focus should land after a chip is removed with the keyboard.
 *
 * Returns the id of the chip that takes the removed one's place, or null when
 * the row is now empty and focus belongs back in the prompt editor.
 */
export function resolveFocusAfterRemoval(
  ids: ReadonlyArray<string>,
  removedId: string,
): string | null {
  const index = ids.indexOf(removedId);
  if (index < 0) return null;
  const remaining = ids.filter((id) => id !== removedId);
  if (remaining.length === 0) return null;
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
}

/**
 * The slot counter stays hidden until it starts to matter. Showing "1 / 8" on
 * the first attachment is noise; showing nothing at 8 of 8 is a dead end.
 */
export function shouldShowAttachmentSlotCounter(count: number): boolean {
  return count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 2;
}

export function isAttachmentLimitReached(count: number): boolean {
  return count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
}

/**
 * Names that appear more than once in a batch. The server keeps them apart on
 * disk, but the user should not have to guess which chip is which.
 */
export function duplicateAttachmentNames(
  attachments: ReadonlyArray<{ readonly name: string }>,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const attachment of attachments) {
    const key = attachment.name.toLowerCase();
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}

export function attachmentKindLabel(input: {
  readonly type: "image" | "video" | "pdf" | "file";
  readonly mimeType: string;
  readonly name: string;
}): string {
  if (input.type === "pdf") return "PDF";
  if (input.type === "image") return "Image";
  if (input.type === "video") return "Video";
  if (input.mimeType.startsWith("audio/")) return "Audio";
  const extensionIndex = input.name.lastIndexOf(".");
  if (extensionIndex > 0) return input.name.slice(extensionIndex + 1).toUpperCase();
  return "File";
}
