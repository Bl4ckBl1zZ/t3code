import { createContext, useContext } from "react";

import type { ChatCanvasSize, resolveChatCanvasLayout } from "./chatCanvasLayout";

export const ChatCanvasContext = createContext<{
  readonly container: ChatCanvasSize;
  readonly layout: ReturnType<typeof resolveChatCanvasLayout>;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
