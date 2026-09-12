import { describe, expect, it } from "vite-plus/test";
import { expandedImageIndex } from "./ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";

// Only the DOM traversal used by the gallery is needed; no image decoding or layout.
function galleryFixture(entries: Array<{ src: string; href?: string; registered?: boolean }>) {
  const images: Element[] = [];
  const scope = { querySelectorAll: () => images };
  for (const [index, entry] of entries.entries()) {
    const image = {
      closest: (selector: string) =>
        selector === "a"
          ? entry.href === undefined
            ? null
            : { getAttribute: () => entry.href }
          : scope,
    } as unknown as Element;
    if (entry.registered !== false)
      markdownImageItems.set(image, { src: entry.src, name: `Image ${index}` });
    images.push(image);
  }
  return images;
}

describe("Markdown image galleries", () => {
  it("keeps document order and selects the clicked occurrence of repeated images", () => {
    const images = galleryFixture([
      { src: "same.png" },
      { src: "middle.png" },
      { src: "same.png" },
    ]);
    expect(markdownImageGallery(images[2]!)).toEqual({
      index: 2,
      images: [
        { src: "same.png", name: "Image 0" },
        { src: "middle.png", name: "Image 1" },
        { src: "same.png", name: "Image 2" },
      ],
    });
  });
  it("skips navigation badges and unregistered images and opens linked full-size images", () => {
    const images = galleryFixture([
      { src: "badge.svg", href: "https://example.com/build" },
      { src: "favicon.png", registered: false },
      { src: "thumbnail.png", href: "https://example.com/full.PNG?download=1" },
      { src: "last.png" },
    ]);
    expect(markdownImageGallery(images[0]!)).toBeNull();
    expect(markdownImageGallery(images[2]!)).toEqual({
      index: 0,
      images: [
        { src: "https://example.com/full.PNG?download=1", name: "Image 2" },
        { src: "last.png", name: "Image 3" },
      ],
    });
  });
  it("uses a single-image fallback outside a gallery scope", () => {
    const element = { closest: () => null } as unknown as Element;
    const item = { src: "https://example.com/photo.png", name: "Photo" };
    markdownImageItems.set(element, item);
    expect(markdownImageGallery(element)).toEqual({ images: [item], index: 0 });
    markdownImageItems.delete(element);
    expect(markdownImageGallery(element)).toBeNull();
  });
  it("wraps in either direction across multiple complete cycles", () => {
    expect(expandedImageIndex(0, -7, 3)).toBe(2);
    expect(expandedImageIndex(2, 8, 3)).toBe(1);
    expect(expandedImageIndex(0, -20, 1)).toBe(0);
    expect(expandedImageIndex(0, 0, 0)).toBe(0);
  });
});
