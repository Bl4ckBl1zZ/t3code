import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerRestingState } from "./useComposerRestingState";

class TimelineElement extends EventTarget {
  scrollTop = 400;
  scrollHeight = 1600;
  clientHeight = 600;
  firstElementChild = null;
  editable = false;
  contains(target: EventTarget) {
    return target === this;
  }
  closest() {
    return this.editable ? this : null;
  }
}
let node: TimelineElement;
let events: EventTarget;
let renderer: ReactTestRenderer;
let result: ReturnType<typeof useComposerRestingState>;
let resize: () => void;
let overflowing = true;
let atEnd = false;
let now = 0;
const manualNavigation = vi.fn();
const disconnected = vi.fn();
function Harness({ scope = "a" }: { scope?: string }) {
  const state = useComposerRestingState(scope, {
    getElement: () => node as unknown as HTMLElement,
    overflows: () => overflowing,
    atEnd: () => atEnd,
    onManualNavigation: manualNavigation,
  });
  state.eligible.current = true;
  useLayoutEffect(() => {
    result = state;
  });
  return null;
}
async function dispatch(type: string, properties: Record<string, unknown> = {}) {
  const event = new Event(type);
  Object.defineProperties(
    event,
    Object.fromEntries(
      Object.entries({ target: node, ...properties }).map(([key, value]) => [key, { value }]),
    ),
  );
  await act(() => events.dispatchEvent(event));
}
beforeEach(async () => {
  node = new TimelineElement();
  events = new EventTarget();
  overflowing = true;
  atEnd = false;
  now = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Element", TimelineElement);
  vi.stubGlobal("document", events);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        disconnected();
      }
    },
  );
  vi.spyOn(performance, "now").mockImplementation(() => now);
  await act(() => {
    renderer = create(<Harness />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it("responds only to reading gestures inside the timeline, preserving expansion through momentum", async () => {
  await dispatch("wheel", { deltaY: -40, target: new TimelineElement() });
  expect(result.collapsed).toBe(false);
  await dispatch("wheel", { deltaY: -40, ctrlKey: true });
  expect(result.collapsed).toBe(false);
  await dispatch("wheel", { deltaY: -40 });
  expect(result.collapsed).toBe(true);
  await act(() => result.expand());
  now = 50;
  await dispatch("wheel", { deltaY: -100 });
  expect(result.collapsed).toBe(false);
  now = 200;
  await dispatch("wheel", { deltaY: -40 });
  expect(result.collapsed).toBe(true);
});
it("resets on thread changes and when the real transcript stops overflowing", async () => {
  await dispatch("wheel", { deltaY: -40 });
  await act(() => renderer.update(<Harness scope="b" />));
  expect(result.collapsed).toBe(false);
  await dispatch("wheel", { deltaY: -40 });
  expect(result.collapsed).toBe(true);
  overflowing = false;
  await act(() => resize());
  expect(result.collapsed).toBe(false);
  expect(disconnected).toHaveBeenCalled();
});
it("keyboard reading releases live follow but leaves editor navigation and logical-end scrolling alone", async () => {
  node.editable = true;
  await dispatch("keydown", { key: "PageUp" });
  expect(result.collapsed).toBe(false);
  node.editable = false;
  atEnd = true;
  await dispatch("keydown", { key: "End" });
  expect(result.collapsed).toBe(false);
  await dispatch("keydown", { key: "PageUp" });
  expect(result.collapsed).toBe(true);
  expect(manualNavigation).toHaveBeenCalledOnce();
});
