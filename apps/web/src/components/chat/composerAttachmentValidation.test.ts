import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerFileDescriptor,
  partitionComposerAttachments,
  validateComposerAttachment,
} from "./composerAttachmentValidation";

describe("composerFileDescriptor", () => {
  it("maps a browser File onto the platform-neutral descriptor", () => {
    expect(composerFileDescriptor({ name: "shot.png", size: 12, type: "image/png" })).toEqual({
      name: "shot.png",
      sizeBytes: 12,
      mimeType: "image/png",
    });
  });
});

describe("validateComposerAttachment", () => {
  it("accepts images", () => {
    expect(
      validateComposerAttachment({ name: "shot.png", size: 12, type: "image/png" }),
    ).toMatchObject({ accepted: true, type: "image" });
  });

  // The provider used to decide this, which is exactly how web and mobile drifted.
  it("accepts every file type now that uploads are read from the workspace", () => {
    for (const file of [
      { name: "spec.pdf", size: 12, type: "application/pdf" },
      { name: "data.csv", size: 12, type: "text/csv" },
      { name: "bundle.zip", size: 12, type: "application/zip" },
      { name: "voice.m4a", size: 12, type: "audio/mp4" },
      { name: "clip.mp4", size: 12, type: "video/mp4" },
      { name: "Makefile", size: 12, type: "" },
    ]) {
      expect(validateComposerAttachment(file).accepted).toBe(true);
    }
  });

  it("rejects an empty file, which also catches a dropped folder on Safari", () => {
    expect(validateComposerAttachment({ name: "folder", size: 0, type: "" })).toMatchObject({
      accepted: false,
    });
  });

  it("enforces the per-kind byte cap", () => {
    expect(
      validateComposerAttachment({
        name: "huge.png",
        size: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
        type: "image/png",
      }).accepted,
    ).toBe(false);
    expect(
      validateComposerAttachment({
        name: "huge.zip",
        size: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
        type: "application/zip",
      }).accepted,
    ).toBe(false);
  });
});

describe("HEIC photos", () => {
  // Web converts HEIC/HEIF to JPEG on the way into the composer, so the shared
  // rules see the JPEG it becomes rather than the bytes the picker handed over.
  it.each([
    { name: "IMG_0001.heic", type: "image/heic" },
    { name: "IMG_0002.HEIF", type: "" },
    { name: "IMG_0003.heic", type: "application/octet-stream" },
  ])("validates $name as the JPEG it is converted to", (file) => {
    expect(composerFileDescriptor({ ...file, size: 2_000_000 }).mimeType).toBe("image/jpeg");
    expect(validateComposerAttachment({ ...file, size: 2_000_000 })).toMatchObject({
      accepted: true,
      type: "image",
      mimeType: "image/jpeg",
    });
  });

  it("still rejects image types no provider can read", () => {
    expect(
      validateComposerAttachment({ name: "logo.svg", size: 12, type: "image/svg+xml" }),
    ).toMatchObject({ accepted: false });
  });
});

describe("partitionComposerAttachments", () => {
  it("reports every rejection instead of stopping at the first", () => {
    const result = partitionComposerAttachments(
      [
        { name: "ok.png", size: 12, type: "image/png" },
        { name: "empty.txt", size: 0, type: "text/plain" },
        { name: "also-ok.pdf", size: 12, type: "application/pdf" },
      ],
      0,
    );
    expect(result.accepted.map((entry) => entry.name)).toEqual(["ok.png", "also-ok.pdf"]);
    expect(result.errors).toHaveLength(1);
  });

  it("counts already-used slots against the per-message limit", () => {
    const result = partitionComposerAttachments(
      [{ name: "ok.png", size: 12, type: "image/png" }],
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.errors[0]).toContain(`up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files`);
  });
});
