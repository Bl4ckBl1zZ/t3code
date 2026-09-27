import type { ChatCanvasSize, ChatLane } from "./chatCanvasLayout";

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
const MAX_WIDTH = 312;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;

/**
 * The card uses the space right of the chat lane. It never changes the
 * conversation's width: when the margin cannot hold readable controls there
 * is no inline placement and the card becomes a popover instead.
 */
export function resolveThreadDetailsCardLayout({
  container,
  chat,
}: {
  container: ChatCanvasSize;
  chat: ChatLane;
}) {
  const width = Math.min(MAX_WIDTH, container.width - chat.left - chat.width - GAP * 2);
  if (width < MIN_WIDTH) return null;
  const height = container.height - GAP * 2;
  if (height < MIN_HEIGHT) return null;
  return { x: container.width - width - GAP, y: GAP, width, height } as const;
}
