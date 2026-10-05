import { createContext, useContext } from "react";

import type {
  ChatCanvasDetailsCard,
  ChatCanvasSize,
  resolveChatCanvasLayout,
} from "./chatCanvasLayout";

export const ChatCanvasContext = createContext<{
  readonly container: ChatCanvasSize;
  readonly lane: { readonly padding: number; readonly minChatWidth: number };
  readonly layout: ReturnType<typeof resolveChatCanvasLayout>;
  /** The docked workspace card reports where it sits, or null when it is not docked. */
  readonly reportDetailsCard: (card: ChatCanvasDetailsCard | null) => void;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
