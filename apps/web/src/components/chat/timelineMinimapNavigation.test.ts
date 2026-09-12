import { describe, expect, it } from "vite-plus/test";
import { resolveTimelineMinimapCurrentIndex } from "./MessagesTimeline.logic";

describe("minimap turn navigation", () => {
  const itemBounds = [
    { top: 80, height: 20 },
    { top: 120, height: 20 },
    { top: 220, height: 20 },
  ];
  it("navigates relative to the first visible user turn", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({ scrollTop: 100, scrollBottom: 500, itemBounds }),
    ).toBe(1);
  });
  it("keeps the preceding turn current while reading its long response", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({ scrollTop: 150, scrollBottom: 200, itemBounds }),
    ).toBe(1);
  });
  it("does not invent a current turn before the first marker or for unmeasured rows", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({ scrollTop: 0, scrollBottom: 50, itemBounds }),
    ).toBeNull();
    expect(
      resolveTimelineMinimapCurrentIndex({
        scrollTop: 0,
        scrollBottom: 50,
        itemBounds: [{ top: null, height: null }],
      }),
    ).toBeNull();
  });
  it("uses a visible marker with an unknown height", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({
        scrollTop: 80,
        scrollBottom: 100,
        itemBounds: [{ top: 80, height: null }],
      }),
    ).toBe(0);
  });
});
