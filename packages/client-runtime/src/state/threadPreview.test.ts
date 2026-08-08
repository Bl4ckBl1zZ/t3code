import { describe, expect, it } from "vite-plus/test";

import { resolveThreadPreview } from "./models.ts";

describe("resolveThreadPreview", () => {
  it("flattens a multi-line message onto one row line", () => {
    expect(
      resolveThreadPreview({
        latestVisibleMessage: { role: "assistant", text: "  Alfama is\n\nwalkable\tfrom Baixa  " },
      }),
    ).toEqual({ text: "Alfama is walkable from Baixa", fromUser: false });
  });

  it("marks the user's own turn so a row can prefix it", () => {
    expect(
      resolveThreadPreview({ latestVisibleMessage: { role: "user", text: "how steep?" } }),
    ).toEqual({ text: "how steep?", fromUser: true });
  });

  it("caps a long message rather than letting it set the row width", () => {
    const preview = resolveThreadPreview({
      latestVisibleMessage: { role: "assistant", text: "x".repeat(400) },
    });
    expect(preview?.text).toHaveLength(160);
    expect(preview?.text.endsWith("...")).toBe(true);
  });

  it("reports nothing for an absent or whitespace-only message", () => {
    expect(resolveThreadPreview({ latestVisibleMessage: null })).toBeNull();
    expect(
      resolveThreadPreview({ latestVisibleMessage: { role: "assistant", text: "   \n  " } }),
    ).toBeNull();
  });
});
