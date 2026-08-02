import { describe, expect, it } from "vite-plus/test";

import {
  documentAttachmentKind,
  formatAttachmentSizeLimitError,
  toUploadChatDocumentAttachments,
} from "./composerAttachmentKinds";

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

describe("formatAttachmentSizeLimitError", () => {
  it("names the file that was rejected", () => {
    expect(formatAttachmentSizeLimitError("demo.mp4")).toBe(
      "'demo.mp4' exceeds the 20 MB attachment limit.",
    );
  });
});
