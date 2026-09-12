import { act, createRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("zooms, pans with arrow keys, returns to fit and resets on gallery navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const windowEvents = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
  vi.stubGlobal("window", windowEvents);
  const viewport = Object.assign(new EventTarget(), {
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 400,
    clientHeight: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  });
  const preview = {
    images: [
      { src: "/one.png", name: "One" },
      { src: "/two.png", name: "Two" },
    ],
    index: 0,
  };
  await act(async () => {
    renderer = create(<ExpandedImageDialog preview={preview} onClose={() => {}} />, {
      createNodeMock: (element) => (element.type === "div" ? viewport : null),
    });
  });
  const region = () => renderer!.root.findByProps({ role: "region" });
  const key = async (value: string) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: value });
    await act(async () => {
      windowEvents.dispatchEvent(event);
    });
    return event;
  };
  await act(async () => region().props.onKeyDown({ key: "+", preventDefault() {} }));
  expect(renderer!.root.findByProps({ "aria-live": "polite" }).children.join("")).toBe("150% zoom");
  const previousLeft = viewport.scrollLeft;
  expect((await key("ArrowRight")).defaultPrevented).toBe(true);
  expect(viewport.scrollLeft).toBe(previousLeft + 40);
  expect(renderer!.root.findByType("img").props.src).toBe("/one.png");
  await act(async () => region().props.onKeyDown({ key: "0", preventDefault() {} }));
  await key("ArrowRight");
  expect(renderer!.root.findByType("img").props.src).toBe("/two.png");
  expect(renderer!.root.findByProps({ "aria-live": "polite" }).children.join("")).toBe("100% zoom");
});

it("clamps zoom and only captures arrow navigation while zoomed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 }));
  const ref = createRef<ZoomableImageHandle>();
  const viewport = Object.assign(new EventTarget(), {
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 400,
    clientHeight: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  });
  await act(async () => {
    renderer = create(<ZoomableImage ref={ref} src="/one.png" name="One" />, {
      createNodeMock: (element) => (element.type === "div" ? viewport : null),
    });
  });
  expect(ref.current?.pan("ArrowRight")).toBe(false);
  const region = renderer!.root.findByProps({ role: "region" });
  await act(async () => {
    for (let i = 0; i < 20; i++) region.props.onKeyDown({ key: "+", preventDefault() {} });
  });
  expect(renderer!.root.findByProps({ "aria-live": "polite" }).children.join("")).toBe("800% zoom");
  expect(ref.current?.pan("Escape")).toBe(false);
  await act(async () => {
    for (let i = 0; i < 20; i++) region.props.onKeyDown({ key: "-", preventDefault() {} });
  });
  expect(ref.current?.pan("ArrowRight")).toBe(false);
});
