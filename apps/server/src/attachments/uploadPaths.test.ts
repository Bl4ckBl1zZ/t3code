import type { ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendUploadedFilesBlock,
  attachmentUploadSegment,
  sanitizeUploadFileName,
  threadUploadSegment,
  uploadRelativePath,
  uploadedFilesPromptBlock,
  UPLOADS_GITIGNORE_CONTENTS,
} from "./uploadPaths.ts";

const THREAD_ID = "thread:project-abc:01J8Z9QK3M4N5P6R7S8T9V0W1X";

function attachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    type: "file",
    id: "thread-abc-9f2c1a4b-1111-2222-3333-444455556666",
    name: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    ...overrides,
  } as ChatAttachment;
}

describe("threadUploadSegment", () => {
  it("is stable, fixed-width, and path-safe for a realistic thread id", () => {
    const segment = threadUploadSegment(THREAD_ID);
    expect(segment).toBe(threadUploadSegment(THREAD_ID));
    expect(segment).toMatch(/^[0-9a-f]{8}$/);
  });

  it("separates distinct threads", () => {
    expect(threadUploadSegment("thread:a")).not.toBe(threadUploadSegment("thread:b"));
  });
});

describe("attachmentUploadSegment", () => {
  it("reuses the uuid half of a deterministic attachment id", () => {
    expect(attachmentUploadSegment("mythread-9f2c1a4b-1111-2222-3333-444455556666")).toBe(
      "9f2c1a4b",
    );
  });

  it("falls back to a hash for ids imported from v1 threads", () => {
    const segment = attachmentUploadSegment("legacy_attachment_42");
    expect(segment).toMatch(/^[0-9a-f]{8}$/);
    expect(segment).toBe(attachmentUploadSegment("legacy_attachment_42"));
  });
});

describe("sanitizeUploadFileName", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["spaces become dashes", "Quarterly Report.pdf", "Quarterly-Report.pdf"],
    ["windows-illegal characters", 'a<b>c:d"e|f?g*h.txt', "a-b-c-d-e-f-g-h.txt"],
    ["path separators", "some/nested\\name.txt", "some-nested-name.txt"],
    ["collapses dash runs", "a   ---   b.txt", "a-b.txt"],
    ["trims trailing dots", "report...", "report"],
    ["keeps a leading dot", ".env", ".env"],
    ["keeps case", "ReadMe.MD", "ReadMe.MD"],
    ["extensionless names pass through", "Makefile", "Makefile"],
    ["windows reserved names are harmless behind the hash prefix", "CON.txt", "CON.txt"],
  ];

  for (const [label, input, expected] of cases) {
    it(label, () => {
      expect(sanitizeUploadFileName({ name: input, mimeType: "text/plain", type: "file" })).toBe(
        expected,
      );
    });
  }

  it("never yields a traversal segment", () => {
    for (const name of ["..", ".", "../../etc/passwd"]) {
      const sanitized = sanitizeUploadFileName({ name, mimeType: "text/plain", type: "file" });
      expect(sanitized).not.toBe("..");
      expect(sanitized).not.toBe(".");
      expect(sanitized).not.toContain("/");
    }
  });

  it("falls back to a typed name when nothing survives sanitization", () => {
    expect(sanitizeUploadFileName({ name: "???", mimeType: "image/png", type: "image" })).toBe(
      "file.png",
    );
    expect(sanitizeUploadFileName({ name: "   ", mimeType: "application/pdf", type: "pdf" })).toBe(
      "file.pdf",
    );
  });

  it("keeps emoji intact and stays under the filesystem name limit", () => {
    const sanitized = sanitizeUploadFileName({
      name: `${"🎉デザイン".repeat(40)}.png`,
      mimeType: "image/png",
      type: "image",
    });
    expect(sanitized.endsWith(".png")).toBe(true);
    expect(new TextEncoder().encode(sanitized).length).toBeLessThanOrEqual(180);
    // Truncation must not split a surrogate pair into a replacement character.
    expect(sanitized).not.toContain("�");
  });

  it("truncates a 300-character name while preserving the extension", () => {
    const sanitized = sanitizeUploadFileName({
      name: `${"a".repeat(300)}.tar.gz`,
      mimeType: "application/gzip",
      type: "file",
    });
    expect(sanitized.endsWith(".gz")).toBe(true);
    expect(new TextEncoder().encode(sanitized).length).toBeLessThanOrEqual(180);
  });

  it("strips bidi controls used for extension spoofing", () => {
    const sanitized = sanitizeUploadFileName({
      name: "report.pdf‮gpj.exe",
      mimeType: "application/pdf",
      type: "pdf",
    });
    expect(sanitized).toBe("report.pdfgpj.exe");
    expect(sanitized).not.toContain("‮");
  });
});

