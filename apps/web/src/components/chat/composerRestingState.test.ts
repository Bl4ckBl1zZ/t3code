import { describe, expect, it } from "vite-plus/test";
import {
  createComposerReadingGesture,
  recordComposerReadingGesture,
  suppressComposerReadingGesture,
  resolveRestingComposerInset,
} from "./composerRestingState";

describe("composer reading gestures", () => {
  const event = { now: 0, delta: 10, eligible: true, canScroll: true, towardLogicalEnd: false };
  it("ignores small movement but collapses after a deliberate scroll", () => {
    const gesture = createComposerReadingGesture();
    expect(recordComposerReadingGesture(gesture, event)).toBe(false);
    expect(recordComposerReadingGesture(gesture, { ...event, now: 10 })).toBe(false);
    expect(recordComposerReadingGesture(gesture, { ...event, now: 20 })).toBe(true);
  });
  it("does not add unrelated gestures together", () => {
    const gesture = createComposerReadingGesture();
    expect(recordComposerReadingGesture(gesture, { ...event, delta: 20 })).toBe(false);
    expect(recordComposerReadingGesture(gesture, { ...event, now: 200 })).toBe(false);
  });
  it("does not collapse for a blocked composer, overscroll or motion toward the logical end", () => {
    for (const override of [
      { eligible: false },
      { canScroll: false },
      { towardLogicalEnd: true },
    ]) {
      expect(
        recordComposerReadingGesture(createComposerReadingGesture(), {
          ...event,
          delta: 100,
          ...override,
        }),
      ).toBe(false);
    }
  });
  it("keeps the composer expanded through trackpad momentum after explicit interaction", () => {
    const gesture = createComposerReadingGesture();
    expect(recordComposerReadingGesture(gesture, { ...event, delta: 30 })).toBe(true);
    suppressComposerReadingGesture(gesture, 10);
    expect(recordComposerReadingGesture(gesture, { ...event, now: 20, delta: 100 })).toBe(false);
    expect(recordComposerReadingGesture(gesture, { ...event, now: 80, delta: 100 })).toBe(false);
    expect(recordComposerReadingGesture(gesture, { ...event, now: 240, delta: 30 })).toBe(true);
  });
  it("keeps enough timeline space when the resting composer expands", () => {
    expect(resolveRestingComposerInset(200, 100, true)).toBe(200);
    expect(resolveRestingComposerInset(0, 100, true)).toBe(194);
    expect(resolveRestingComposerInset(200, 300, true)).toBe(394);
    expect(resolveRestingComposerInset(394, 200, false)).toBe(200);
  });
});
