import { describe, expect, it } from "vite-plus/test";

import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

describe("chat canvas layout", () => {
  it("centers chat in the whole container", () => {
    expect(resolveChatCanvasLayout({ container: { width: 1344, height: 900 } }).chat).toEqual({
      left: 288,
      width: 768,
      insetEnd: 0,
    });
  });

  it("keeps the padding on narrow containers instead of overflowing", () => {
    expect(
      resolveChatCanvasLayout({ container: { width: 390, height: 900 }, padding: 12 }).chat,
    ).toEqual({
      left: 12,
      width: 366,
      insetEnd: 0,
    });
    expect(resolveChatCanvasLayout({ container: { width: 0, height: 0 } }).chat.width).toBe(0);
  });
});

describe("workspace card beside chat", () => {
  const withCard = (width: number, maxChatWidth = 736) =>
    resolveChatCanvasLayout({
      container: { width, height: 900 },
      maxChatWidth,
      detailsCard: { left: width - 292 },
    });
  it("keeps chat centered while the card fits beside it", () => {
    expect(withCard(1384).chat).toEqual({ left: 324, width: 736, insetEnd: 0 });
  });
  it("moves chat left only as far as the card requires", () => {
    expect(withCard(1383).chat).toEqual({ left: 323, width: 736, insetEnd: 1 });
    expect(withCard(1147).chat).toEqual({ left: 87, width: 736, insetEnd: 237 });
  });
  it("narrows chat only after it reaches the left padding", () => {
    expect(withCard(1108).chat).toMatchObject({ left: 48, width: 736 });
    expect(withCard(1028).chat).toEqual({ left: 48, width: 656, insetEnd: 276 });
    expect(withCard(1012).chat).toMatchObject({ left: 48, width: 640 });
  });
  it("reserves the marker gutter across widths where the details card fits", () => {
    for (let width = 1012; width <= 1440; width++) {
      const card = resolveThreadDetailsCardLayout({
        container: { width, height: 900 },
        lane: { padding: 48, minChatWidth: 640 },
      })!;
      const chat = resolveChatCanvasLayout({
        container: { width, height: 900 },
        maxChatWidth: 736,
        detailsCard: { left: card.x },
      }).chat;
      expect(chat.left).toBeGreaterThanOrEqual(48);
      expect(chat.width).toBeGreaterThanOrEqual(640);
      expect(card.x - chat.left - chat.width).toBeGreaterThanOrEqual(32);
    }
  });
  it("keeps a full-width chat clear of the card", () => {
    expect(withCard(1147, 10_000).chat).toEqual({ left: 48, width: 775, insetEnd: 276 });
  });
  it("recenters chat once the card is no longer docked", () => {
    expect(
      resolveChatCanvasLayout({ container: { width: 1147, height: 900 }, maxChatWidth: 736 }).chat,
    ).toEqual({ left: 205.5, width: 736, insetEnd: 0 });
  });
});