describe("uploadRelativePath", () => {
  it("is deterministic and rooted under .t3code/uploads", () => {
    const path = uploadRelativePath({ threadId: THREAD_ID, attachment: attachment() });
    expect(path).toBe(uploadRelativePath({ threadId: THREAD_ID, attachment: attachment() }));
    expect(path.startsWith(".t3code/uploads/")).toBe(true);
    expect(path.endsWith("-spec.pdf")).toBe(true);
  });

  it("separates two identically named attachments in the same message", () => {
    const first = uploadRelativePath({
      threadId: THREAD_ID,
      attachment: attachment({ id: "t-aaaaaaaa-1111-2222-3333-444455556666" }),
    });
    const second = uploadRelativePath({
      threadId: THREAD_ID,
      attachment: attachment({ id: "t-bbbbbbbb-1111-2222-3333-444455556666" }),
    });
    expect(first).not.toBe(second);
  });

  it("separates names that differ only in case, for case-insensitive filesystems", () => {
    const lower = uploadRelativePath({
      threadId: THREAD_ID,
      attachment: attachment({ id: "t-aaaaaaaa-1111-2222-3333-444455556666", name: "foo.png" }),
    });
    const upper = uploadRelativePath({
      threadId: THREAD_ID,
      attachment: attachment({ id: "t-bbbbbbbb-1111-2222-3333-444455556666", name: "FOO.png" }),
    });
    expect(lower.toLowerCase()).not.toBe(upper.toLowerCase());
  });
});

describe("UPLOADS_GITIGNORE_CONTENTS", () => {
  it("contains a bare '*' line so the ignore file hides itself too", () => {
    expect(UPLOADS_GITIGNORE_CONTENTS.split("\n")).toContain("*");
  });
});

describe("uploadedFilesPromptBlock", () => {
  const entry = {
    relativePath: ".t3code/uploads/a3f19c2b/9f2c1a4b-spec.pdf",
    name: "Quarterly Report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_200_000,
    alsoInline: false,
  };

  it("returns null when nothing was materialized", () => {
    expect(uploadedFilesPromptBlock([])).toBeNull();
  });

  it("wraps entries in the t3_uploaded_files tag with path, name, mime, and size", () => {
    const block = uploadedFilesPromptBlock([entry]);
    expect(block).not.toBeNull();
    expect(block).toContain("<t3_uploaded_files>");
    expect(block).toContain("</t3_uploaded_files>");
    expect(block).toContain(".t3code/uploads/a3f19c2b/9f2c1a4b-spec.pdf");
    expect(block).toContain('"Quarterly Report.pdf"');
    expect(block).toContain("application/pdf");
    expect(block).toContain("2.1 MB");
    expect(block).toContain("uploaded 1 file with this message");
  });

  it("pluralizes for multiple files", () => {
    const block = uploadedFilesPromptBlock([entry, { ...entry, alsoInline: false }]);
    expect(block).toContain("uploaded 2 files with this message");
  });

  it("annotates only the entries that are also delivered inline", () => {
    const block = uploadedFilesPromptBlock([
      entry,
      { ...entry, name: "shot.png", mimeType: "image/png", alsoInline: true },
    ]);
    expect(block?.match(/also attached to this message as an image/g)).toHaveLength(1);
  });
});

describe("appendUploadedFilesBlock", () => {
  it("passes the text through when there is no block", () => {
    expect(appendUploadedFilesBlock("hello", null)).toBe("hello");
  });

  it("returns the block alone for an attachment-only message", () => {
    expect(appendUploadedFilesBlock("   ", "BLOCK")).toBe("BLOCK");
  });

  it("separates existing text from the block with a blank line", () => {
    expect(appendUploadedFilesBlock("hello", "BLOCK")).toBe("hello\n\nBLOCK");
  });
});
