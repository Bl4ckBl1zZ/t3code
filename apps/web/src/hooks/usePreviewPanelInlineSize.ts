import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
}

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
/**
 * Upper bound as a fraction of the viewport; only binds on wide screens.
 * On narrow windows the container clamp below is what preserves the
 * sibling column's space.
 */
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;
/**
 * Width reserved for the sibling column (chat, pull-request list) sharing the
 * panel's flex row. The viewport fraction alone is not enough: the app
 * sidebar sits outside the row, so on narrow windows (any MacBook, even
 * fullscreen) the remaining 30% of the viewport minus the sidebar left the
 * sibling below its usable width and the composer overflowed.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360;

export function usePreviewPanelInlineSize(options?: {
  readonly storageKey?: string;
  readonly defaultWidth?: number;
  /**
   * The panel element. Its parent is the flex row the panel shares with its
   * sibling column, and that row — not the panel — is what gets measured.
   */
  readonly hostRef?: RefObject<HTMLDivElement | null>;
  /**
   * Only inline non-maximized mode applies `width`/`maxWidth`; skip the
   * container measurement (and its re-renders) everywhere else.
   */
  readonly measureContainer?: boolean;
}): PreviewPanelInlineSize {
  const maxWidth = useClampedMaxWidth(options?.hostRef, options?.measureContainer ?? false);
  return useResizableWidth({
    storageKey: options?.storageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: options?.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
}

/**
 * Track viewport and flex-row widths to derive an upper bound for the panel.
 * Resize-aware so dragging the OS window narrower (or expanding the app
 * sidebar) re-clamps the stored width on the next render (the hook's clamp
 * picks this up automatically). The row is observed rather than the panel
 * itself because the panel competes with its sibling column for row space.
 * Row measurement only runs when `enabled`; modes without a resize handle
 * never apply the resulting width, so they skip the observer entirely.
 */
function useClampedMaxWidth(
  hostRef: RefObject<HTMLDivElement | null> | undefined,
  enabled: boolean,
): number {
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const onResize = () => {
      // Coalesce rapid resize events into one rAF tick.
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setVw(window.innerWidth);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  useLayoutEffect(() => {
    if (!enabled || !hostRef) return;
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    // Measure before first paint: the persisted width must be clamped
    // against the row on the initial render, not one observer tick later
    // (the panel would flash over-wide on every mount). clientWidth is
    // integral, so sub-pixel resize deltas bail out of re-rendering.
    const measure = () => {
      setContainerWidth(parent.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => {
      observer.disconnect();
    };
  }, [hostRef, enabled]);
  return getPreviewPanelMaxWidth(vw, containerWidth);
}

export function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp
  // must not see max < min (it would resolve the inversion to min and,
  // via drag-end persistence, overwrite the user's stored width).
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}
