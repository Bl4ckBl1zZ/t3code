import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";

import { cn } from "../../lib/utils";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { Popover, PopoverCreateHandle, PopoverPopup } from "../ui/popover";
import { useChatCanvas } from "./ChatCanvasContext";
import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
  type ThreadDetailsCardDensity,
} from "./threadDetailsCardLayout";

/**
 * One card owns its placement: docked at the chat canvas' top right while a
 * readable chat lane fits beside it, otherwise a popover under the header
 * toggle. It folds content only when that content cannot fit its height.
 */
export function ThreadDetailsCard({
  threadRef,
  anchor,
  handle,
  onPresentationChange,
  children,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  onPresentationChange: (presentation: ThreadPanelPresentation) => void;
  children: (density: ThreadDetailsCardDensity) => ReactNode;
}) {
  const canvas = useChatCanvas();
  const placement = canvas
    ? resolveThreadDetailsCardLayout({
        container: canvas.container,
        lane: canvas.lane,
        topInset: canvas.detailsCardTopInset,
      })
    : null;
  const mode: ThreadPanelPresentation = placement ? "inline" : "popover";
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const popoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const measurementKey = `${threadRef.environmentId}:${threadRef.threadId}:${placement?.width ?? "popup"}`;
  const [measurements, setMeasurements] = useState({
    key: measurementKey,
    heights: { full: 0, compact: 0 },
  });
  const contentHeights =
    measurements.key === measurementKey ? measurements.heights : { full: 0, compact: 0 };
  // A popover hangs below the header over the canvas, so the canvas bounds it too.
  const height = placement?.height ?? Math.max(0, (canvas?.container.height ?? 0) - 52);
  const density = resolveThreadDetailsCardDensity(height, contentHeights);
  // While docked and open, the canvas moves chat over to clear the card.
  const reportDetailsCard = canvas?.reportDetailsCard;
  const dockedLeft = placement && inlineOpen ? placement.x : null;
  useLayoutEffect(() => {
    reportDetailsCard?.(dockedLeft === null ? null : { left: dockedLeft });
  }, [reportDetailsCard, dockedLeft]);
  useLayoutEffect(() => () => reportDetailsCard?.(null), [reportDetailsCard]);
  useLayoutEffect(() => {
    onPresentationChange(mode);
    if (mode === "inline" && popoverOpen) {
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
    }
  }, [mode, onPresentationChange, threadRef, popoverOpen]);
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || density === "essential") return;
    // Measure the single content tree before the scroll viewport clips it. Retain each
    // observed height so increasing available space restores the detail it can hold.
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-details-card]");
      const next = element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0);
      // Lineage scrolls as it expands. Counting it toward density would hide
      // the section and workspace controls when the user asks to see more rows.
      const lineage = element.querySelector<HTMLElement>("[data-thread-relationships-panel]");
      const fittingHeight = next - (lineage?.offsetHeight ?? 0);
      setMeasurements((current) => {
        const heights = current.key === measurementKey ? current.heights : { full: 0, compact: 0 };
        return current.key === measurementKey && heights[density] === fittingHeight
          ? current
          : { key: measurementKey, heights: { ...heights, [density]: fittingHeight } };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [contentElement, density, measurementKey]);
  const card = (
    <div
      className={cn(
        // A single-track grid, because a grid area is a definite containing block: as a plain
        // block the scroll child's max-height resolved to nothing and the card clipped its
        // content instead of scrolling it. `minmax(0,1fr)` still shrink-wraps short content.
        "panel-glass grid grid-rows-[minmax(0,1fr)] overflow-hidden rounded-[20px]",
        mode === "popover" && "max-h-[calc(100dvh-6.5rem)]",
      )}
      style={placement ? { maxHeight: placement.height } : undefined}
      data-thread-details-card
    >
      <div className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={setContentElement}>{children(density)}</div>
      </div>
    </div>
  );
  return (
    <Popover
      handle={handle}
      open={mode === "popover" && popoverOpen}
      onOpenChange={(open) =>
        useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", open)
      }
    >
      {placement ? (
        inlineOpen ? (
          <aside
            aria-label="Thread details"
            // With panel motion on, the card fades in while chat moves over.
            className="absolute z-20 [[data-panel-animations=true]_&]:transition-opacity [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out [[data-panel-animations=true]_&]:starting:opacity-0"
            style={{
              left: placement.x,
              top: placement.y,
              width: placement.width,
              maxHeight: placement.height,
            }}
            data-density={density}
            data-thread-details-panel="inline"
          >
            {card}
          </aside>
        ) : null
      ) : (
        <PopoverPopup
          bare
          anchor={anchor}
          align="end"
          alignOffset={0}
          collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
          side="bottom"
          sideOffset={0}
          // A docked workspace panel, so it layers with sheets, below dialogs.
          positionerClassName="z-(--z-sheet) w-[min(var(--thread-details-panel-width),var(--anchor-width))] !transition-none"
          className="w-full !overflow-visible"
          viewportClassName="!overflow-visible p-2"
        >
          <div data-density={density} data-thread-details-panel="popover">
            {card}
          </div>
        </PopoverPopup>
      )}
    </Popover>
  );
}
