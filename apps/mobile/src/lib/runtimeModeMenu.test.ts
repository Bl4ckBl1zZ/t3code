import { describe, expect, it } from "vite-plus/test";

import { runtimeModeMenu } from "./runtimeModeMenu";

describe("runtimeModeMenu", () => {
  it("keeps the four generic modes for a code provider", () => {
    const menu = runtimeModeMenu({ isHermes: false, runtimeMode: "approval-required" });
    expect(menu.options.map((option) => option.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(menu.selected.title).toBe("Approve actions");
  });

  it("offers a T3 Work thread the two modes Hermes distinguishes", () => {
    const menu = runtimeModeMenu({ isHermes: true, runtimeMode: "full-access" });
    expect(menu.options.map((option) => option.title)).toEqual([
      "Approve risky commands",
      "Full access",
    ]);
    expect(menu.selected.mode).toBe("full-access");
  });

  it("shows a carried-in mode Hermes does not offer as the approval option", () => {
    const menu = runtimeModeMenu({ isHermes: true, runtimeMode: "auto-accept-edits" });
    expect(menu.selected.mode).toBe("approval-required");
    expect(menu.options).toContain(menu.selected);
  });

  // The composer's settings pill summarizes the thread in one line, so every
  // offered mode needs a short form — including the Hermes pair, which the
  // thread settings sheet reads through this menu rather than its own list.
  it("gives every offered mode a short label for the summary pill", () => {
    const code = runtimeModeMenu({ isHermes: false, runtimeMode: "auto" });
    expect(code.options.map((option) => option.shortLabel)).toEqual([
      "Approve",
      "Edits",
      "Auto",
      "Full",
    ]);
    expect(code.selected.shortLabel).toBe("Auto");

    const hermes = runtimeModeMenu({ isHermes: true, runtimeMode: "full-access" });
    expect(hermes.options.map((option) => option.shortLabel)).toEqual(["Approve", "Full"]);
    expect(hermes.selected.shortLabel).toBe("Full");
  });
});
