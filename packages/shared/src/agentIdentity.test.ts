import { describe, expect, it } from "vite-plus/test";

import { agentHue } from "./agentIdentity.ts";

describe("agentHue", () => {
  it("is deterministic for the same seed", () => {
    expect(agentHue("thread-abc")).toBe(agentHue("thread-abc"));
  });

  it("stays within the hue circle", () => {
    for (const seed of ["", "a", "thread-1", "node:delegated-task:command%3Amcp%3A74c7782a"]) {
      const hue = agentHue(seed);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it("spreads nearby seeds across different hues", () => {
    const hues = new Set([agentHue("thread-1"), agentHue("thread-2"), agentHue("thread-3")]);
    expect(hues.size).toBeGreaterThan(1);
  });
});
