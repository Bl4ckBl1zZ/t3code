export interface ChatCanvasSize {
  readonly width: number;
  readonly height: number;
}

export interface ChatLane {
  readonly left: number;
  readonly width: number;
}

/**
 * The conversation lane inside the chat canvas: centered, at most
 * `maxChatWidth` wide, never closer than `padding` to either edge. Floating
 * cards place themselves in what is left; they never move or narrow the lane.
 */
export function resolveChatCanvasLayout({
  container,
  padding = 20,
  maxChatWidth = 768,
}: {
  container: ChatCanvasSize;
  padding?: number;
  maxChatWidth?: number;
}): { readonly chat: ChatLane } {
  const width = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  return { chat: { left: (container.width - width) / 2, width } };
}
