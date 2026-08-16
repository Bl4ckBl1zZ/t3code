/**
 * Web's adapter onto the shared composer-attachment rules.
 *
 * The rules themselves live in `@t3tools/shared/composerAttachments` so web and
 * mobile cannot drift again — they already had, which is how a mobile user on
 * Claude could attach a PDF that web refused and the server then rejected.
 *
 * All this file owns is the `File` -> descriptor mapping, because `File` is a
 * browser type mobile does not have.
 */
import {
  type ComposerAttachmentDescriptor,
  type ComposerAttachmentKind,
  type ComposerAttachmentValidation,
  type PartitionedComposerAttachments,
  partitionComposerAttachments as partitionShared,
  validateComposerAttachment as validateShared,
} from "@t3tools/shared/composerAttachments";

export type { ComposerAttachmentKind, ComposerAttachmentValidation };
export type { PartitionedComposerAttachments };

type FileLike = Pick<File, "name" | "size" | "type">;

export function composerFileDescriptor(file: FileLike): ComposerAttachmentDescriptor {
  return { name: file.name, sizeBytes: file.size, mimeType: file.type };
}

export function validateComposerAttachment(file: FileLike): ComposerAttachmentValidation {
  return validateShared(composerFileDescriptor(file));
}

export function partitionComposerAttachments<TFile extends FileLike>(
  files: readonly TFile[],
  usedSlots: number,
): PartitionedComposerAttachments<TFile> {
  return partitionShared(files, composerFileDescriptor, { usedSlots });
}
