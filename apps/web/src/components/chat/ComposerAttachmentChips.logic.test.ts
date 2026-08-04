import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentKindLabel,
  duplicateAttachmentNames,
  isAttachmentLimitReached,
  resolveFocusAfterRemoval,
  shouldShowAttachmentSlotCounter,
} from "./ComposerAttachmentChips.logic";

describe("resolveFocusAfterRemoval", () => {
  it("moves focus to the chip that takes the removed one's place", () => {
    expect(resolveFocusAfterRemoval(["a", "b", "c"], "b")).toBe("c");
  });

  it("falls back to the new last chip when the last one is removed", () => {
    expect(resolveFocusAfterRemoval(["a", "b", "c"], "c")).toBe("b");
  });

  it("returns null when the row empties, so focus goes back to the editor", () => {
    expect(resolveFocusAfterRemoval(["a"], "a")).toBeNull();
  });

  it("returns null for an id that is not in the row", () => {
    expect(resolveFocusAfterRemoval(["a", "b"], "z")).toBeNull();
  });
});

describe("shouldShowAttachmentSlotCounter", () => {
  it("stays quiet until the limit is close", () => {
    expect(shouldShowAttachmentSlotCounter(1)).toBe(false);
    expect(shouldShowAttachmentSlotCounter(PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 2)).toBe(true);
    expect(shouldShowAttachmentSlotCounter(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)).toBe(true);
  });
});

describe("isAttachmentLimitReached", () => {
  it("matches the contract's per-message cap", () => {
    expect(isAttachmentLimitReached(PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1)).toBe(false);
    expect(isAttachmentLimitReached(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)).toBe(true);
  });
});

describe("duplicateAttachmentNames", () => {
  it("flags repeats case-insensitively", () => {
    const duplicates = duplicateAttachmentNames([
      { name: "spec.pdf" },
      { name: "Spec.PDF" },
      { name: "other.pdf" },
    ]);
    expect(duplicates.has("spec.pdf")).toBe(true);
    expect(duplicates.has("other.pdf")).toBe(false);
  });
});

describe("attachmentKindLabel", () => {
  const cases: ReadonlyArray<readonly [string, Parameters<typeof attachmentKindLabel>[0], string]> =
    [
      ["pdf", { type: "pdf", mimeType: "application/pdf", name: "a.pdf" }, "PDF"],
      ["image", { type: "image", mimeType: "image/png", name: "a.png" }, "Image"],
      ["video", { type: "video", mimeType: "video/mp4", name: "a.mp4" }, "Video"],
      ["audio", { type: "file", mimeType: "audio/mpeg", name: "a.mp3" }, "Audio"],
      ["extension", { type: "file", mimeType: "application/zip", name: "a.zip" }, "ZIP"],
      ["no extension", { type: "file", mimeType: "text/plain", name: "Makefile" }, "File"],
    ];
  for (const [label, input, expected] of cases) {
    it(`labels ${label}`, () => {
      expect(attachmentKindLabel(input)).toBe(expected);
    });
  }
});
