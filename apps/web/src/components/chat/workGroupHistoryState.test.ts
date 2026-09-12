import { describe, expect, it } from "vite-plus/test";
import {
  WorkGroupHistoryState,
  captureWorkGroupAnchor,
  restoreWorkGroupAnchor,
  shouldFollowWorkGroupAppend,
} from "./workGroupHistoryState";

const entries = [{ id: "first" }, { id: "expanded-output" }, { id: "last" }];

describe("tool history reading position", () => {
  it("captures the actual scrolled row and an offset inside long output", () => {
    const anchor = captureWorkGroupAnchor({
      data: entries,
      scroll: 425,
      positionAtIndex: (index) => [0, 40, 800][index],
    });
    expect(anchor).toEqual({ entryId: "expanded-output", offset: 385 });
    expect(restoreWorkGroupAnchor([{ id: "earlier" }, ...entries], anchor)).toEqual({
      index: 2,
      viewOffset: -385,
    });
  });
  it("does not invent a position for missing rows or unavailable measurements", () => {
    expect(restoreWorkGroupAnchor(entries, { entryId: "deleted", offset: 100 })).toBeUndefined();
    expect(
      captureWorkGroupAnchor({ data: entries, scroll: 40, positionAtIndex: () => undefined }),
    ).toBeUndefined();
    expect(
      captureWorkGroupAnchor({ data: [], scroll: 40, positionAtIndex: () => 0 }),
    ).toBeUndefined();
    expect(
      captureWorkGroupAnchor({ data: entries, scroll: NaN, positionAtIndex: () => 0 }),
    ).toBeUndefined();
  });
  it("clamps overscroll and preserves exact row boundaries", () => {
    expect(
      captureWorkGroupAnchor({ data: entries, scroll: -5, positionAtIndex: (i) => i * 40 }),
    ).toEqual({ entryId: "first", offset: 0 });
    expect(
      captureWorkGroupAnchor({ data: entries, scroll: 80, positionAtIndex: (i) => i * 40 }),
    ).toEqual({ entryId: "last", offset: 0 });
  });
  it("only follows newly appended calls when the reader was at the end", () => {
    const next = [...entries, { id: "new" }];
    expect(shouldFollowWorkGroupAppend(entries, next, true)).toBe(true);
    expect(shouldFollowWorkGroupAppend(entries, next, false)).toBe(false);
    expect(
      shouldFollowWorkGroupAppend(
        entries,
        entries.map((e) => ({ ...e, output: "updated" })),
        true,
      ),
    ).toBe(false);
    expect(shouldFollowWorkGroupAppend(entries, [{ id: "earlier" }, ...entries], true)).toBe(false);
    expect(shouldFollowWorkGroupAppend([], next, true)).toBe(false);
  });
  it("retains independent expansion and scroll state through unmount/remount", () => {
    const state = new WorkGroupHistoryState();
    state.set("group:first", { expanded: true });
    state.set("group:first", { anchor: { entryId: "expanded-output", offset: 30 } });
    state.set("entry:expanded-output", { expanded: true });
    state.set("group:first", { expanded: false });
    expect(state.get("group:first")).toEqual({
      expanded: false,
      anchor: { entryId: "expanded-output", offset: 30 },
    });
    expect(state.get("entry:expanded-output")?.expanded).toBe(true);
    expect(new WorkGroupHistoryState().get("group:first")).toBeUndefined();
  });
  it("bounds retained UI state and keeps recently updated groups", () => {
    const state = new WorkGroupHistoryState(2);
    state.set("one", { expanded: true });
    state.set("two", { expanded: true });
    state.set("one", { expanded: false });
    state.set("three", { expanded: true });
    expect(state.get("two")).toBeUndefined();
    expect(state.get("one")?.expanded).toBe(false);
    expect(state.get("three")?.expanded).toBe(true);
  });
});
