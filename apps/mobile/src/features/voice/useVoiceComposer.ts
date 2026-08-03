import { useNavigation } from "@react-navigation/native";
import {
  createVoiceTranscriptStash,
  VOICE_GESTURE_DEFAULTS,
  VOICE_GESTURE_IDLE,
  voiceGestureCancelProgress,
  voiceGestureTransition,
  voiceInputErrorMessage,
  type VoiceGestureEvent,
  type VoiceGestureState,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice";
import { insertVoiceTranscript } from "@t3tools/shared/voiceInput";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useMobileVoiceInput } from "./useMobileVoiceInput";

/** Per-call-site config for the combo button gesture: what a tap does when not recording. */
export type VoiceComboButton = {
  readonly canSend: boolean;
  readonly onSend: () => void;
};

/** How long after a real touch the accessibility activate fallback stays suppressed. */
const GESTURE_ACTIVATE_SUPPRESS_MS = 500;

const GESTURE_UI_IDLE = { holdActive: false, cancelArmed: false, cancelProgress: 0 } as const;

// One app-wide stash: the mounted composer survives thread/workspace switches (only its
// identity prop changes), so a transcript that completes after a switch parks here under the
// identity it was recorded against and is inserted when that composer is active again.
const transcriptStash = createVoiceTranscriptStash();

/** Spring for the subtle press-down/spring-back scale on the gesture-driven mic buttons. */
const PRESS_SPRING = { damping: 18, stiffness: 320, reduceMotion: ReduceMotion.System } as const;
const PRESS_SCALE = 0.92;

