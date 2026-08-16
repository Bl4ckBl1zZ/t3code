// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = NodePath.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

/** Resolves `relativePath` under `root`, returning null on any escape attempt. */
export function resolvePathWithinRoot(input: {
  readonly root: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const root = NodePath.resolve(input.root);
  const filePath = NodePath.resolve(NodePath.join(root, normalizedRelativePath));
  if (!filePath.startsWith(`${root}${NodePath.sep}`)) {
    return null;
  }
  return filePath;
}

export function resolveAttachmentRelativePath(input: {
  readonly attachmentsDir: string;
  readonly relativePath: string;
}): string | null {
  return resolvePathWithinRoot({ root: input.attachmentsDir, relativePath: input.relativePath });
}
