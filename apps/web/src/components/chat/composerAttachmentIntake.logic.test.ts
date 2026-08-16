import { describe, expect, it } from "vite-plus/test";

import { partitionDroppedDataTransfer, resolvePastePolicy } from "./composerAttachmentIntake.logic";

const image = { name: "shot.png", size: 12, type: "image/png" };

describe("resolvePastePolicy", () => {
  it("ignores a paste with nothing attachable", () => {
    expect(
      resolvePastePolicy({
        types: ["text/plain"],
        files: [{ name: "empty", size: 0, type: "" }],
      }),
    ).toBe("ignore");
  });

  // Regression: the composer used to preventDefault whenever any file was
  // attachable, silently discarding the text the user also pasted.
  it("keeps pasted text when the clipboard carries both text and a file", () => {
    expect(resolvePastePolicy({ types: ["text/plain", "Files"], files: [image] })).toBe(
      "attach-and-keep-text",
    );
  });

  it("claims the paste for the screenshot case, where the markup is the image", () => {
    expect(resolvePastePolicy({ types: ["text/html", "Files"], files: [image] })).toBe(
      "attach-only",
    );
  });

  it("claims a files-only paste", () => {
    expect(resolvePastePolicy({ types: ["Files"], files: [image] })).toBe("attach-only");
  });
});

describe("partitionDroppedDataTransfer", () => {
  const fileItem = (isDirectory: boolean, name: string) => ({
    kind: "file",
    type: "",
    webkitGetAsEntry: () => ({ isDirectory, name }),
  });

  it("passes plain file drops straight through", () => {
    const result = partitionDroppedDataTransfer({
      items: [fileItem(false, "shot.png")],
      files: [image as unknown as File],
    });
    expect(result.files).toHaveLength(1);
    expect(result.directoryNames).toEqual([]);
  });

  it("separates a dropped folder from the files beside it", () => {
    const result = partitionDroppedDataTransfer({
      items: [fileItem(true, "src"), fileItem(false, "shot.png")],
      files: [{ name: "src" } as unknown as File, image as unknown as File],
    });
    expect(result.directoryNames).toEqual(["src"]);
    expect(result.files.map((file) => file.name)).toEqual(["shot.png"]);
  });

  it("flags non-file drag data such as a dragged link", () => {
    const result = partitionDroppedDataTransfer({
      items: [{ kind: "string", type: "text/uri-list" }],
      files: [],
    });
    expect(result.hadNonFileData).toBe(true);
    expect(result.files).toEqual([]);
  });

  it("keeps every file when items and files do not line up", () => {
    // Browsers that expose no entry API must not lose a real file to the
    // folder filter; an actual folder still fails the zero-byte check later.
    const result = partitionDroppedDataTransfer({
      items: [fileItem(true, "src")],
      files: [image as unknown as File, image as unknown as File],
    });
    expect(result.files).toHaveLength(2);
  });
});
