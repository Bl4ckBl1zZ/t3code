import {
  createVoicePreflightCache,
  createVoiceTranscriptStash,
  voicePreflightReady,
  VoiceInputController,
  type VoiceInputState,
  type VoiceTranscriptStashEntry,
} from "@t3tools/client-runtime/voice";
import type { VoiceTranscriptionRequest } from "@t3tools/contracts/voice";

import { toastManager } from "../components/ui/toast";
import {
  getOpenRouterIntegration,
  getVoiceInputSettings,
  transcribeVoice,
} from "../cloud/voiceInput";
import { WebVoiceCapture } from "./webVoiceCapture";

/**
 * App-scoped voice session. One lazily-created controller lives at module scope so an active
 * recording/transcription survives route changes and composer remounts; composers bind to it
 * while mounted (see useWebVoiceInput) and unbinding never cancels the session.
 *
 * Everything here is inert until the first toggle: no controller, no mic, no timers exist at
 * import time.
 */

export type VoiceCompletion = {
  readonly requestId: string;
  readonly rawText: string;
  readonly text: string;
  readonly cleanupApplied: boolean;
};

export type VoiceUnavailableReason = "sign_in" | "connect_openrouter" | "unsupported";

export type VoiceComposerBinding = {
  /** Read fresh on every completion so mid-transcription identity changes route correctly. */
  getIdentity(): string;
  onCompleted(result: VoiceCompletion): void;
};

const voicePreflight = createVoicePreflightCache({
  getIntegration: getOpenRouterIntegration,
  getSettings: getVoiceInputSettings,
});

/** Call after Voice Input settings or the OpenRouter connection change. */
export function invalidateVoicePreflight(): void {
  voicePreflight.invalidate();
}

/**
 * Warm the preflight cache so the first mic tap can open the microphone synchronously with the
 * user gesture (required on iOS Safari).
 */
export function primeVoicePreflight(): void {
  if (typeof window === "undefined") return;
  voicePreflight.prime();
}

/** Completed transcripts whose target composer was not active when transcription finished. */
const transcriptStash = createVoiceTranscriptStash();

export function takeStashedVoiceTranscript(identity: string): VoiceTranscriptStashEntry | null {
  return transcriptStash.take(identity);
}

const stateListeners = new Set<(state: VoiceInputState) => void>();
const levelListeners = new Set<(level: number) => void>();
let sessionState: VoiceInputState = { type: "idle" };
let controller: VoiceInputController | null = null;
let boundComposer: VoiceComposerBinding | null = null;
/** Composer identity the active (or last) session was started from. */
let originIdentity: string | null = null;
let lastRoutedRequestId: string | null = null;

function routeCompletion(result: VoiceCompletion): void {
  const target = originIdentity;
  const bound = boundComposer;
  if (bound !== null && target !== null && bound.getIdentity() === target) {
    bound.onCompleted(result);
    return;
  }
  if (target === null) return; // No origin recorded (should not happen); nothing to stash under.
  transcriptStash.put(target, result.text);
  toastManager.add({
    type: "info",
    title: "Voice transcript saved",
    description: "Open the conversation to insert it.",
  });
}

function ensureController(): VoiceInputController | null {
  if (typeof window === "undefined") return null;
  if (controller !== null) return controller;
  controller = new VoiceInputController({
    capture: new WebVoiceCapture(),
    client: {
      transcribe: (request, signal) =>
        transcribeVoice(request as VoiceTranscriptionRequest, signal),
    },
    onLevel: (level) => {
      for (const listener of levelListeners) listener(level);
    },
  });
  controller.subscribe((next) => {
    sessionState = next;
    if (next.type === "completed" && next.requestId !== lastRoutedRequestId) {
      lastRoutedRequestId = next.requestId;
      routeCompletion(next);
    }
    for (const listener of stateListeners) listener(next);
  });
  return controller;
}

export function getVoiceSessionState(): VoiceInputState {
  return sessionState;
}

export function subscribeVoiceSessionState(listener: (state: VoiceInputState) => void): () => void {
  stateListeners.add(listener);
  listener(sessionState);
  return () => {
    stateListeners.delete(listener);
  };
}

export function subscribeVoiceLevel(listener: (level: number) => void): () => void {
  levelListeners.add(listener);
  return () => {
    levelListeners.delete(listener);
  };
}

/**
 * Register the currently mounted composer as the completion target. The returned unbind only
 * detaches the binding — it never cancels or disposes an active session, so StrictMode
 * mount/unmount/mount cycles and route changes leave a live recording untouched.
 */
export function bindVoiceComposer(binding: VoiceComposerBinding): () => void {
  boundComposer = binding;
  return () => {
    if (boundComposer === binding) boundComposer = null;
  };
}

export async function toggleVoiceSession(input: {
  readonly identity: string;
  readonly cleanupOverride?: boolean | undefined;
  readonly onUnavailable: (reason: VoiceUnavailableReason) => void;
}): Promise<void> {
  const session = ensureController();
  if (session === null) {
    input.onUnavailable("unsupported");
    return;
  }
  if (session.state.type === "recording") {
    await session.stop();
    return;
  }
  if (
    session.state.type === "requesting_permission" ||
    session.state.type === "stopping" ||
    session.state.type === "transcribing"
  ) {
    return;
  }
  const cached = voicePreflight.read();
  if (cached && voicePreflightReady(cached)) {
    voicePreflight.prime();
    originIdentity = input.identity;
    await session.start(input.cleanupOverride ?? cached.settings.cleanup.enabled);
    return;
  }
  // A stale "not connected" snapshot must not block a user who just connected.
  voicePreflight.invalidate();
  try {
    const fresh = await voicePreflight.refresh();
    if (!voicePreflightReady(fresh)) {
      input.onUnavailable("connect_openrouter");
      return;
    }
    originIdentity = input.identity;
    await session.start(input.cleanupOverride ?? fresh.settings.cleanup.enabled);
  } catch {
    input.onUnavailable("sign_in");
  }
}

export function cancelVoiceSession(): Promise<void> {
  return controller?.cancel() ?? Promise.resolve();
}

/**
 * Retry the failed session on behalf of the composer pressing the button. Re-anchoring the
 * origin identity matters because a permission-stage retry starts a brand new recording, and a
 * transcription retry should deliver to whoever is asking for it now.
 */
export function retryVoiceSession(identity: string): Promise<boolean> {
  if (controller === null) return Promise.resolve(false);
  originIdentity = identity;
  return controller.retry();
}

export function setVoiceSessionCleanup(cleanup: boolean): boolean {
  return controller?.setRecordingCleanup(cleanup) ?? false;
}
