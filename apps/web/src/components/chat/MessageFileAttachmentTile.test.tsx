import type { ChatAttachment } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MessageFileAttachmentTile } from "./MessageFileAttachmentTile";

const CRASH_REPORT: ChatAttachment = {
  type: "file",
  id: "thread-abc-9f2c1a4b-1111-2222-3333-444455556666",
  name: "T3Code-2026-08-04-175343.ips",
  mimeType: "application/octet-stream",
  sizeBytes: 50356,
};

const render = (attachment: ChatAttachment & { readonly previewUrl?: string }) =>
  renderToStaticMarkup(<MessageFileAttachmentTile attachment={attachment} />);

describe("MessageFileAttachmentTile", () => {
  it("labels the file with its kind and size, not just its name", () => {
    const markup = render(CRASH_REPORT);
    expect(markup).toContain("T3Code-2026-08-04-175343.ips");
    // The regression: eight of these rendered as eight bare filenames.
    expect(markup).toContain("IPS");
    expect(markup).toContain("IPS · 49 KB");
  });

  it("renders an icon", () => {
    // Either the Pierre sprite glyph or the lucide fallback — never nothing.
    expect(render(CRASH_REPORT)).toContain("<svg");
  });

  it("keeps the untruncated name reachable when the visible one is shortened", () => {
    const markup = render({ ...CRASH_REPORT, name: "a-really-long-crash-report-name-here.ips" });
    expect(markup).toContain('title="a-really-long-crash-report-name-here.ips"');
    expect(markup).toContain("…");
  });

  it("links to the file when a preview URL is available", () => {
    const markup = render({ ...CRASH_REPORT, previewUrl: "https://example.test/blob" });
    expect(markup).toContain('href="https://example.test/blob"');
    expect(markup).toContain("Open T3Code-2026-08-04-175343.ips");
  });

  it("stays inert, rather than a dead link, when the bytes are gone", () => {
    expect(render(CRASH_REPORT)).not.toContain("<a");
  });

  it("names a PDF by kind rather than by extension", () => {
    const markup = render({
      ...CRASH_REPORT,
      type: "pdf",
      name: "spec.pdf",
      mimeType: "application/pdf",
    });
    expect(markup).toContain("PDF");
  });
});
