import { useNavigation } from "@react-navigation/native";
import { voiceInputErrorMessage, type VoiceInputState } from "@t3tools/client-runtime/voice";
import {
  insertVoiceTranscript,
  replaceVoiceInsertionWithRaw,
  undoVoiceInsertion,
  type VoiceInsertionRecovery,
} from "@t3tools/shared/voiceInput";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking } from "react-native";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useMobileVoiceInput } from "./useMobileVoiceInput";

/**
 * Shared composer glue for Voice Input: anchors the insertion point when recording starts,
 * inserts the transcript on completion (falling back to the current cursor when the draft
 * changed mid-recording), owns the raw/undo recovery affordance, and surfaces failures.
 */
export function useVoiceComposer(input: {
  /** Guards against inserting into a different draft than the one recorded against. */
  readonly identity: string;
  readonly draft: string;
  readonly selection: ComposerEditorSelection;
  readonly setDraft: (text: string) => void;
  readonly setSelection: (selection: ComposerEditorSelection) => void;
  readonly focusAt: (caret: number) => void;
}) {
  const navigation = useNavigation();
  const latest = useRef(input);
  latest.current = input;
  const anchorRef = useRef<{
    readonly draft: string;
    readonly selection: ComposerEditorSelection;
    readonly identity: string;
  } | null>(null);
  const [recovery, setRecovery] = useState<VoiceInsertionRecovery | null>(null);

  const voice = useMobileVoiceInput({
    onCompleted: (result) => {
      const current = latest.current;
      const anchor = anchorRef.current;
      if (!anchor || anchor.identity !== current.identity) {
        Alert.alert("Voice transcript discarded", "The composer changed during transcription.");
        return;
      }
      const useFallback = current.draft !== anchor.draft;
      const range = useFallback
        ? { start: current.selection.end, end: current.selection.end }
        : anchor.selection;
      const insertion = insertVoiceTranscript({
        draft: current.draft,
        range,
        rawText: result.rawText,
        cleanedText: result.text,
      });
      current.setDraft(insertion.text);
      current.setSelection({ start: insertion.caret, end: insertion.caret });
      setRecovery(insertion.recovery);
      requestAnimationFrame(() => latest.current.focusAt(insertion.caret));
    },
    onUnavailable: (reason) => {
      if (reason === "connect_openrouter") {
        navigation.navigate("SettingsSheet", { screen: "SettingsOpenRouter" });
      } else {
        Alert.alert("Sign in to use voice input");
      }
    },
  });

  const toggle = useCallback(() => {
    // Capture the anchor on start as well as on manual stop: a recording that stops on its own
    // (duration cap, interruption) still needs an insertion point for the transcript.
    const current = latest.current;
    anchorRef.current = {
      draft: current.draft,
      selection: current.selection,
      identity: current.identity,
    };
    if (voice.state.type !== "recording") setRecovery(null);
    void voice.toggle();
  }, [voice]);

  // Combined send/record button gesture. Tap: send when the draft has content, start recording
  // when it's empty, stop when recording. Hold: always records — even over a non-empty draft —
  // and releasing stops + transcribes. If the finger lifts before the async start reaches
  // "recording" (permission prompt, preflight), the recording keeps going and a tap stops it —
  // stopping mid-start would capture nothing.
  const voiceStateRef = useRef(voice.state);
  voiceStateRef.current = voice.state;
  const holdRef = useRef(false);
  const comboPressProps = useCallback(
    (button: { readonly canSend: boolean; readonly onSend: () => void }) =>
      ({
        delayLongPress: 200,
        onPress: () => {
          if (holdRef.current) return;
          if (voiceStateRef.current.type === "recording") {
            toggle();
            return;
          }
          if (button.canSend) {
            button.onSend();
            return;
          }
          toggle();
        },
        onLongPress: () => {
          if (voiceStateRef.current.type !== "idle" && voiceStateRef.current.type !== "failed") {
            return;
          }
          holdRef.current = true;
          toggle();
        },
        onPressOut: () => {
          if (!holdRef.current) return;
          holdRef.current = false;
          if (voiceStateRef.current.type === "recording") toggle();
        },
      }) as const,
    [toggle],
  );

  const voiceState = voice.state;
  const voiceRetry = voice.retry;
  const voiceCancel = voice.cancel;
  // One alert per failure: without this guard, any effect re-run while the state is still
  // "failed" (re-renders churning dependency identities) stacks duplicate alerts.
  const alertedFailureRef = useRef<VoiceInputState | null>(null);
  useEffect(() => {
    if (voiceState.type !== "failed") {
      alertedFailureRef.current = null;
      return;
    }
    if (alertedFailureRef.current === voiceState) return;
    alertedFailureRef.current = voiceState;
    if (voiceState.stage === "permission") {
      if (voiceState.error.permanent) {
        Alert.alert(
          "Microphone permission required",
          "Enable microphone access in system settings to use Voice Input.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
      }
      return;
    }
    const message = voiceInputErrorMessage(voiceState.error);
    if (voiceState.canRetry) {
      Alert.alert("Voice input failed", message, [
        { text: "Discard", style: "cancel", onPress: () => void voiceCancel() },
        { text: "Retry", onPress: () => void voiceRetry() },
      ]);
    } else {
      Alert.alert("Voice input failed", message);
    }
  }, [voiceState, voiceCancel, voiceRetry]);

  const useRaw = useCallback(() => {
    if (!recovery) return;
    const current = latest.current;
    const replacement = replaceVoiceInsertionWithRaw(current.draft, recovery);
    if (!replacement) {
      setRecovery(null);
      return;
    }
    current.setDraft(replacement.text);
    current.setSelection({ start: replacement.caret, end: replacement.caret });
    setRecovery(replacement.recovery);
  }, [recovery]);

  // Stable identity: the recovery chip's auto-dismiss timer effect-depends on this.
  const clearRecovery = useCallback(() => setRecovery(null), []);

  const undo = useCallback(() => {
    if (!recovery) return;
    const current = latest.current;
    const undone = undoVoiceInsertion(current.draft, recovery);
    setRecovery(null);
    if (!undone) return;
    current.setDraft(undone.text);
    current.setSelection({ start: undone.caret, end: undone.caret });
  }, [recovery]);

  const busy =
    voice.state.type === "requesting_permission" ||
    voice.state.type === "recording" ||
    voice.state.type === "stopping" ||
    voice.state.type === "transcribing";

  return {
    state: voice.state,
    busy,
    toggle,
    comboPressProps,
    cancel: voice.cancel,
    retry: voice.retry,
    setCleanup: voice.setCleanup,
    subscribeLevel: voice.subscribeLevel,
    recovery,
    clearRecovery,
    useRaw,
    undo,
  };
}
