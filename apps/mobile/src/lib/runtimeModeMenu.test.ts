import { describe, expect, it } from "vite-plus/test";

import { runtimeModeMenu } from "./runtimeModeMenu";

describe("runtimeModeMenu", () => {
  it("keeps the four generic modes for a code provider", () => {
    const menu = runtimeModeMenu({ runtimeMode: "approval-required" });
    expect(menu.options.map((option) => option.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(menu.selected.title).toBe("Approve actions");
  });

  it("offers only the modes a provider supports, reading an unsupported one as the first", () => {
    const supportedRuntimeModes = ["approval-required", "auto", "full-access"] as const;
    const menu = runtimeModeMenu({
      runtimeMode: "auto-accept-edits",
      supportedRuntimeModes,
    });
    expect(menu.options.map((option) => option.mode)).toEqual(supportedRuntimeModes);
    expect(menu.selected.mode).toBe("approval-required");
  });

  // The composer's settings pill summarizes the thread in one line, so every
  // offered mode needs a short form.
  it("gives every offered mode a short label for the summary pill", () => {
    const code = runtimeModeMenu({ runtimeMode: "auto" });
    expect(code.options.map((option) => option.shortLabel)).toEqual([
      "Approve",
      "Edits",
      "Auto",
      "Full",
    ]);
    expect(code.selected.shortLabel).toBe("Auto");
  });
});
