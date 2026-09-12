import { type ReactNode, type RefObject, useRef, useState, useLayoutEffect } from "react";

import { isElectron } from "~/env";
import {
  getPreviewPanelMaxWidth,
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "~/hooks/usePreviewPanelInlineSize";

export { getPreviewPanelMaxWidth };
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

/**
 * Shell for the preview panel. In inline mode the panel is user-resizable
 * via a drag handle on the left edge; width persists per browser. In
 * sheet/sidebar modes the parent owns the size.
 */
interface PreviewPanelShellProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  inlineSize?: PreviewPanelInlineSize;
  /**
   * Overrides the localStorage key used to persist the panel width. Callers
   * embedding this shell for a different surface (e.g. the pull requests
   * page) should pass their own key so resizing one panel doesn't clobber
   * the other's remembered width. Ignored when `inlineSize` is provided.
   */
  widthStorageKey?: string;
  /** Overrides the initial width (px) before the user has resized the panel. */
  defaultWidth?: number;
  /**
   * The panel element, when the caller owns `inlineSize`: its parent is the
   * flex row measured to reserve the sibling column's width.
   */
  hostRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

export function PreviewPanelShell(props: PreviewPanelShellProps) {
  if (props.inlineSize) {
    return <PreviewPanelShellFrame {...props} inlineSize={props.inlineSize} />;
  }

  return <ResizablePreviewPanelShell {...props} />;
}

function ResizablePreviewPanelShell(props: PreviewPanelShellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inlineSize = usePreviewPanelInlineSize({
    ...(props.widthStorageKey ? { storageKey: props.widthStorageKey } : {}),
    ...(props.defaultWidth ? { defaultWidth: props.defaultWidth } : {}),
    hostRef,
    measureContainer: props.mode === "inline" && !props.maximized,
  });
  return <PreviewPanelShellFrame {...props} hostRef={hostRef} inlineSize={inlineSize} />;
}

function PreviewPanelShellFrame(
  props: PreviewPanelShellProps & { inlineSize: PreviewPanelInlineSize },
) {
  const useDragRegion = isElectron && props.mode !== "sheet" && props.mode !== "embedded";
  const isInline = props.mode === "inline";
  const localHostRef = useRef<HTMLDivElement | null>(null);
  const hostRef = props.hostRef ?? localHostRef;
  const { width, handlers } = props.inlineSize;
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  // Derive suppression before the layout commits so the browser never creates
  // a width transition for resize or maximize changes.
  const [layoutTransition, setLayoutTransition] = useState(() => ({
    open,
    width,
    maximized,
    suppressed: false,
  }));
  if (
    layoutTransition.open !== open ||
    layoutTransition.width !== width ||
    layoutTransition.maximized !== maximized
  ) {
    setLayoutTransition({
      open,
      width,
      maximized,
      suppressed:
        collapsible &&
        layoutTransition.open === open &&
        (layoutTransition.width !== width || layoutTransition.maximized !== maximized),
    });
  }
  const suppressWidthTransition = layoutTransition.suppressed;
  useLayoutEffect(() => {
    if (!suppressWidthTransition) return;
    let restoreFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      restoreFrame = window.requestAnimationFrame(() => {
        setLayoutTransition((current) => ({ ...current, suppressed: false }));
      });
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(restoreFrame);
    };
  }, [suppressWidthTransition]);
  return (
    <div
      ref={hostRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        isInline
          ? props.maximized
            ? "flex-1 border-l border-border"
            : "shrink-0 border-l border-border"
          : "w-full",
        collapsible &&
          "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:[transition-duration:var(--panel-animation-duration)] [[data-panel-animations=true]_&]:ease-out",
        collapsible && open && "[[data-panel-animations=true]_&]:starting:w-0!",
        collapsible && !open && "pointer-events-none",
      )}
      inert={collapsible && !open}
      aria-hidden={collapsible && !open ? true : undefined}
      style={
        isInline
          ? {
              width: maximized ? "100%" : collapsible && !open ? "0px" : `${width}px`,
              transitionDuration: suppressWidthTransition ? "0ms" : undefined,
            }
          : undefined
      }
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={props.maximized ? "true" : "false"}
    >
      {isInline && !props.maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-clip")}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          style={collapsible && !maximized ? { width: `calc(${width}px - 1px)` } : undefined}
        >
          {useDragRegion ? <div className="electron-drag-region h-0 w-full" aria-hidden /> : null}
          {props.children}
        </div>
      </div>
    </div>
  );
}
