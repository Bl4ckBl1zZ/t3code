import { describe, expect, it } from "vite-plus/test";

import { resolveChatCanvasLayout } from "./chatCanvasLayout";

describe("chat canvas layout", () => {
  it("centers chat in the whole container", () => {
    expect(resolveChatCanvasLayout({ container: { width: 1344, height: 900 } }).chat).toEqual({
      left: 288,
      width: 768,
    });
  });

  it("keeps the padding on narrow containers instead of overflowing", () => {
    expect(resolveChatCanvasLayout({ container: { width: 390, height: 900 } }).chat).toEqual({
      left: 20,
      width: 350,
    });
    expect(resolveChatCanvasLayout({ container: { width: 0, height: 0 } }).chat.width).toBe(0);
  });
});
