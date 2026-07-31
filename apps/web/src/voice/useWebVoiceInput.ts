import {
  createVoicePreflightCache,
  voicePreflightReady,
  VoiceInputController,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice";
import type { VoiceTranscriptionRequest } from "@t3tools/contracts/voice";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getOpenRouterIntegration,
  getVoiceInputSettings,
  transcribeVoice,
} from "../cloud/voiceInput";
import { WebVoiceCapture } from "./webVoiceCapture";

const voicePreflight = createVoicePreflightCache({
  getIntegration: getOpenRouterIntegration,
  getSettings: getVoiceInputSettings,
});

/** Call after Voice Input settings or the OpenRouter connection change. */
export function invalidateVoicePreflight(): void {
  voicePreflight.invalidate();
}

export function useWebVoiceInput(input: {
  readonly onCompleted: (result: {
    readonly requestId: string;
    readonly rawText: string;
    readonly text: string;
    readonly cleanupApplied: boolean;
  }) => void;
  readonly onUnavailable: (reason: "sign_in" | "connect_openrouter" | "unsupported") => void;
}) {
  const completedRef = useRef(input.onCompleted);
  completedRef.current = input.onCompleted;
  const levelListenersRef = useRef(new Set<(level: number) => void>());
  const controllerRef = useRef<VoiceInputController | null>(null);
  if (controllerRef.current === null && typeof window !== "undefined") {
    const levelListeners = levelListenersRef.current;
    controllerRef.current = new VoiceInputController({
      capture: new WebVoiceCapture(),
      client: {
        transcribe: (request, signal) =>
          transcribeVoice(request as VoiceTranscriptionRequest, signal),
      },
      onLevel: (level) => {
        for (const listener of levelListeners) listener(level);
      },
    });
  }
  const [state, setState] = useState<VoiceInputState>({ type: "idle" });
  const lastCompletedRequestRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    return controller.subscribe((next) => {
      setState(next);
      if (next.type === "completed" && lastCompletedRequestRef.current !== next.requestId) {
        lastCompletedRequestRef.current = next.requestId;
        completedRef.current(next);
      }
    });
  }, []);

  // Warm the preflight cache so the first mic tap can open the microphone synchronously with
  // the user gesture (required on iOS Safari).
  useEffect(() => {
    if (controllerRef.current) voicePreflight.prime();
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
    },
    [],
  );

  const toggle = useCallback(
    async (cleanupOverride?: boolean) => {
      const controller = controllerRef.current;
      if (!controller) {
        input.onUnavailable("unsupported");
        return;
      }
      if (controller.state.type === "recording") {
        await controller.stop();
        return;
      }
      if (
        controller.state.type === "requesting_permission" ||
        controller.state.type === "stopping" ||
        controller.state.type === "transcribing"
      ) {
        return;
      }
      const cached = voicePreflight.read();
      if (cached && voicePreflightReady(cached)) {
        voicePreflight.prime();
        await controller.start(cleanupOverride ?? cached.settings.cleanup.enabled);
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
        await controller.start(cleanupOverride ?? fresh.settings.cleanup.enabled);
      } catch {
        input.onUnavailable("sign_in");
      }
    },
    [input],
  );

  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    levelListenersRef.current.add(listener);
    return () => {
      levelListenersRef.current.delete(listener);
    };
  }, []);

  return {
    state,
    toggle,
    subscribeLevel,
    cancel: () => controllerRef.current?.cancel() ?? Promise.resolve(),
    retry: () => controllerRef.current?.retry() ?? Promise.resolve(false),
    setCleanup: (cleanup: boolean) => controllerRef.current?.setRecordingCleanup(cleanup) ?? false,
  };
}
