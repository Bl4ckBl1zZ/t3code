import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isEditableFocused } from "./editableFocus";

// A minimal element: `closest` answers whether it is a text field, and an open
// shadow root reports its focused descendant like the DOM does.
class FakeElement {
  shadowRoot: { activeElement: FakeElement | null } | null = null;
  constructor(private readonly editable: boolean) {}
  closest() {
    return this.editable ? this : null;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isEditableFocused", () => {
  it("sees a text field focused inside an open shadow root", () => {
    vi.stubGlobal("Element", FakeElement);
    // A key event from a shadow input is retargeted to its host, so the host is
    // what page-level shortcut handlers receive as the event target.
    const host = new FakeElement(false);
    const input = new FakeElement(true);
    host.shadowRoot = { activeElement: null };
    vi.stubGlobal("document", { activeElement: host });

    expect(isEditableFocused(host as unknown as EventTarget)).toBe(false);
    host.shadowRoot.activeElement = input;
    expect(isEditableFocused(host as unknown as EventTarget)).toBe(true);
    expect(isEditableFocused()).toBe(true);
  });

  it("ignores targets that are not elements", () => {
    vi.stubGlobal("Element", FakeElement);
    expect(isEditableFocused(null)).toBe(false);
    expect(isEditableFocused({} as EventTarget)).toBe(false);
  });
});