/**
 * Shared composer glue for Voice Input: anchors the insertion point when recording starts,
 * inserts the transcript on completion (falling back to the current cursor when the draft
 * changed mid-recording), and surfaces failures.
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

  const voice = useMobileVoiceInput({
    onCompleted: (result) => {
      const current = latest.current;
      const anchor = anchorRef.current;
      if (!anchor) {
        Alert.alert("Voice transcript discarded", "The composer changed during transcription.");
        return;
      }
      if (anchor.identity !== current.identity) {
        transcriptStash.put(anchor.identity, result.text);
        Alert.alert("Voice transcript saved", "Switch back to that conversation to insert it.");
        return;
      }
      const useFallback = current.draft !== anchor.draft;
      const range = useFallback
        ? { start: current.selection.end, end: current.selection.end }
        : anchor.selection;
      const insertion = insertVoiceTranscript({
        draft: current.draft,
        range,
        cleanedText: result.text,
      });
      current.setDraft(insertion.text);
      current.setSelection({ start: insertion.caret, end: insertion.caret });
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

  // Deliver any stashed transcript for this identity once the composer settles on it (mount or
  // switch back). Runs after render, so latest.current already holds the new identity's draft
  // and this never fights an in-flight gesture on the old composer.
  const identity = input.identity;
  useEffect(() => {
    const entry = transcriptStash.take(identity);
    if (!entry) return;
    const current = latest.current;
    const insertion = insertVoiceTranscript({
      draft: current.draft,
      range: current.selection,
      cleanedText: entry.text,
    });
    current.setDraft(insertion.text);
    current.setSelection({ start: insertion.caret, end: insertion.caret });
    requestAnimationFrame(() => latest.current.focusAt(insertion.caret));
  }, [identity]);

  const toggle = useCallback(() => {
    // Capture the anchor on start as well as on manual stop: a recording that stops on its own
    // (duration cap, interruption) still needs an insertion point for the transcript.
    const current = latest.current;
    anchorRef.current = {
      draft: current.draft,
      selection: current.selection,
      identity: current.identity,
    };
    void voice.toggle();
  }, [voice]);

  // Combined send/record button gesture, driven by the shared press/move/release machine.
  // Tap: send when the draft has content, start hands-free recording when it's empty, stop when
  // recording. Hold (300ms): push-to-talk — releasing stops + transcribes, sliding up 72pt
  // cancels, releasing under 700ms discards the graze. If the finger lifts before the async
  // start reaches "recording" (permission prompt, preflight), the release is remembered and the
  // recording stops as soon as startup completes.
  const voiceStateRef = useRef(voice.state);
  voiceStateRef.current = voice.state;
  const stopOnRecordingRef = useRef(false);
  const voiceStateType = voice.state.type;
  useEffect(() => {
    if (voiceStateType === "recording") {
      if (!stopOnRecordingRef.current) return;
      stopOnRecordingRef.current = false;
      toggle();
      return;
    }
    // Startup failed or was cancelled before reaching "recording": nothing left to stop.
    if (voiceStateType !== "requesting_permission") stopOnRecordingRef.current = false;
  }, [voiceStateType, toggle]);

  const gestureStateRef = useRef<VoiceGestureState>(VOICE_GESTURE_IDLE);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the current hold started the recording itself (vs grabbing one that was already
  // running hands-free): decides if a too-short release discards or just stops.
  const holdOwnsSessionRef = useRef(false);
  const lastGestureTouchAtRef = useRef(0);
  const [gestureUi, setGestureUi] = useState<{
    readonly holdActive: boolean;
    readonly cancelArmed: boolean;
    readonly cancelProgress: number;
  }>(GESTURE_UI_IDLE);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);
  useEffect(() => clearHoldTimer, [clearHoldTimer]);

  // Subtle press feedback for the gesture-driven buttons: the manual gesture claims real
  // touches (cancelling the Pressable's own pressed state), so the scale rides the same
  // touch events. Skipped entirely under reduced motion.
  const reducedMotion = useReducedMotion();
  const pressScale = useSharedValue(1);
  const comboPressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
  }));

  const voiceCancel = voice.cancel;
  const dispatchGesture = useCallback(
    (event: VoiceGestureEvent, button: VoiceComboButton) => {
      const { state, effects } = voiceGestureTransition(gestureStateRef.current, event);
      gestureStateRef.current = state;
      if (state.type === "idle") clearHoldTimer();
      for (const effect of effects) {
        switch (effect.type) {
          case "tap": {
            stopOnRecordingRef.current = false;
            if (voiceStateRef.current.type === "recording") {
              toggle();
              break;
            }
            if (button.canSend) {
              button.onSend();
              break;
            }
            toggle();
            break;
          }
          case "hold_classified": {
            // "completed" is a resting state: the controller stays in it after a transcription
            // finishes (nothing resets it to idle), and start() accepts it just like
            // idle/failed. Excluding it here left hold-to-record dead after the first
            // successful dictation.
            const stateType = voiceStateRef.current.type;
            holdOwnsSessionRef.current =
              stateType === "idle" || stateType === "failed" || stateType === "completed";
            if (!holdOwnsSessionRef.current) break;
            stopOnRecordingRef.current = false;
            toggle();
            break;
          }
          case "stop_and_transcribe": {
            if (voiceStateRef.current.type === "recording") {
              toggle();
              break;
            }
            // Startup (preflight / permission prompt) hasn't reached "recording" yet: remember
            // the release so the effect above stops the recording the moment it starts. From
            // any settled state (auto-stop at the cap, failure) the flag is cleared again by
            // that same effect and this is a no-op.
            stopOnRecordingRef.current = true;
            break;
          }
          case "cancel_recording": {
            stopOnRecordingRef.current = false;
            if (!holdOwnsSessionRef.current && effect.reason !== "swipe") {
              // The hold grabbed a session it didn't start (hands-free recording already
              // running): a short release means "stop", and a system-cancelled gesture must
              // not kill the recording. Only a deliberate slide-up cancels it.
              if (effect.reason === "too_short" && voiceStateRef.current.type === "recording") {
                toggle();
              }
              break;
            }
            if (effect.reason === "too_short") {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
            void voiceCancel();
            break;
          }
          case "cancel_armed_changed": {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            break;
          }
        }
      }
      // Quantized to 5% steps so finger movement re-renders at most 20 times per hold instead
      // of on every move event.
      const holdActive = state.type === "holding";
      const cancelArmed = state.type === "holding" && state.cancelArmed;
      const cancelProgress = Math.round(voiceGestureCancelProgress(state) * 20) / 20;
      setGestureUi((previous) =>
        previous.holdActive === holdActive &&
        previous.cancelArmed === cancelArmed &&
        previous.cancelProgress === cancelProgress
          ? previous
          : { holdActive, cancelArmed, cancelProgress },
      );
    },
    [clearHoldTimer, toggle, voiceCancel],
  );

  // Manual gesture instead of Pressable handlers: press classification and slide-up cancel need
  // touch-down, absolute-Y moves, and release/cancellation, and activating on touch-down keeps
  // enclosing recognizers (sheet drag, scroll) from stealing the hold mid-recording.
  const comboGesture = useCallback(
    (button: VoiceComboButton) =>
      Gesture.Manual()
        .runOnJS(true)
        .shouldCancelWhenOutside(false)
        .onTouchesDown((event, manager) => {
          const touch = event.allTouches[0];
          if (!touch) return;
          if (!reducedMotion) pressScale.value = withSpring(PRESS_SCALE, PRESS_SPRING);
          lastGestureTouchAtRef.current = Date.now();
          dispatchGesture({ type: "press", at: Date.now(), y: touch.absoluteY }, button);
          if (gestureStateRef.current.type === "pressing") {
            clearHoldTimer();
            holdTimerRef.current = setTimeout(() => {
              holdTimerRef.current = null;
              dispatchGesture({ type: "hold_elapsed" }, button);
            }, VOICE_GESTURE_DEFAULTS.holdClassifyMs);
          }
          manager.activate();
        })
        .onTouchesMove((event) => {
          const touch = event.allTouches[0];
          if (!touch) return;
          dispatchGesture({ type: "move", y: touch.absoluteY }, button);
        })
        .onTouchesUp((event, manager) => {
          if (event.numberOfTouches > 0) return;
          pressScale.value = withSpring(1, PRESS_SPRING);
          lastGestureTouchAtRef.current = Date.now();
          dispatchGesture({ type: "release", at: Date.now() }, button);
          manager.end();
        })
        .onTouchesCancelled((_event, manager) => {
          pressScale.value = withSpring(1, PRESS_SPRING);
          if (gestureStateRef.current.type !== "idle") {
            dispatchGesture({ type: "interrupt" }, button);
          }
          manager.fail();
        }),
    [clearHoldTimer, dispatchGesture, pressScale, reducedMotion],
  );

  // Plain activation path for screen readers (VoiceOver/TalkBack fire the Pressable's onPress
  // without real touches). Real touches are claimed by the gesture, which cancels the
  // Pressable; the timestamp guard covers platforms where that cancellation is late.
  const comboActivate = useCallback(
    (button: VoiceComboButton) => {
      if (Date.now() - lastGestureTouchAtRef.current < GESTURE_ACTIVATE_SUPPRESS_MS) return;
      stopOnRecordingRef.current = false;
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
    [toggle],
  );

  const voiceState = voice.state;
  const voiceRetry = voice.retry;
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
      } else {
        Alert.alert("Microphone access needed", "Allow microphone access to use Voice Input.", [
          { text: "Cancel", style: "cancel" },
          // retry() restarts the whole flow for a retryable permission failure, matching web.
          { text: "Try again", onPress: () => void voiceRetry() },
        ]);
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

  const busy =
    voice.state.type === "requesting_permission" ||
    voice.state.type === "recording" ||
    voice.state.type === "stopping" ||
    voice.state.type === "transcribing";

  return {
    state: voice.state,
    busy,
    toggle,
    comboGesture,
    comboActivate,
    comboPressStyle,
    holdActive: gestureUi.holdActive,
    cancelArmed: gestureUi.cancelArmed,
    cancelProgress: gestureUi.cancelProgress,
    cancel: voice.cancel,
    retry: voice.retry,
    setCleanup: voice.setCleanup,
    subscribeLevel: voice.subscribeLevel,
  };
}
