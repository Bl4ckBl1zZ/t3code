import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveUsageShortcut } from "./usageShortcuts";

class TestElement extends EventTarget {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
    private readonly insidePopup = false,
  ) {
    super();
  }

  closest() {
    return this.insidePopup ? this : null;
  }
}

afterEach(() => vi.unstubAllGlobals());

function keyT(target: TestElement) {
  return {
    key: "t",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
  };
}

describe("Usage shortcuts while typing", () => {
  it.each([
    new TestElement("INPUT"),
    new TestElement("TEXTAREA"),
    new TestElement("DIV", true),
    new TestElement("BUTTON", false, true),
  ])("leaves letters to the focused $tagName control", (target) => {
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("navigator", { platform: "Linux" });

    expect(resolveUsageShortcut(keyT(target), DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
    expect(resolveUsageShortcut(keyT(new TestElement("BODY")), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "usage.tokens",
    );
  });
});
