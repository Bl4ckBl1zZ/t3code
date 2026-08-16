import { describe, expect, it } from "vite-plus/test";

import { resolveComposerDispatchMode } from "./composerDispatch";

describe("resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ phase: "ready", steerModifier: false })).toBe("auto");
  });

  it("queues by default and reserves Mod+Enter for steering while running", () => {
    expect(resolveComposerDispatchMode({ phase: "running", steerModifier: false })).toBe("queue");
    expect(resolveComposerDispatchMode({ phase: "running", steerModifier: true })).toBe("steer");
  });

  it("accepts a configured default without changing the steer shortcut", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        steerModifier: false,
        activeTurnDefault: "restart",
      }),
    ).toBe("restart");
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        steerModifier: true,
        activeTurnDefault: "restart",
      }),
    ).toBe("steer");
  });
});
