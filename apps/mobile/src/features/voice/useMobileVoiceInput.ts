import { VoiceInputController, type VoiceInputState } from "@t3tools/client-runtime/voice";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";

import { MobileVoiceCapture } from "./MobileVoiceCapture";
import { getOpenRouterIntegration, getVoiceInputSettings, transcribeVoice } from "./mobileVoiceApi";

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
  const controllerRef = useRef<VoiceInputController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new VoiceInputController({
      capture: new MobileVoiceCapture(),
      client: {
        transcribe: (request) => transcribeVoice(request),
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
    try {
      const [status, settings] = await Promise.all([
        getOpenRouterIntegration(),
        getVoiceInputSettings(),
      ]);
      if (status.state !== "connected") {
        input.onUnavailable("connect_openrouter");
        return;
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await controller.start(settings.cleanup.enabled);
    } catch {
      input.onUnavailable("sign_in");
    }
  }, [input]);

  return {
    state,
    toggle,
    cancel: () => controllerRef.current?.cancel() ?? Promise.resolve(),
    retry: () => controllerRef.current?.retry() ?? Promise.resolve(false),
    setCleanup: (cleanup: boolean) => controllerRef.current?.setRecordingCleanup(cleanup) ?? false,
  };
}
