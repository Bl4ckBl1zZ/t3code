import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["report.html", "report.HTM", "document#draft.pdf", "reports?old/document.pdf"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector#mark.svg",
    "photo?edited.JPEG",
    "images#archive/icon.png",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["demo.m4v", "capture.MOV", "clip#1.mp4", "sessions?old/session.webm"])(
    "recognizes video preview path %s",
    (path) => {
      expect(isWorkspaceVideoPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    "README.md",
    "src/index.ts",
    "image.png.ts",
    "png",
    "image.png#notes.txt",
    "image.svg?notes.txt",
    "document.pdf?download=1",
    "report.html#notes.txt",
    "clip.mp4?download=1",
    "image%2Epng",
  ])("rejects non-preview path %s", (path) => {
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });
});
