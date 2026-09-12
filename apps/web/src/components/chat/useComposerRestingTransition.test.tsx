import { act, useRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerRestingTransition } from "./useComposerRestingTransition";

function createAnimation() {
  return {
    cancel: vi.fn(),
    finished: new Promise<void>(() => {}),
    currentTime: 30,
    effect: { getComputedTiming: () => ({ duration: 280 }) },
  };
}

class Box {
  style = {
    removeProperty: vi.fn((key: string) => {
      delete (this.style as Record<string, unknown>)[key];
    }),
  };
  height = 140;
  isConnected = true;
  getBoundingClientRect() {
    return { height: this.height, width: 400, top: 500 - this.height, bottom: 500 };
  }
  getClientRects() {
    return [this.getBoundingClientRect()];
  }
  querySelector(selector: string): Box | null {
    if (selector.includes("surface")) return surface;
    if (selector.includes("footer")) return footer;
    if (selector.includes("body")) return body;
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return overlay;
  }
  animate = vi.fn(() => {
    const animation = createAnimation();
    animations.push(animation);
    return animation;
  });
}
let node: Box;
let surface: Box;
let footer: Box;
let body: Box;
let overlay: Box;
let animations: ReturnType<typeof createAnimation>[];
let renderer: ReactTestRenderer;
const publish = vi.fn();
function Harness({ collapsed = false, enabled = true }) {
  const controls = useRef(null);
  const ref = useComposerRestingTransition(collapsed, collapsed, controls, publish, enabled);
  return <div ref={ref} />;
}
beforeEach(async () => {
  animations = [];
  node = new Box();
  surface = new Box();
  footer = new Box();
  body = new Box();
  overlay = new Box();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  await act(() => {
    renderer = create(<Harness />, { createNodeMock: () => node });
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("paints the initial size without animating, then publishes one destination and clears pinned layout", async () => {
  expect(node.animate).not.toHaveBeenCalled();
  node.height = 60;
  overlay.height = 100;
  await act(() => renderer.update(<Harness collapsed />));
  expect(node.animate).toHaveBeenCalledWith(
    [{ height: "140px" }, { height: "60px" }],
    expect.any(Object),
  );
  expect(publish).toHaveBeenLastCalledWith(100);
  expect(overlay.style).toMatchObject({ height: "100px", justifyContent: "flex-end" });
  await act(() => renderer.unmount());
  expect(animations[0]!.cancel).toHaveBeenCalled();
  expect(overlay.style).not.toHaveProperty("height");
  expect(footer.style).not.toHaveProperty("position");
});
it("retargets from the visible height and cancels an interrupted transition", async () => {
  node.height = 60;
  await act(() => renderer.update(<Harness collapsed />));
  const first = animations[0]!;
  node.height = 110;
  await act(() => renderer.update(<Harness />));
  expect(first.cancel).toHaveBeenCalled();
  // The interrupted visible size is authoritative, rather than the old expanded size.
  expect(overlay.style).not.toHaveProperty("height");
});
it("honors disabled motion while still publishing the destination height", async () => {
  node.height = 60;
  await act(() => renderer.update(<Harness collapsed enabled={false} />));
  expect(node.animate).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalled();
  expect(overlay.style).not.toHaveProperty("height");
});
