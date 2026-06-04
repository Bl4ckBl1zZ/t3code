import { describe, expect, it } from "vitest";

import { shouldOpenPreviewInNewTab } from "./PreviewButton.logic";

describe("shouldOpenPreviewInNewTab", () => {
  it("opens paired client previews directly in a new tab", () => {
    expect(shouldOpenPreviewInNewTab({ currentSessionRole: "client" })).toBe(true);
  });

  it("keeps owner and unknown sessions on the browser-agent flow", () => {
    expect(shouldOpenPreviewInNewTab({ currentSessionRole: "owner" })).toBe(false);
    expect(shouldOpenPreviewInNewTab({ currentSessionRole: null })).toBe(false);
  });
});
