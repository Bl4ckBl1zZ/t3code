import { resolvePathLinkTarget } from "~/terminal-links";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { MediaActions } from "../media/MediaActions";
import {
  mediaFileReference,
  mediaUrlReference,
  type MediaReference,
} from "@t3tools/client-runtime/media-reference";
import { assetEnvironment } from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, ScopedThreadRef } from "@t3tools/contracts";
import { isWorkspaceVideoPreviewPath } from "@t3tools/shared/filePreview";
import { memo, useState } from "react";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { createPortal } from "react-dom";

import { useAssetUrlState } from "../../assets/assetUrls";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

const DIRECT_MEDIA_SRC_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;
const ESCAPED_WINDOWS_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:[\\/]/;
const ABSOLUTE_PATH_PATTERN = /^(?:[/\\]|[A-Za-z]:[\\/])/;
const MEDIA_FRAME_CLASS_NAME =
  "my-2 block max-h-96 max-w-full rounded-lg border border-border/60 bg-background object-contain";

interface MarkdownMediaProps {
  baseDirectory?: string | undefined;
  src: string | undefined;
  alt?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  kind?: "image" | "video" | undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mediaFileName(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const basename = withoutQuery.slice(Math.max(withoutQuery.lastIndexOf("/"), -1) + 1);
  return basename.length > 0 ? safeDecode(basename) : safeDecode(withoutQuery);
}

function mediaPathFromSrc(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const decoded = safeDecode(withoutQuery);
  return ESCAPED_WINDOWS_DRIVE_PATH_PATTERN.test(decoded) ? decoded.slice(1) : decoded;
}

function browserArtifactFileName(path: string): string | null {
  if (!ABSOLUTE_PATH_PATTERN.test(path)) {
    return null;
  }
  return /[/\\]browser-artifacts[/\\]([^/\\]+)$/.exec(path)?.[1] ?? null;
}

export type ResolvedMarkdownMediaSource =
  | { readonly _tag: "direct"; readonly url: string }
  | { readonly _tag: "resource"; readonly resource: AssetResource };

export function resolveMarkdownMediaSource(
  src: string,
  threadRef: ScopedThreadRef,
  baseDirectory?: string,
): ResolvedMarkdownMediaSource {
  if (DIRECT_MEDIA_SRC_PATTERN.test(src)) {
    return { _tag: "direct", url: src };
  }
  const authoredPath = mediaPathFromSrc(src);
  const path =
    baseDirectory && !ABSOLUTE_PATH_PATTERN.test(authoredPath)
      ? resolvePathLinkTarget(authoredPath, baseDirectory)
      : authoredPath;
  const artifactFileName = browserArtifactFileName(path);
  return {
    _tag: "resource",
    resource: artifactFileName
      ? { _tag: "browser-artifact", fileName: artifactFileName }
      : {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: path.startsWith("./") ? path.slice(2) : path,
        },
  };
}

function MediaUnavailable({ name }: { name: string }) {
  return (
    <span className="my-1 inline-flex max-w-full items-baseline gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
      Media unavailable:
      <span className="truncate font-mono">{name}</span>
    </span>
  );
}

function ResolvedMedia({
  url,
  name,
  isVideo,
  reference,
  asset,
  onRetry,
}: {
  url: string;
  name: string;
  isVideo: boolean;
  reference?: MediaReference;
  asset?: { environmentId: ScopedThreadRef["environmentId"]; resource: AssetResource };
  onRetry?: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (isVideo) {
    return (
      <MediaVideoPlayer
        src={url}
        label={name}
        className="my-2 block max-h-96 max-w-full"
        videoClassName={MEDIA_FRAME_CLASS_NAME}
        onRetry={onRetry}
        actionsSource={{
          kind: "video",
          name,
          src: url,
          ...(reference ? { reference } : {}),
          ...(asset ? { asset } : {}),
        }}
      />
    );
  }
  if (failedUrl === url) return <MediaUnavailable name={name} />;
  return (
    <>
      <MediaActions
        source={{
          kind: "image",
          name,
          src: url,
          ...(reference ? { reference } : {}),
          ...(asset ? { asset } : {}),
        }}
      >
        <button
          type="button"
          className="block max-w-full cursor-zoom-in"
          aria-label={`Expand image ${name}`}
          onClick={(event) => {
            const image = event.currentTarget.querySelector("img");
            const preview = image ? markdownImageGallery(image) : null;
            if (!preview) return;
            event.preventDefault();
            event.stopPropagation();
            setExpanded(preview);
          }}
        >
          <img
            ref={(image) => {
              if (!image) return;
              markdownImageItems.set(image, { src: url, name });
              return () => {
                markdownImageItems.delete(image);
              };
            }}
            src={url}
            alt={name}
            loading="lazy"
            className={MEDIA_FRAME_CLASS_NAME}
            onError={() => setFailedUrl(url)}
          />
        </button>
      </MediaActions>
      {expanded &&
        createPortal(
          <ExpandedImageDialog preview={expanded} onClose={() => setExpanded(null)} />,
          document.body,
        )}
    </>
  );
}

function ResourceMedia({
  threadRef,
  resource,
  name,
  isVideo,
}: {
  threadRef: ScopedThreadRef;
  resource: AssetResource;
  name: string;
  isVideo: boolean;
}) {
  const assetUrl = useAssetUrlState(threadRef.environmentId, resource);
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const retry = async () => {
    const result = await refresh({ environmentId: threadRef.environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };
  if (isVideo) {
    const reference =
      assetUrl._tag === "Success" && assetUrl.sourcePath
        ? mediaFileReference(assetUrl.sourcePath)
        : undefined;
    const src = assetUrl._tag === "Success" ? assetUrl.url : null;
    return (
      <MediaVideoPlayer
        src={src}
        label={name}
        sourceFailed={assetUrl._tag === "Failure"}
        onRetry={retry}
        className="my-2 block max-h-96 max-w-full"
        videoClassName={MEDIA_FRAME_CLASS_NAME}
        actionsSource={{
          kind: "video",
          name,
          src,
          ...(reference ? { reference } : {}),
          asset: { environmentId: threadRef.environmentId, resource },
        }}
      />
    );
  }
  if (assetUrl._tag === "Failure") {
    return <MediaUnavailable name={name} />;
  }
  if (assetUrl._tag === "Loading") {
    return (
      <span className="my-2 flex h-24 w-56 max-w-full animate-pulse items-center justify-center rounded-lg border border-border/40 bg-muted/30 px-2 text-xs text-muted-foreground">
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return (
    <ResolvedMedia
      url={assetUrl.url}
      name={name}
      isVideo={isVideo}
      {...(assetUrl.sourcePath ? { reference: mediaFileReference(assetUrl.sourcePath) } : {})}
      asset={{ environmentId: threadRef.environmentId, resource }}
      onRetry={retry}
    />
  );
}

export const MarkdownMedia = memo(function MarkdownMedia({
  src,
  alt,
  threadRef,
  kind,
  baseDirectory,
}: MarkdownMediaProps) {
  if (!src) {
    return null;
  }
  const name = alt && alt.trim().length > 0 ? alt.trim() : mediaFileName(src);
  const isVideo = kind === "video" || (kind === undefined && isWorkspaceVideoPreviewPath(src));
  if (!threadRef) {
    return DIRECT_MEDIA_SRC_PATTERN.test(src) ? (
      <ResolvedMedia
        url={src}
        name={name}
        isVideo={isVideo}
        {...(mediaUrlReference(src) ? { reference: mediaUrlReference(src)! } : {})}
      />
    ) : (
      <MediaUnavailable name={name} />
    );
  }
  const resolved = resolveMarkdownMediaSource(src, threadRef, baseDirectory);
  return resolved._tag === "direct" ? (
    <ResolvedMedia
      url={resolved.url}
      name={name}
      isVideo={isVideo}
      {...(mediaUrlReference(resolved.url) ? { reference: mediaUrlReference(resolved.url)! } : {})}
    />
  ) : (
    <ResourceMedia
      threadRef={threadRef}
      resource={resolved.resource}
      name={name}
      isVideo={isVideo}
    />
  );
});
