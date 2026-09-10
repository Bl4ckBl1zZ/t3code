import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GhosttyTerminalCore } from "./core";
import { GhosttyTerminalSurface, type GhosttyTerminalSurfaceOptions } from "./surface";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

describe("GhosttyTerminalSurface middle-click paste", () => {
  const surfaces = new Set<GhosttyTerminalSurface>();

  // Keep the real surface, renderer, and WASM core. Only browser layout and
  // scheduling are replaced so tests can count work while the terminal is hidden.
  function createHarness() {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    const resizeCallbacks = new Set<() => void>();
    const paint = vi.fn((_operation: string, _args: ReadonlyArray<unknown>) => {});
    let frameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });

    class TerminalTestElement extends EventTarget {
      style: Record<string, string> = {};
      parentElement: TerminalTestElement | null = null;
      clientWidth = 168;
      clientHeight = 104;
      width = 300;
      height = 150;
      value = "";
      private readonly captures = new Set<number>();

      setAttribute() {}
      append(...children: TerminalTestElement[]) {
        for (const child of children) child.parentElement = this;
      }
      replaceChildren(...children: TerminalTestElement[]) {
        this.append(...children);
      }
      remove() {
        this.parentElement = null;
      }
      getContext() {
        return context;
      }
      focus() {
        this.dispatchEvent(new Event("focus"));
      }
      setPointerCapture(pointerId: number) {
        this.captures.add(pointerId);
      }
      hasPointerCapture(pointerId: number) {
        return this.captures.has(pointerId);
      }
      releasePointerCapture(pointerId: number) {
        this.captures.delete(pointerId);
      }
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 168, bottom: 104, width: 168, height: 104 };
      }
    }

    const canvas = new TerminalTestElement();
    const mount = new TerminalTestElement();
    const context = {
      canvas,
      beginPath() {},
      clip() {},
      rect() {},
      resetTransform() {},
      restore() {},
      save() {},
      setTransform() {},
      fillRect: (...args: number[]) => paint("fillRect", args),
      strokeRect: (...args: number[]) => paint("strokeRect", args),
      fillText: (...args: [string, number, number, number?]) => paint("fillText", args),
      measureText: (text: string) => ({
        width: text.length * 8,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
      }),
    };
    vi.stubGlobal("document", {
      createElement: (tag: string) => (tag === "canvas" ? canvas : new TerminalTestElement()),
      fonts: Object.assign(new EventTarget(), { load: async () => [], add() {} }),
    });
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        devicePixelRatio: 1,
        requestAnimationFrame: requestFrame,
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
      }),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {
          resizeCallbacks.add(callback);
        }
        observe() {}
        disconnect() {
          resizeCallbacks.delete(this.callback);
        }
      },
    );
    const snapshot = vi.spyOn(GhosttyTerminalCore.prototype, "snapshot");
    const onData = vi.fn<(data: string) => void>();

    return {
      mount,
      frames,
      paint,
      requestFrame,
      snapshot,
      onData,
      get renderedSnapshot() {
        const result = snapshot.mock.results.at(-1);
        if (result?.type !== "return") throw new Error("No terminal snapshot was rendered");
        return result.value;
      },
      flushFrame() {
        const queued = [...frames.values()];
        frames.clear();
        for (const callback of queued) callback(0);
      },
      resize() {
        for (const callback of resizeCallbacks) callback();
      },
      pointer(type: string, clientX: number, buttons: number, shiftKey = false, button = 0) {
        canvas.dispatchEvent(
          Object.assign(new Event(type, { cancelable: true }), {
            clientX,
            clientY: 5,
            pointerId: 1,
            button,
            buttons,
            shiftKey,
          }),
        );
      },
      async create(options: Partial<GhosttyTerminalSurfaceOptions> = {}) {
        const surface = await GhosttyTerminalSurface.create(mount as unknown as HTMLElement, {
          theme: {
            foreground: { r: 255, g: 255, b: 255 },
            background: { r: 0, g: 0, b: 0 },
            cursor: { r: 255, g: 255, b: 255 },
          },
          onData,
          onResize() {},
          onSelectionChange() {},
          beforeKey: () => false,
          onLinkActivate() {},
          ...options,
        });
        surfaces.add(surface);
        return surface;
      },
    };
  }

  afterEach(() => {
    for (const surface of surfaces) surface.dispose();
    surfaces.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pastes the terminal selection, and only that, on a Linux middle click", async () => {
    const harness = createHarness();
    const readText = vi.fn(async () => "clipboard text");
    vi.stubGlobal("navigator", { platform: "Linux x86_64", clipboard: { readText } });
    const surface = await harness.create();
    surface.write("hello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointermove", 37, 1);
    harness.pointer("pointerup", 37, 0);
    expect(surface.getSelection()).toBe("hello");

    harness.onData.mockClear();
    harness.pointer("pointerdown", 5, 4, false, 1);
    await vi.waitFor(() => expect(harness.onData).toHaveBeenCalled());
    expect(harness.onData.mock.calls.at(-1)?.[0]).toBe("hello");
    expect(surface.getSelection()).toBe("hello");

    // Without a selection there is no primary buffer to paste; the clipboard
    // holds what the user copied and must not be substituted.
    surface.clearSelection();
    harness.pointer("pointerdown", 5, 4, false, 1);
    expect(readText).not.toHaveBeenCalled();
  });
});
