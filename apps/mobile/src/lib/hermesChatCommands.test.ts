import { describe, expect, it } from "vite-plus/test";

import {
  isHermesClearChatCommand,
  isHermesFreshChatCommand,
  resolveHermesChatCommand,
} from "./hermesChatCommands";

describe("hermes chat commands", () => {
  it("intercepts the bare fresh-chat commands in a Hermes conversation", () => {
    for (const text of ["/new", "/reset", "  /NEW  ", "/Reset"]) {
      expect(isHermesFreshChatCommand({ text, isHermesConversation: true })).toBe(true);
    }
  });

  it("treats a command with trailing text as a real message", () => {
    // Swallowing this would silently discard "plan the week".
    for (const text of ["/new plan the week", "/reset now", "please /new"]) {
      expect(isHermesFreshChatCommand({ text, isHermesConversation: true })).toBe(false);
      expect(resolveHermesChatCommand({ text, isHermesConversation: true })).toBeNull();
    }
  });

  it("intercepts /clear only in a Hermes conversation", () => {
    expect(isHermesClearChatCommand({ text: "/clear", isHermesConversation: true })).toBe(true);
    expect(isHermesClearChatCommand({ text: "/clear", isHermesConversation: false })).toBe(false);
  });

  it("never intercepts anything in a Code conversation", () => {
    for (const text of ["/new", "/reset", "/clear"]) {
      expect(resolveHermesChatCommand({ text, isHermesConversation: false })).toBeNull();
    }
  });

  it("resolves each command kind", () => {
    expect(resolveHermesChatCommand({ text: "/new", isHermesConversation: true })).toBe(
      "fresh-chat",
    );
    expect(resolveHermesChatCommand({ text: "/clear", isHermesConversation: true })).toBe(
      "clear-timeline",
    );
    expect(resolveHermesChatCommand({ text: "hello", isHermesConversation: true })).toBeNull();
  });
});
