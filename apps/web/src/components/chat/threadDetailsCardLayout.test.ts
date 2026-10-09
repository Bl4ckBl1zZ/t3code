import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";

const lane = { padding: 48, minChatWidth: 640 };
const resolve = (width: number, height: number) =>
  resolveThreadDetailsCardLayout({ container: { width, height }, lane });

describe("workspace card", () => {
  it("pins to the top right at a fixed width", () => {
    expect(resolve(1600, 900)).toEqual({ x: 1308, y: 12, width: 280, height: 876 });
    expect(resolve(1344, 900)).toMatchObject({ x: 1052, width: 280 });
  });

  it("starts below the open find bar, keeping the bottom inset", () => {
    expect(
      resolveThreadDetailsCardLayout({
        container: { width: 1600, height: 900 },
        lane,
        topInset: 48,
      }),
    ).toEqual({ x: 1308, y: 60, width: 280, height: 828 });
  });

  it("becomes a popover when a readable chat lane cannot fit beside it", () => {
    expect(resolve(1012, 900)).toMatchObject({ x: 720 });
    expect(resolve(1011, 900)).toBeNull();
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
