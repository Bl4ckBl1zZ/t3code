/**
 * Pure press/move/release state machine for the voice combo button gesture, shared by the web
 * and mobile composers so both classify taps, holds, and slide-up cancels identically.
 *
 * The platform layer owns pointers and timers: it forwards `press`/`move`/`release`/`interrupt`
 * events, schedules one timer for `hold_elapsed` at `holdClassifyMs` after the press, and maps
 * the returned effects onto the `VoiceInputController` (tap → toggle hands-free or send,
 * hold_classified → push-to-talk, stop/cancel → controller.stop()/cancel()).
 */

export type VoiceGestureConfig = {
  /** Press shorter than this is a tap; reaching it classifies the press as a hold. */
  readonly holdClassifyMs: number;
  /** A hold released before this (from press) is an accidental graze: discard, never transcribe. */
  readonly tooShortMs: number;
  /** Upward travel (points) that arms slide-to-cancel. */
  readonly cancelDistance: number;
  /** Travel must drop this far back below `cancelDistance` to disarm again. */
  readonly cancelHysteresis: number;
};

export const VOICE_GESTURE_DEFAULTS: VoiceGestureConfig = {
  holdClassifyMs: 300,
  tooShortMs: 700,
  cancelDistance: 72,
  cancelHysteresis: 16,
};

export type VoiceGestureState =
  | { readonly type: "idle" }
  | { readonly type: "pressing"; readonly pressedAt: number; readonly startY: number }
  | {
      readonly type: "holding";
      readonly pressedAt: number;
      readonly startY: number;
      /** Upward travel from the press point, never negative. */
      readonly travel: number;
      readonly cancelArmed: boolean;
    };

export type VoiceGestureEvent =
  | { readonly type: "press"; readonly at: number; readonly y: number }
  | { readonly type: "move"; readonly y: number }
  | { readonly type: "hold_elapsed" }
  | { readonly type: "release"; readonly at: number }
  | { readonly type: "interrupt" };

export type VoiceGestureEffect =
  /** Released before the hold threshold: send when the draft has text, else toggle hands-free. */
  | { readonly type: "tap" }
  /** The press is now a push-to-talk hold; start capture if it wasn't started eagerly. */
  | { readonly type: "hold_classified" }
  | { readonly type: "stop_and_transcribe" }
  | {
      readonly type: "cancel_recording";
      readonly reason: "swipe" | "too_short" | "interrupted";
    }
  /** Crossing (or leaving) the slide-up cancel zone; drive the HUD + a haptic tick. */
  | { readonly type: "cancel_armed_changed"; readonly armed: boolean };

export const VOICE_GESTURE_IDLE: VoiceGestureState = { type: "idle" };

export function voiceGestureTransition(
  state: VoiceGestureState,
  event: VoiceGestureEvent,
  config: VoiceGestureConfig = VOICE_GESTURE_DEFAULTS,
): { readonly state: VoiceGestureState; readonly effects: readonly VoiceGestureEffect[] } {
  switch (event.type) {
    case "press": {
      if (state.type !== "idle") return { state, effects: [] };
      return {
        state: { type: "pressing", pressedAt: event.at, startY: event.y },
        effects: [],
      };
    }
    case "hold_elapsed": {
      if (state.type !== "pressing") return { state, effects: [] };
      return {
        state: {
          type: "holding",
          pressedAt: state.pressedAt,
          startY: state.startY,
          travel: 0,
          cancelArmed: false,
        },
        effects: [{ type: "hold_classified" }],
      };
    }
    case "move": {
      if (state.type !== "holding") return { state, effects: [] };
      const travel = Math.max(0, state.startY - event.y);
      const armed = state.cancelArmed
        ? travel > config.cancelDistance - config.cancelHysteresis
        : travel >= config.cancelDistance;
      return {
        state: { ...state, travel, cancelArmed: armed },
        effects: armed === state.cancelArmed ? [] : [{ type: "cancel_armed_changed", armed }],
      };
    }
    case "release": {
      if (state.type === "pressing") {
        return { state: VOICE_GESTURE_IDLE, effects: [{ type: "tap" }] };
      }
      if (state.type === "holding") {
        if (state.cancelArmed) {
          return {
            state: VOICE_GESTURE_IDLE,
            effects: [{ type: "cancel_recording", reason: "swipe" }],
          };
        }
        if (event.at - state.pressedAt < config.tooShortMs) {
          return {
            state: VOICE_GESTURE_IDLE,
            effects: [{ type: "cancel_recording", reason: "too_short" }],
          };
        }
        return { state: VOICE_GESTURE_IDLE, effects: [{ type: "stop_and_transcribe" }] };
      }
      return { state, effects: [] };
    }
    case "interrupt": {
      if (state.type === "idle") return { state, effects: [] };
      return {
        state: VOICE_GESTURE_IDLE,
        effects: [{ type: "cancel_recording", reason: "interrupted" }],
      };
    }
  }
}

/** 0..1 progress toward the cancel threshold, for scaling the cancel target. */
export function voiceGestureCancelProgress(
  state: VoiceGestureState,
  config: VoiceGestureConfig = VOICE_GESTURE_DEFAULTS,
): number {
  if (state.type !== "holding") return 0;
  return Math.min(1, state.travel / config.cancelDistance);
}
