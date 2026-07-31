import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_VOICE_INPUT_SETTINGS } from "@t3tools/contracts/voice";

import { createVoicePreflightCache, voicePreflightReady } from "./preflight.ts";

function fixture(options?: {
  readonly state?: "connected" | "invalid";
  readonly now?: () => number;
}) {
  const getIntegration = vi.fn(async () => ({
    configured: true,
    state: options?.state ?? ("connected" as const),
  }));
  const getSettings = vi.fn(async () => DEFAULT_VOICE_INPUT_SETTINGS);
  const cache = createVoicePreflightCache({
    getIntegration,
    getSettings,
    ttlMs: 1_000,
    ...(options?.now ? { now: options.now } : {}),
  });
  return { cache, getIntegration, getSettings };
}

describe("createVoicePreflightCache", () => {
  it("returns null before the first refresh and a snapshot after", async () => {
    const { cache } = fixture();
    expect(cache.read()).toBeNull();
    const snapshot = await cache.refresh();
    expect(voicePreflightReady(snapshot)).toBe(true);
    expect(cache.read()).toBe(snapshot);
  });

  it("expires snapshots after the TTL", async () => {
    let now = 0;
    const { cache } = fixture({ now: () => now });
    await cache.refresh();
    now = 999;
    expect(cache.read()).not.toBeNull();
    now = 1_000;
    expect(cache.read()).toBeNull();
  });

  it("coalesces concurrent refreshes into one fetch", async () => {
    const { cache, getIntegration } = fixture();
    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
    expect(getIntegration).toHaveBeenCalledOnce();
  });

  it("invalidate clears the snapshot", async () => {
    const { cache } = fixture();
    await cache.refresh();
    cache.invalidate();
    expect(cache.read()).toBeNull();
  });

  it("prime swallows failures", async () => {
    const { cache, getIntegration } = fixture();
    getIntegration.mockRejectedValueOnce(new Error("signed out"));
    cache.prime();
    await vi.waitFor(() => expect(getIntegration).toHaveBeenCalledOnce());
    expect(cache.read()).toBeNull();
  });

  it("reports unconfigured integrations as not ready", async () => {
    const { cache } = fixture({ state: "invalid" });
    const snapshot = await cache.refresh();
    expect(voicePreflightReady(snapshot)).toBe(false);
  });
});
