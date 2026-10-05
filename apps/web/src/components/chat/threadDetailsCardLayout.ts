import { DETAILS_CARD_CLEARANCE, type ChatCanvasSize } from "./chatCanvasLayout";

export type ThreadDetailsCardDensity = "full" | "compact" | "essential";

/**
 * How much of the card's content fits. Heights of 0 are content not yet
 * measured, which counts as fitting until a measurement says otherwise.
 */
export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
): ThreadDetailsCardDensity {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

const GAP = 12;
// Keep in sync with --thread-details-panel-width, which sizes the popover.
const WIDTH = 280;
const MIN_HEIGHT = 160;

/**
 * The card pins to the top right while a readable chat lane fits beside it;
 * the chat canvas moves the lane over to make room. Otherwise there is no
 * inline placement and the card becomes a popover instead.
 */
export function resolveThreadDetailsCardLayout({
  container,
  lane,
}: {
  container: ChatCanvasSize;
  lane: { readonly padding: number; readonly minChatWidth: number };
}) {
  const x = container.width - WIDTH - GAP;
  if (x - DETAILS_CARD_CLEARANCE - lane.padding < lane.minChatWidth) return null;
  const height = container.height - GAP * 2;
  if (height < MIN_HEIGHT) return null;
  return { x, y: GAP, width: WIDTH, height } as const;
}
