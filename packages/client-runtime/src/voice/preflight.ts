import type { OpenRouterIntegrationStatus, VoiceInputSettings } from "@t3tools/contracts/voice";

export type VoicePreflightSnapshot = {
  readonly status: OpenRouterIntegrationStatus;
  readonly settings: VoiceInputSettings;
  readonly fetchedAt: number;
};

export type VoicePreflightCache = {
  /** Returns the snapshot when it is still within the TTL, otherwise null. */
  read(): VoicePreflightSnapshot | null;
  refresh(): Promise<VoicePreflightSnapshot>;
  /** Fire-and-forget refresh; failures (e.g. signed out) are swallowed. */
  prime(): void;
  invalidate(): void;
};

/**
 * Caches the integration + settings preflight so tapping the mic can open the microphone
 * immediately. iOS Safari only honors getUserMedia inside a user gesture, so awaiting two relay
 * round-trips between the tap and the permission request breaks recording there entirely.
 */
export function createVoicePreflightCache(input: {
  readonly getIntegration: () => Promise<OpenRouterIntegrationStatus>;
  readonly getSettings: () => Promise<VoiceInputSettings>;
  readonly ttlMs?: number;
  readonly now?: () => number;
}): VoicePreflightCache {
  const ttlMs = input.ttlMs ?? 60_000;
  const now = input.now ?? Date.now;
  let snapshot: VoicePreflightSnapshot | null = null;
  let pending: Promise<VoicePreflightSnapshot> | null = null;

  const refresh = (): Promise<VoicePreflightSnapshot> => {
    if (pending) return pending;
    pending = Promise.all([input.getIntegration(), input.getSettings()])
      .then(([status, settings]) => {
        snapshot = { status, settings, fetchedAt: now() };
        return snapshot;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    read: () => (snapshot !== null && now() - snapshot.fetchedAt < ttlMs ? snapshot : null),
    refresh,
    prime: () => {
      void refresh().catch(() => undefined);
    },
    invalidate: () => {
      snapshot = null;
    },
  };
}

export function voicePreflightReady(snapshot: VoicePreflightSnapshot): boolean {
  return snapshot.status.configured && snapshot.status.state === "connected";
}
