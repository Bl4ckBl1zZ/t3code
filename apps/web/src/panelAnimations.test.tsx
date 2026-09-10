import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePanelNavigationSuppression, usePanelPresence } from "./panelAnimations";

let renderer: ReactTestRenderer | null = null;
let pendingFrames: FrameRequestCallback[] = [];
let observed: boolean[] = [];

function SuppressionProbe({ navigationKey }: { navigationKey: string }) {
  const suppressed = usePanelNavigationSuppression(navigationKey);
  useLayoutEffect(() => {
    observed.push(suppressed);
  }, [suppressed]);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  pendingFrames = [];
  observed = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    }),
    cancelAnimationFrame: vi.fn(),
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function paintPendingFrame() {
  const callback = pendingFrames.shift();
  await act(() => callback?.(0));
}

describe("usePanelNavigationSuppression", () => {
  it("suppresses initial and navigated panel state until each route has painted", async () => {
    await act(() => {
      renderer = create(<SuppressionProbe navigationKey="/thread/one" />);
    });
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);

    await act(() => {
      renderer?.update(<SuppressionProbe navigationKey="/thread/two" />);
    });
    expect(observed.at(-1)).toBe(true);

    await paintPendingFrame();
    expect(observed.at(-1)).toBe(true);
    await paintPendingFrame();
    expect(observed.at(-1)).toBe(false);
  });
});

let presence: ReturnType<typeof usePanelPresence<string>>;
function PresenceProbe({
  open,
  scope = "a",
  animated = true,
}: {
  open: boolean;
  scope?: string;
  animated?: boolean;
}) {
  const state = usePanelPresence(open, open ? `content:${scope}` : null, animated, scope, 200);
  useLayoutEffect(() => {
    presence = state;
  });
  return null;
}

describe("closing panel presence", () => {
  it("retains content through closing and cancels its expiry when reopened", async () => {
    await act(() => {
      renderer = create(<PresenceProbe open />);
    });
    await act(() => {
      renderer?.update(<PresenceProbe open={false} />);
    });
    expect(presence).toEqual({ present: true, value: "content:a" });
    await act(() => vi.advanceTimersByTime(199));
    expect(presence.present).toBe(true);
    await act(() => {
      renderer?.update(<PresenceProbe open />);
    });
    await act(() => vi.advanceTimersByTime(10));
    expect(presence).toEqual({ present: true, value: "content:a" });
    await act(() => {
      renderer?.update(<PresenceProbe open={false} />);
    });
    await act(() => vi.advanceTimersByTime(200));
    expect(presence).toEqual({ present: false, value: null });
  });
  it("never carries old content into another thread and closes immediately without motion", async () => {
    await act(() => {
      renderer = create(<PresenceProbe open />);
    });
    await act(() => {
      renderer?.update(<PresenceProbe open={false} scope="b" />);
    });
    expect(presence).toEqual({ present: false, value: null });
    await act(() => {
      renderer?.update(<PresenceProbe open scope="b" />);
    });
    await act(() => {
      renderer?.update(<PresenceProbe open={false} scope="b" animated={false} />);
    });
    expect(presence).toEqual({ present: false, value: null });
  });
});
