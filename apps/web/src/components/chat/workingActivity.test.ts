import { describe, expect, it } from "vite-plus/test";
import { resolveWorkingActivityText } from "./workingActivity";

describe("native working activity", () => {
  it("uses the reported live status without inventing reasoning", () => {
    expect(resolveWorkingActivityText("  Formulating response…  ", true)).toBe(
      "Formulating response…",
    );
    expect(resolveWorkingActivityText("Thinking…", true)).toBe("Thinking…");
  });
  it("does not retain the previous turn's activity when work has ended", () => {
    expect(resolveWorkingActivityText("Thinking…", false)).toBeNull();
  });
  it("falls back to the normal indicator when native activity clears", () => {
    expect(resolveWorkingActivityText(null, true)).toBeNull();
    expect(resolveWorkingActivityText(undefined, true)).toBeNull();
    expect(resolveWorkingActivityText("  ", true)).toBeNull();
  });
});
