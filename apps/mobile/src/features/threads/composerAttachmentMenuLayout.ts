import type { WindowRect } from "../../lib/composerAttachmentFlight";

const MARGIN = 10;
const MENU_WIDTH = 256;
const MENU_ROW_HEIGHT = 60;
const MENU_PADDING = 12;
const PANEL_MAX_WIDTH = 560;
const PANEL_MIN_HEIGHT = 420;

/**
 * The menu centres on the + button; the camera and photo panel grows from the menu's top edge
 * down to the bottom of the screen, covering the keyboard like the system share sheets do.
 */
export function composerAttachmentMenuLayout(input: {
  readonly window: { readonly width: number; readonly height: number };
  readonly insets: { readonly top: number; readonly bottom: number };
  readonly anchor: WindowRect;
  readonly rows: number;
}) {
  const { window, insets, anchor } = input;
  const panelWidth = Math.min(window.width - MARGIN * 2, PANEL_MAX_WIDTH);
  const menuWidth = Math.min(MENU_WIDTH, panelWidth);
  const left = clamp(anchor.x - 4, MARGIN, window.width - MARGIN - panelWidth);
  const menuHeight = input.rows * MENU_ROW_HEIGHT + MENU_PADDING * 2;
  const anchorCenterY = anchor.y + anchor.height / 2;
  const minTop = insets.top + MARGIN;
  const menuTop = clamp(
    anchorCenterY - menuHeight / 2,
    minTop,
    window.height - Math.max(insets.bottom, MARGIN) - menuHeight,
  );
  const panelBottom = window.height - MARGIN;
  const panelMinHeight = Math.min(
    panelBottom - minTop,
    Math.max(panelWidth * 1.25, PANEL_MIN_HEIGHT),
  );
  const panelTop = Math.max(minTop, Math.min(menuTop, panelBottom - panelMinHeight));
  return {
    left,
    menu: { top: menuTop, width: menuWidth, height: menuHeight },
    panel: { top: panelTop, width: panelWidth, height: panelBottom - panelTop },
    origin: { x: anchor.x + anchor.width / 2, y: anchorCenterY },
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
