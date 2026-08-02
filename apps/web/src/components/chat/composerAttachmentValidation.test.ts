import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerAttachmentAccept,
  partitionComposerAttachments,
  validateComposerAttachment,
} from "./composerAttachmentValidation";

const HERMES = ProviderDriverKind.make("hermes");

describe("validateComposerAttachment", () => {
  it("limits the native picker to images for providers with an image-only transport", () => {
    expect(composerAttachmentAccept(ProviderDriverKind.make("codex"))).toBe("image/*");
    expect(composerAttachmentAccept(ProviderDriverKind.make("hermes"))).toBeUndefined();
  });

  it("preserves images for every provider", () => {
    expect(
      validateComposerAttachment(
        { name: "shot.png", size: 12, type: "image/png" },
        ProviderDriverKind.make("codex"),
      ),
    ).toMatchObject({ accepted: true, type: "image" });
  });

  it.each([
    ["report.pdf", "application/pdf", "pdf"],
    ["clip.webm", "video/webm", "video"],
    ["notes.txt", "text/plain", "file"],
  ] as const)("accepts Hermes %s", (name, mimeType, type) => {
    expect(
      validateComposerAttachment(
        { name, size: 12, type: mimeType },
        ProviderDriverKind.make("hermes"),
      ),
    ).toMatchObject({ accepted: true, type });
  });

  it.each([
    ["report.pdf", "pdf"],
    ["clip.webm", "video"],
    ["notes.txt", "file"],
  ] as const)("infers a safe MIME type for Hermes %s when the browser omits it", (name, type) => {
    expect(
      validateComposerAttachment({ name, size: 12, type: "" }, ProviderDriverKind.make("hermes")),
    ).toMatchObject({ accepted: true, type });
  });

  it("rejects non-image files for providers without a transport", () => {
    expect(
      validateComposerAttachment(
        { name: "notes.txt", size: 12, type: "text/plain" },
        ProviderDriverKind.make("codex"),
      ),
    ).toMatchObject({ accepted: false, message: expect.stringContaining("only in Hermes") });
  });

  it.each([
    ["image", "shot.png", "image/png", PROVIDER_SEND_TURN_MAX_IMAGE_BYTES],
    ["file", "archive.zip", "application/zip", PROVIDER_SEND_TURN_MAX_FILE_BYTES],
  ] as const)("enforces the exact %s byte limit", (_kind, name, type, maxBytes) => {
    const provider = ProviderDriverKind.make("hermes");
    expect(validateComposerAttachment({ name, size: maxBytes, type }, provider)).toMatchObject({
      accepted: true,
    });
    expect(validateComposerAttachment({ name, size: maxBytes + 1, type }, provider)).toMatchObject({
      accepted: false,
      message: expect.stringContaining(`${maxBytes / (1024 * 1024)}MB`),
    });
  });

  it.each([
    ["voice.mp3", "audio/mpeg", "sound input path"],
    ["../secret.txt", "text/plain", "safe, plain file names"],
    ["unknown", "", "trustworthy MIME type"],
  ] as const)("rejects unsafe or unsupported %s honestly", (name, type, message) => {
    expect(
      validateComposerAttachment({ name, size: 12, type }, ProviderDriverKind.make("hermes")),
    ).toMatchObject({
      accepted: false,
      message: expect.stringContaining(message),
    });
  });

  it.each([".", ".."] as const)("rejects the traversal segment '%s'", (name) => {
    expect(
      validateComposerAttachment({ name, size: 12, type: "text/plain" }, HERMES),
    ).toMatchObject({
      accepted: false,
      message: expect.stringContaining("safe, plain file names"),
    });
  });

  it("keeps ordinary dotted names", () => {
    expect(
      validateComposerAttachment({ name: ".env.local", size: 12, type: "text/plain" }, HERMES),
    ).toMatchObject({ accepted: true, type: "file" });
  });
});

describe("partitionComposerAttachments", () => {
  it("collects every rejection reason instead of stopping at the first", () => {
    const result = partitionComposerAttachments(
      [
        { name: "voice.mp3", size: 12, type: "audio/mpeg" },
        { name: "../secret.txt", size: 12, type: "text/plain" },
        { name: "shot.png", size: 12, type: "image/png" },
      ],
      HERMES,
      0,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("sound input path");
    expect(result.errors[1]).toContain("safe, plain file names");
  });

  it("reports every file skipped for capacity in one message", () => {
    const result = partitionComposerAttachments(
      [
        { name: "a.png", size: 12, type: "image/png" },
        { name: "b.png", size: 12, type: "image/png" },
        { name: "voice.mp3", size: 12, type: "audio/mpeg" },
      ],
      HERMES,
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("sound input path");
    expect(result.errors[1]).toContain("'a.png', 'b.png'");
  });

  it("fills only the remaining slots", () => {
    const files = Array.from({ length: 3 }, (_unused, position) => ({
      name: `shot-${position}.png`,
      size: 12,
      type: "image/png",
    }));
    const result = partitionComposerAttachments(
      files,
      HERMES,
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 2,
    );
    expect(result.accepted.map((entry) => entry.file.name)).toEqual(["shot-0.png", "shot-1.png"]);
    expect(result.errors).toEqual([expect.stringContaining("'shot-2.png'")]);
  });
});
