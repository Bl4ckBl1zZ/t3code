import type { ChatAttachment } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MessageAttachmentPlacement } from "./MessageAttachmentPlacement";

const base: ChatAttachment = {
  type: "pdf",
  id: "thread-abc-9f2c1a4b-1111-2222-3333-444455556666",
  name: "spec.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
};

const render = (attachment: ChatAttachment) =>
  renderToStaticMarkup(
    <MessageAttachmentPlacement
      attachment={attachment}
      onOpenWorkspaceFile={() => {}}
      onCopyPath={() => {}}
    />,
  );

describe("MessageAttachmentPlacement", () => {
  it("shows the workspace path once the file is written", () => {
    const markup = render({
      ...base,
      workspacePath: ".t3code/uploads/a3f19c2b/9f2c1a4b-spec.pdf",
      materialization: "written",
    });
    expect(markup).toContain(".t3code/uploads/a3f19c2b/9f2c1a4b-spec.pdf");
    expect(markup).toContain("Open .t3code/uploads/a3f19c2b/9f2c1a4b-spec.pdf");
    expect(markup).toContain("Copy path for spec.pdf");
  });

  // A conversation with no project is the expected case, not a problem. Showing
  // anything here would put a permanent warning in front of those users.
  it("renders nothing when the attachment was never materialized", () => {
    expect(render(base)).toBe("");
  });

  it("renders nothing for a skipped attachment", () => {
    expect(render({ ...base, materialization: "skipped" })).toBe("");
  });

  it("warns, without offering a path, when a real write failed", () => {
    const markup = render({ ...base, materialization: "failed" });
    expect(markup).toContain("Not saved to the workspace");
    expect(markup).not.toContain("Open .t3code");
  });

  it("surfaces the server's reason for a failure", () => {
    const markup = render({
      ...base,
      materialization: "failed",
      materializationReason: "The worktree is read-only.",
    });
    expect(markup).toContain("The worktree is read-only.");
  });
});
