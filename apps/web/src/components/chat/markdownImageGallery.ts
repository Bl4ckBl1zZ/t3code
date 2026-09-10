import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

// Resolved URLs are retained only while their rendered image is reachable.
export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

/** Resolve linked full-size images while leaving ordinary linked badges navigable. */
export function markdownGalleryItem(element: Element): ExpandedImageItem | null {
  const registered = markdownImageItems.get(element);
  if (!registered) return null;
  const link = element.closest("a");
  const href = link?.getAttribute("href") ?? "";
  if (!link) return registered;
  if (!isWorkspaceImagePreviewPath(href)) return null;
  return resolveExternalWebLinkHost(href) !== null
    ? { ...registered, src: resolveProtocolRelativeMediaUrl(href) }
    : registered;
}

/** Collect lazily in document order, across PR markdown sections separated by media. */
export function markdownImageGallery(element: Element): ExpandedImagePreview | null {
  const selected = markdownGalleryItem(element);
  if (!selected) return null;
  const scope = element.closest("[data-image-gallery]") ?? element.closest(".chat-markdown");
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const image of scope?.querySelectorAll("img") ?? []) {
    const item = markdownGalleryItem(image);
    if (!item) continue;
    if (image === element) index = images.length;
    images.push(item);
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}
