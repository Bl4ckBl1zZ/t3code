import {
  createVoicePreflightCache,
  voicePreflightReady,
  VoiceInputController,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";

import { MobileVoiceCapture } from "./MobileVoiceCapture";
import { getOpenRouterIntegration, getVoiceInputSettings, transcribeVoice } from "./mobileVoiceApi";

const voicePreflight = createVoicePreflightCache({
  getIntegration: getOpenRouterIntegration,
  getSettings: getVoiceInputSettings,
});

/** Call after Voice Input settings or the OpenRouter connection change. */
export function invalidateVoicePreflight(): void {
  voicePreflight.invalidate();
}

export function useMobileVoiceInput(input: {
  readonly onCompleted: (result: {
    readonly requestId: string;
    readonly rawText: string;
    readonly text: string;
    readonly cleanupApplied: boolean;
  }) => void;
  readonly onUnavailable: (reason: "sign_in" | "connect_openrouter") => void;
}) {
  const completedRef = useRef(input.onCompleted);
  completedRef.current = input.onCompleted;
  const levelListenersRef = useRef(new Set<(level: number) => void>());
  const controllerRef = useRef<VoiceInputController | null>(null);
  if (controllerRef.current === null) {
    const levelListeners = levelListenersRef.current;
    controllerRef.current = new VoiceInputController({
      capture: new MobileVoiceCapture(),
      client: {
        transcribe: (request, signal) => transcribeVoice(request, signal),
      },
      onLevel: (level) => {
        for (const listener of levelListeners) listener(level);
      },
    });
  }
  const [state, setState] = useState<VoiceInputState>({ type: "idle" });
  const completedRequestRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = controllerRef.current!;
    return controller.subscribe((next) => {
      setState(next);
      if (next.type === "completed" && completedRequestRef.current !== next.requestId) {
        completedRequestRef.current = next.requestId;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        completedRef.current(next);
      }
    });
  }, []);

  // Warm the preflight cache so the mic starts without waiting on two relay round-trips.
  useEffect(() => {
    voicePreflight.prime();
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
    },
    [],
  );

  const toggle = useCallback(async () => {
    const controller = controllerRef.current!;
    if (controller.state.type === "recording") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await controller.start(cached.settings.cleanup.enabled);
      return;
    }
    voicePreflight.invalidate();
    try {
      const fresh = await voicePreflight.refresh();
      if (!voicePreflightReady(fresh)) {
        input.onUnavailable("connect_openrouter");
        return;
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await controller.start(fresh.settings.cleanup.enabled);
    } catch {
      input.onUnavailable("sign_in");
    }
  }, [input]);

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
