import { describe, expect, it } from "vite-plus/test";
import {
  getAnchoredTurnMetrics,
  getRowBottom,
  isTimelineUserScrollUp,
  shouldPositionTimelineAnchor,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("subtracts composer height from usable viewport height", () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutComposer?.overflowsUsableViewport).toBe(false);
    expect(withComposer?.overflowsUsableViewport).toBe(true);
  });
});

describe("timeline anchor positioning", () => {
  it("positions a freshly anchored turn", () => {
    expect(
      shouldPositionTimelineAnchor({
        mode: "anchoring-new-turn",
        positionedAnchorMessageId: null,
        messageId: "m1",
      }),
    ).toBe(true);
  });

  it("ignores the repeat ready callbacks each streamed row triggers", () => {
    expect(
      shouldPositionTimelineAnchor({
        mode: "anchoring-new-turn",
        positionedAnchorMessageId: "m1",
        messageId: "m1",
      }),
    ).toBe(false);
  });

  it("never repositions once the reader is driving the scroller", () => {
    // The user-navigation cancel clears the positioned anchor, so the id check
    // alone would let every streamed row re-run the positioning scroll.
    expect(
      shouldPositionTimelineAnchor({
        mode: "free-scrolling",
        positionedAnchorMessageId: null,
        messageId: "m1",
      }),
    ).toBe(false);
  });
});

describe("timeline user scroll-up detection", () => {
  const previous = { scrollTop: 900, contentHeight: 4000 };

  it("detects a scroll away from the end that emitted no gesture event", () => {
    expect(
      isTimelineUserScrollUp({
        previous,
        next: { scrollTop: 700, contentHeight: 4000 },
        programmaticScrollInFlight: false,
      }),
    ).toBe(true);
  });

  it("ignores sub-threshold jitter from row remeasurement", () => {
    expect(
      isTimelineUserScrollUp({
        previous,
        next: { scrollTop: 896, contentHeight: 4000 },
        programmaticScrollInFlight: false,
      }),
    ).toBe(false);
  });

  it("ignores scrolling toward the end", () => {
    expect(
      isTimelineUserScrollUp({
        previous,
        next: { scrollTop: 1200, contentHeight: 4200 },
        programmaticScrollInFlight: false,
      }),
    ).toBe(false);
  });

  it("ignores offsets pulled up by shrinking content", () => {
    expect(
      isTimelineUserScrollUp({
        previous,
        next: { scrollTop: 700, contentHeight: 3800 },
        programmaticScrollInFlight: false,
      }),
    ).toBe(false);
  });

  it("ignores our own imperative scrolls", () => {
    expect(
      isTimelineUserScrollUp({
        previous,
        next: { scrollTop: 700, contentHeight: 4000 },
        programmaticScrollInFlight: true,
      }),
    ).toBe(false);
  });

  it("needs a baseline sample before it can judge", () => {
    expect(
      isTimelineUserScrollUp({
        previous: null,
        next: { scrollTop: 0, contentHeight: 4000 },
        programmaticScrollInFlight: false,
      }),
    ).toBe(false);
  });
});
