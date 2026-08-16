import type { AssetResource, ThreadId } from "@t3tools/contracts";

/**
 * Resolves a markdown image/video `src` to something the app can load.
 *
 * Assistant media arrives three ways: an ordinary URL, a path inside the
 * thread workspace, or a Hermes browser artifact. Mirrors the web
 * `resolveMarkdownMediaSource` so both clients agree on what a given src means.
 */

const DIRECT_MEDIA_SRC_PATTERN = /^(?:https?:|data:|blob:|file:|\/\/)/i;
const ESCAPED_WINDOWS_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:[\\/]/;
const ABSOLUTE_PATH_PATTERN = /^(?:[/\\]|[A-Za-z]:[\\/])/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function markdownMediaFileName(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const basename = withoutQuery.slice(Math.max(withoutQuery.lastIndexOf("/"), -1) + 1);
  return basename.length > 0 ? safeDecode(basename) : safeDecode(withoutQuery);
}

function mediaPathFromSrc(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const decoded = safeDecode(withoutQuery);
  // Markdown from a Windows host arrives as "/C:/…"; drop the leading slash.
  return ESCAPED_WINDOWS_DRIVE_PATH_PATTERN.test(decoded) ? decoded.slice(1) : decoded;
}

function browserArtifactFileName(path: string): string | null {
  if (!ABSOLUTE_PATH_PATTERN.test(path)) return null;
  return /[/\\]browser-artifacts[/\\]([^/\\]+)$/.exec(path)?.[1] ?? null;
}

export type ResolvedMarkdownMediaSource =
  | { readonly _tag: "direct"; readonly url: string }
  | { readonly _tag: "resource"; readonly resource: AssetResource };

export function resolveMarkdownMediaSource(
  src: string,
  threadId: ThreadId,
): ResolvedMarkdownMediaSource {
  if (DIRECT_MEDIA_SRC_PATTERN.test(src)) {
    return { _tag: "direct", url: src };
  }
  const path = mediaPathFromSrc(src);
  const artifactFileName = browserArtifactFileName(path);
  return {
    _tag: "resource",
    resource: artifactFileName
      ? { _tag: "browser-artifact", fileName: artifactFileName }
      : {
          _tag: "workspace-file",
          threadId,
          path: path.startsWith("./") ? path.slice(2) : path,
        },
  };
}

const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|mov|m4v|webm)$/i;

/** Video needs a player rather than an <Image>, and the extension is all we have. */
export function isMarkdownVideoSource(src: string): boolean {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  return VIDEO_EXTENSION_PATTERN.test(withoutQuery);
}
