import {
  isMarkdownFileLinkLabel as isSharedMarkdownFileLinkLabel,
  resolveInlineCodeFileLinkTarget,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import { filePathPosition } from "@t3tools/shared/fileLinks";
import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export {
  extractMarkdownLinkHrefs,
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "@t3tools/shared/markdownLinks";
export { workspaceRelativeFilePath } from "@t3tools/shared/path";

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

/** Inline code that names a file (see `resolveInlineCodeFileLinkTarget`), as chip metadata. */
export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveInlineCodeFileLinkTarget(codeText, cwd);
  return targetPath ? buildFileLinkMetaFromTarget(targetPath, cwd) : null;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  if (!targetPath) return null;
  return buildFileLinkMetaFromTarget(targetPath, cwd);
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = filePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

/**
 * Whether a file link's label only names its destination (a filename or path,
 * optionally with the same position). Such labels collapse into the file chip;
 * descriptive prose is kept next to it.
 */
export function isMarkdownFileLinkLabel(label: string, meta: MarkdownFileLinkMeta): boolean {
  return isSharedMarkdownFileLinkLabel(label, {
    path: meta.filePath,
    ...(meta.line !== undefined ? { line: meta.line } : {}),
    ...(meta.column !== undefined ? { column: meta.column } : {}),
  });
}
