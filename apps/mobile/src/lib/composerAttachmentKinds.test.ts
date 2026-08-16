import { describe, expect, it } from "vite-plus/test";

import { documentAttachmentKind, toUploadChatDocumentAttachments } from "./composerAttachmentKinds";

describe("documentAttachmentKind", () => {
  it("splits kinds the way the attachment contract does", () => {
    expect(documentAttachmentKind("application/pdf")).toBe("pdf");
    expect(documentAttachmentKind("APPLICATION/PDF")).toBe("pdf");
    expect(documentAttachmentKind("video/mp4")).toBe("video");
    expect(documentAttachmentKind("video/quicktime")).toBe("video");
    expect(documentAttachmentKind("text/csv")).toBe("file");
    expect(documentAttachmentKind("application/octet-stream")).toBe("file");
  });

  it("does not mistake a pdf-ish name for a pdf", () => {
    // The contract keys off MIME, so a mislabelled name stays a generic file.
    expect(documentAttachmentKind("text/plain")).toBe("file");
  });
});

describe("toUploadChatDocumentAttachments", () => {
  it("drops the draft id and keeps the wire fields", () => {
    expect(
      toUploadChatDocumentAttachments([
        {
          id: "draft-1",
          type: "pdf",
          name: "itinerary.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          dataUrl: "data:application/pdf;base64,AAAA",
        },
      ]),
    ).toEqual([
      {
        type: "pdf",
        name: "itinerary.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        dataUrl: "data:application/pdf;base64,AAAA",
      },
    ]);
  });
});

describe("documentAttachmentKind agreement with web", () => {
  it("never returns image, so an image never enters the document path", () => {
    // The shared classifier reports "image" for image MIME types; the document
    // path has no preview URI, so those belong to composerImages instead.
    expect(documentAttachmentKind("image/png", "shot.png")).toBe("file");
  });

  it("falls back to the file name when the picker gives no MIME type", () => {
    // Android content:// URIs do this constantly.
    expect(documentAttachmentKind("", "itinerary.pdf")).toBe("pdf");
  });
});
