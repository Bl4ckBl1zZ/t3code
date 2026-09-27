import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";

const resolve = (width: number, height: number) =>
  resolveThreadDetailsCardLayout({
    container: { width, height },
    chat: { left: (width - 736) / 2, width: 736 },
  });

describe("floating details card", () => {
  it("uses the right margin without reserving chat space", () => {
    expect(resolve(1600, 900)).toEqual({ x: 1276, y: 12, width: 312, height: 876 });
    expect(resolve(1344, 900)?.width).toBe(280);
  });

  it("becomes a popover when the margin cannot hold readable controls", () => {
    expect(resolve(1200, 900)).toBeNull();
  });

  it("becomes a popover when the canvas is too short for readable controls", () => {
    expect(resolve(1600, 184)).toMatchObject({ height: 160 });
    expect(resolve(1600, 183)).toBeNull();
  });
});

describe("card content fitting", () => {
  it("folds only detail that cannot fit and restores it when space returns", () => {
    const content = { full: 570, compact: 180 };
    expect(resolveThreadDetailsCardDensity(600, content)).toBe("full");
    expect(resolveThreadDetailsCardDensity(400, content)).toBe("compact");
    expect(resolveThreadDetailsCardDensity(170, content)).toBe("essential");
    expect(resolveThreadDetailsCardDensity(570, content)).toBe("full");
  });

  it("measures unseen content before deciding to fold it", () => {
    expect(resolveThreadDetailsCardDensity(300, { full: 0, compact: 0 })).toBe("full");
    expect(resolveThreadDetailsCardDensity(300, { full: 570, compact: 0 })).toBe("compact");
  });
});
