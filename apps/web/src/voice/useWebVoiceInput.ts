import { type VoiceInputState } from "@t3tools/client-runtime/voice";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  bindVoiceComposer,
  cancelVoiceSession,
  getVoiceSessionState,
  primeVoicePreflight,
  retryVoiceSession,
  setVoiceSessionCleanup,
  subscribeVoiceLevel,
  subscribeVoiceSessionState,
  toggleVoiceSession,
  type VoiceCompletion,
  type VoiceUnavailableReason,
} from "./webVoiceSession";

export { invalidateVoicePreflight } from "./webVoiceSession";

/**
 * Binder onto the app-scoped voice session (webVoiceSession.ts). The hook subscribes to the
 * singleton's state/level and registers this composer as the completion target while mounted.
 * Unmounting only unsubscribes — an active recording or transcription keeps running, so
 * navigating away from the chat route no longer drops audio.
 */
export function useWebVoiceInput(input: {
  readonly identity: string;
  readonly onCompleted: (result: VoiceCompletion) => void;
  readonly onUnavailable: (reason: VoiceUnavailableReason) => void;
}) {
  // Latest-props ref: the session routes through stable callbacks that always read the current
  // identity and handlers, so binding once per mount is safe even as the composer re-renders.
  const inputRef = useRef(input);
  inputRef.current = input;

  const [state, setState] = useState<VoiceInputState>(getVoiceSessionState);
  useEffect(() => subscribeVoiceSessionState(setState), []);
  useEffect(
    () =>
      bindVoiceComposer({
        getIdentity: () => inputRef.current.identity,
        onCompleted: (result) => inputRef.current.onCompleted(result),
      }),
    [],
  );
  useEffect(() => {
    primeVoicePreflight();
  }, []);

  const toggle = useCallback(
    (cleanupOverride?: boolean) =>
      toggleVoiceSession({
        identity: inputRef.current.identity,
        cleanupOverride,
        onUnavailable: (reason) => inputRef.current.onUnavailable(reason),
      }),
    [],
  );

  const retry = useCallback(() => retryVoiceSession(inputRef.current.identity), []);

  return {
    state,
    toggle,
    subscribeLevel: subscribeVoiceLevel,
    cancel: cancelVoiceSession,
    retry,
    setCleanup: setVoiceSessionCleanup,
  };
}
