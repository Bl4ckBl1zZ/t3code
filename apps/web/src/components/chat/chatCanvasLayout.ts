export interface ChatCanvasSize {
  readonly width: number;
  readonly height: number;
}

export interface ChatLane {
  readonly left: number;
  readonly width: number;
  /** Space the lane gives up on its right so centered content clears the workspace card. */
  readonly insetEnd: number;
}

/** Where the docked workspace card starts, measured from the canvas' left edge. */
export interface ChatCanvasDetailsCard {
  readonly left: number;
}

// Minimum space between chat and the workspace card. Chat stays centered while
// the card fits beside it with this much room.
export const DETAILS_CARD_CLEARANCE = 32;
// The narrowest chat the workspace card docks beside. Below it the card
// becomes a popover and chat takes the whole canvas again.
export const MIN_DOCKED_CHAT_WIDTH = 640;

/**
 * The conversation lane inside the chat canvas: centered, at most
 * `maxChatWidth` wide, never closer than `padding` to either edge. A docked
 * workspace card that does not fit beside the centered lane first moves it
 * left, only as far as it needs; the lane narrows only after it reaches the
 * left padding.
 */
export function resolveChatCanvasLayout({
  container,
  padding = 20,
  maxChatWidth = 768,
  detailsCard = null,
}: {
  container: ChatCanvasSize;
  padding?: number;
  maxChatWidth?: number;
  detailsCard?: ChatCanvasDetailsCard | null;
}): { readonly chat: ChatLane } {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  const laneRight = detailsCard
    ? detailsCard.left - DETAILS_CARD_CLEARANCE
    : container.width - padding;
  const width = Math.max(0, Math.min(centeredWidth, laneRight - padding));
  const left = Math.max(padding, Math.min((container.width - width) / 2, laneRight - width));
  return {
    chat: { left, width, insetEnd: Math.max(0, container.width - left * 2 - width) },
  };
}
