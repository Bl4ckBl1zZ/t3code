import { describe, expect, it } from "vite-plus/test";

import { resolveComposerDispatchMode } from "./composerDispatch";

describe("resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ phase: "ready", alternateModifier: false })).toBe("auto");
  });

  it("queues by default and reserves Mod+Enter for steering while running", () => {
    expect(resolveComposerDispatchMode({ phase: "running", alternateModifier: false })).toBe(
      "queue",
    );
    expect(resolveComposerDispatchMode({ phase: "running", alternateModifier: true })).toBe(
      "steer",
    );
  });

  it("swaps the shortcut to queueing when steering is the default", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        alternateModifier: false,
        activeTurnDefault: "steer",
      }),
    ).toBe("steer");
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        alternateModifier: true,
        activeTurnDefault: "steer",
      }),
    ).toBe("queue");
  });

  it("accepts a configured default without changing the steer shortcut", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        alternateModifier: false,
        activeTurnDefault: "restart",
      }),
    ).toBe("restart");
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        alternateModifier: true,
        activeTurnDefault: "restart",
      }),
    ).toBe("steer");
  });
});
