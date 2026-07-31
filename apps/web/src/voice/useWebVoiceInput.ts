import { VoiceInputController, type VoiceInputState } from "@t3tools/client-runtime/voice";
import type { VoiceTranscriptionRequest } from "@t3tools/contracts/voice";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getOpenRouterIntegration,
  getVoiceInputSettings,
  transcribeVoice,
} from "../cloud/voiceInput";
import { WebVoiceCapture } from "./webVoiceCapture";

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
  const controllerRef = useRef<VoiceInputController | null>(null);
  if (controllerRef.current === null && typeof window !== "undefined") {
    controllerRef.current = new VoiceInputController({
      capture: new WebVoiceCapture(),
      client: {
        transcribe: (request, signal) =>
          transcribeVoice(request as VoiceTranscriptionRequest, signal),
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
      try {
        const [status, settings] = await Promise.all([
          getOpenRouterIntegration(),
          getVoiceInputSettings(),
        ]);
        if (!status.configured || status.state !== "connected") {
          input.onUnavailable("connect_openrouter");
          return;
        }
        await controller.start(cleanupOverride ?? settings.cleanup.enabled);
      } catch {
        input.onUnavailable("sign_in");
      }
    },
    [input],
  );

  return {
    state,
    toggle,
    cancel: () => controllerRef.current?.cancel() ?? Promise.resolve(),
    retry: () => controllerRef.current?.retry() ?? Promise.resolve(false),
    setCleanup: (cleanup: boolean) => controllerRef.current?.setRecordingCleanup(cleanup) ?? false,
  };
}
