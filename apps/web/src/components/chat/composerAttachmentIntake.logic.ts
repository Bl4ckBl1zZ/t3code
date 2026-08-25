/**
 * Pure intake decisions for the composer's paste and drop handlers.
 *
 * These live outside ChatComposer because they are the parts most worth
 * pinning down with tests, and because a `DataTransfer` is awkward to reach
 * inside a 3400-line component.
 */
import { validateComposerAttachment } from "./composerAttachmentValidation";

export type ComposerPastePolicy = "attach-and-keep-text" | "attach-only" | "ignore";

type FileLike = Pick<File, "name" | "size" | "type">;

/**
 * Decides what a paste means when the clipboard carries both files and text.
 *
 * Claiming the paste outright whenever a file is attachable silently throws
 * away pasted text, which is what the composer used to do. Real clipboards mix
 * the two constantly: copying a cell from Excel or a region from Chrome yields
 * `text/html` plus an image, while copying a file in Finder can yield a name in
 * `text/plain` alongside the file itself.
 */
export function resolvePastePolicy(input: {
  readonly types: ReadonlyArray<string>;
  readonly files: ReadonlyArray<FileLike>;
}): ComposerPastePolicy {
  // Web's adapter, not the shared validator: it is what normalizes HEIC photos
  // into the JPEG they are converted to, so a pasted iPhone photo is attachable.
  const hasAttachable = input.files.some((file) => validateComposerAttachment(file).accepted);
  if (!hasAttachable) return "ignore";
  // Only plain text is worth preserving. `text/html` alongside an image is the
  // screenshot case, where the markup is the image and pasting it as text would
  // dump a wall of tags into the composer.
  return input.types.includes("text/plain") ? "attach-and-keep-text" : "attach-only";
}

export interface DroppedDataTransfer {
  readonly files: ReadonlyArray<File>;
  readonly directoryNames: ReadonlyArray<string>;
  readonly hadNonFileData: boolean;
}

type DataTransferItemLike = {
  readonly kind: string;
  readonly type: string;
  webkitGetAsEntry?: () => { readonly isDirectory: boolean; readonly name: string } | null;
};

/**
 * Splits a drop into attachable files and dropped folders.
 *
 * Must be called synchronously from the drop handler: `DataTransferItem`s are
 * invalidated as soon as the event returns, so any `await` first would leave
 * `webkitGetAsEntry` returning null and folders would silently look like files.
 */
export function partitionDroppedDataTransfer(input: {
  readonly items: ReadonlyArray<DataTransferItemLike>;
  readonly files: ReadonlyArray<File>;
}): DroppedDataTransfer {
  const directoryNames: string[] = [];
  let hadNonFileData = false;
  const directoryIndexes = new Set<number>();

  input.items.forEach((item, index) => {
    if (item.kind !== "file") {
      hadNonFileData = true;
      return;
    }
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (entry?.isDirectory === true) {
      directoryIndexes.add(index);
      directoryNames.push(entry.name);
    }
  });

  // `items` and `files` are parallel for file-kind entries in every browser we
  // support; when they are not, dropping the folder filter is safer than
  // dropping a real file, since a folder still fails the zero-byte check.
  const files =
    directoryIndexes.size === 0 || input.items.length !== input.files.length
      ? input.files
      : input.files.filter((_, index) => !directoryIndexes.has(index));

  return { files, directoryNames, hadNonFileData };
}
