import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { forwardWheelToTimeline } from "./timelineMinimapWheel";

/** The slice of WheelEvent the forwarder reads, so the test runs without a DOM. */
class TestWheelEvent extends Event {
  static readonly DOM_DELTA_PIXEL = 0;
  static readonly DOM_DELTA_LINE = 1;
  static readonly DOM_DELTA_PAGE = 2;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly deltaMode: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;

  constructor(type: string, init: WheelEventInit = {}) {
    super(type, init);
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = init.deltaZ ?? 0;
    this.deltaMode = init.deltaMode ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.screenX = init.screenX ?? 0;
    this.screenY = init.screenY ?? 0;
    this.altKey = init.altKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }
}

beforeEach(() => {
  vi.stubGlobal("WheelEvent", TestWheelEvent);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const scrollBy = vi.fn();
  const timeline = Object.assign(new EventTarget(), { clientHeight: 500, scrollBy });
  const minimap = new EventTarget();
  const seen: TestWheelEvent[] = [];
  timeline.addEventListener("wheel", (event) => seen.push(event as TestWheelEvent));
  minimap.addEventListener("wheel", (event) =>
    forwardWheelToTimeline(event as WheelEvent, timeline as unknown as HTMLElement),
  );
  const wheel = (init: WheelEventInit) => {
    const event = new TestWheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    minimap.dispatchEvent(event);
    return event;
  };
  return { timeline, scrollBy, seen, wheel };
}

describe("forwardWheelToTimeline", () => {
  it("replays the wheel on the timeline and scrolls it instead of the minimap", () => {
    const { timeline, scrollBy, seen, wheel } = setup();
    const original = wheel({ deltaY: -120, clientX: 20, clientY: 300 });

    expect(original.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target).toBe(timeline);
    expect(seen[0]?.deltaY).toBe(-120);
    expect(seen[0]?.clientY).toBe(300);
    expect(scrollBy).toHaveBeenCalledWith({ top: -120 });
  });

  it.each([
    { deltaMode: TestWheelEvent.DOM_DELTA_LINE, top: 48 },
    { deltaMode: TestWheelEvent.DOM_DELTA_PAGE, top: 1500 },
  ])("converts delta mode $deltaMode to pixels", ({ deltaMode, top }) => {
    const { scrollBy, wheel } = setup();
    wheel({ deltaY: 3, deltaMode });
    expect(scrollBy).toHaveBeenCalledWith({ top });
  });

  it("lets a timeline listener cancel the scroll", () => {
    const { timeline, scrollBy, wheel } = setup();
    timeline.addEventListener("wheel", (event) => event.preventDefault());
    wheel({ deltaY: 40 });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it.each([{ deltaY: 40, ctrlKey: true }, { deltaX: 40 }])(
    "leaves pinch zoom and horizontal wheels alone: %j",
    (init) => {
      const { scrollBy, seen, wheel } = setup();
      expect(wheel(init).defaultPrevented).toBe(false);
      expect(seen).toHaveLength(0);
      expect(scrollBy).not.toHaveBeenCalled();
    },
  );
});
