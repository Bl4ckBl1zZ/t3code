import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildAntigravityPrompt } from "./AntigravityAcpSupport.ts";

const NATIVE_BUDGET_BYTES = 50 * 1024 * 1024;

const imageAttachment = {
  type: "image",
  id: "thread-00000000-0000-4000-8000-000000000001",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1,
} satisfies ChatAttachment;

const fileAttachment = {
  type: "file",
  id: "thread-00000000-0000-4000-8000-000000000002",
  name: "example.tsx",
  mimeType: "application/octet-stream",
  sizeBytes: 1,
} satisfies ChatAttachment;

const pdfAttachment = {
  type: "pdf",
  id: "thread-00000000-0000-4000-8000-000000000003",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1,
} satisfies ChatAttachment;

const makeAttachmentFixture = Effect.fn("AntigravityAcpSupportTest.makeAttachmentFixture")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachmentsDir = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-antigravity-attachments-",
    });
    /** Writes the upload where the attachment store keeps it, sized on disk. */
    const write = Effect.fn("AntigravityAcpSupportTest.writeAttachment")(function* (
      attachment: ChatAttachment,
      size: number,
    ) {
      const filePath = resolveAttachmentPath({ attachmentsDir, attachment });
      if (filePath === null) throw new Error("Invalid test attachment path.");
      yield* fs.writeFileString(filePath, "");
      yield* fs.truncate(filePath, size);
      return { filePath, uri: (yield* path.toFileUrl(filePath)).href };
    });
    return { fs, attachmentsDir, write };
  },
);

const pathLine = (attachment: ChatAttachment, filePath: string) =>
  `[Attached ${attachment.type} "${attachment.name}" is saved at: ${filePath}]`;

it.layer(NodeServices.layer)("buildAntigravityPrompt", (it) => {
  it.effect.each([
    { ...fileAttachment, name: "archive.zip", mimeType: "application/zip" },
    { ...fileAttachment, type: "video", name: "clip.mp4", mimeType: "video/mp4" },
    { ...fileAttachment, name: "recording.aiff", mimeType: "audio/aiff" },
    { ...pdfAttachment, id: `${pdfAttachment.id}-large`, name: "large.pdf", sizeBytes: 75e6 },
    { ...fileAttachment, name: "large.txt", mimeType: "text/plain", sizeBytes: 1024 * 1024 + 1 },
    { ...fileAttachment, name: "large.wav", mimeType: "audio/wav", sizeBytes: 20 * 1024 ** 2 + 1 },
  ] satisfies ReadonlyArray<ChatAttachment>)(
    "names $name by its saved path without reading it or spending the native budget",
    (attachment) =>
      Effect.gen(function* () {
        const fixture = yield* makeAttachmentFixture();
        const upload = yield* fixture.write(attachment, attachment.sizeBytes);
        const pdf = yield* fixture.write(pdfAttachment, NATIVE_BUDGET_BYTES);
        const prompt = yield* buildAntigravityPrompt({
          input: "  Inspect the attachments.  ",
          attachments: [attachment, pdfAttachment],
          attachmentsDir: fixture.attachmentsDir,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fixture.fs,
            stream: () => {
              throw new Error("Path attachments must not be read into the prompt");
            },
          }),
        );

        expect(prompt).toEqual([
          {
            type: "text",
            text: `Inspect the attachments.\n\n${pathLine(attachment, upload.filePath)}`,
          },
          { type: "resource_link", uri: pdf.uri, name: "report.pdf", mimeType: "application/pdf" },
        ]);
      }),
  );

  it.effect("names a PDF by path once the native budget is spent", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const second = { ...pdfAttachment, id: `${pdfAttachment.id}-second`, name: "second.pdf" };
      const first = yield* fixture.write(pdfAttachment, NATIVE_BUDGET_BYTES / 2);
      const secondUpload = yield* fixture.write(second, NATIVE_BUDGET_BYTES / 2);
      const input = {
        input: undefined,
        attachments: [pdfAttachment, second],
        attachmentsDir: fixture.attachmentsDir,
      };
      const firstLink = {
        type: "resource_link",
        uri: first.uri,
        name: "report.pdf",
        mimeType: "application/pdf",
      };

      expect(yield* buildAntigravityPrompt(input)).toEqual([
        firstLink,
        {
          type: "resource_link",
          uri: secondUpload.uri,
          name: "second.pdf",
          mimeType: "application/pdf",
        },
      ]);

      yield* fixture.fs.truncate(secondUpload.filePath, NATIVE_BUDGET_BYTES / 2 + 1);
      expect(yield* buildAntigravityPrompt(input)).toEqual([
        { type: "text", text: pathLine(second, secondUpload.filePath) },
        firstLink,
      ]);
    }),
  );

  it.effect("rejects an image format Antigravity cannot read", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      const gif = { ...imageAttachment, name: "animation.gif", mimeType: "image/gif" };
      yield* fixture.write(gif, 3);
      const error = yield* buildAntigravityPrompt({
        input: "Analyze every attachment.",
        attachments: [gif],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: expect.stringContaining("does not support 'animation.gif'"),
      });
    }),
  );

  it.effect("rejects an oversized image using its file size instead of upload metadata", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      yield* fixture.write(imageAttachment, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
      const error = yield* buildAntigravityPrompt({
        input: "Read this attachment.",
        attachments: [imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: expect.stringContaining("'screen.png' is too large"),
      });
    }),
  );

  it.effect("rejects an image once native attachments fill the budget", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAttachmentFixture();
      yield* fixture.write(pdfAttachment, NATIVE_BUDGET_BYTES);
      yield* fixture.write(imageAttachment, 1);
      const error = yield* buildAntigravityPrompt({
        input: "Inspect both attachments.",
        attachments: [pdfAttachment, imageAttachment],
        attachmentsDir: fixture.attachmentsDir,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        errorMessage: expect.stringContaining("'screen.png' is too large"),
      });
    }),
  );
});
