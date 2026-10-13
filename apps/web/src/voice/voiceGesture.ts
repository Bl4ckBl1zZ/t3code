/**
 * Press, hold, and release on the composer's microphone button.
 *
 * A press starts recording right away so the first words are not lost. If the
 * pointer comes up before `holdMs`, the press was a tap and the recording keeps
 * going hands-free until the user stops it. Past `holdMs` it is push-to-talk:
 * releasing transcribes, unless the pointer slid up into the cancel zone or the
 * hold was too short to hold speech.
 */

export type VoiceGestureConfig = {
  readonly holdMs: number;
  /** A hold released before this, from the press, is a graze and is discarded. */
  readonly tooShortMs: number;
  /** Upward travel in CSS pixels that arms slide-to-cancel. */
  readonly cancelDistance: number;
  /** Travel must fall this far back below `cancelDistance` to disarm. */
  readonly cancelHysteresis: number;
};

const VOICE_GESTURE_DEFAULTS: VoiceGestureConfig = {
  holdMs: 300,
  tooShortMs: 500,
  cancelDistance: 80,
  cancelHysteresis: 24,
};

export type VoiceGestureState =
  | { readonly type: "idle" }
  | { readonly type: "pressing"; readonly pressedAt: number; readonly startY: number }
  | {
      readonly type: "holding";
      readonly pressedAt: number;
      readonly startY: number;
      readonly cancelArmed: boolean;
    };

export type VoiceGestureEvent =
  | { readonly type: "press"; readonly at: number; readonly y: number }
  | { readonly type: "hold_elapsed" }
  | { readonly type: "move"; readonly y: number }
  | { readonly type: "release"; readonly at: number }
  /** The pointer was lost without a release, for example to a system dialog. */
  | { readonly type: "interrupt" };

export type VoiceGestureEffect =
  | { readonly type: "start" }
  | { readonly type: "hold" }
  | { readonly type: "cancel_armed"; readonly armed: boolean }
  | { readonly type: "stop" }
  | { readonly type: "cancel" };

export const VOICE_GESTURE_IDLE: VoiceGestureState = { type: "idle" };

export function voiceGestureTransition(
  state: VoiceGestureState,
  event: VoiceGestureEvent,
  config: VoiceGestureConfig = VOICE_GESTURE_DEFAULTS,
): { readonly state: VoiceGestureState; readonly effects: ReadonlyArray<VoiceGestureEffect> } {
  switch (event.type) {
    case "press":
      return state.type === "idle"
        ? {
            state: { type: "pressing", pressedAt: event.at, startY: event.y },
            effects: [{ type: "start" }],
          }
        : { state, effects: [] };
    case "hold_elapsed":
      return state.type === "pressing"
        ? {
            state: { ...state, type: "holding", cancelArmed: false },
            effects: [{ type: "hold" }],
          }
        : { state, effects: [] };
    case "move": {
      if (state.type !== "holding") return { state, effects: [] };
      const travel = Math.max(0, state.startY - event.y);
      const armed = state.cancelArmed
        ? travel > config.cancelDistance - config.cancelHysteresis
        : travel >= config.cancelDistance;
      return armed === state.cancelArmed
        ? { state, effects: [] }
        : {
            state: { ...state, cancelArmed: armed },
            effects: [{ type: "cancel_armed", armed }],
          };
    }
    case "release":
      if (state.type === "pressing") return { state: VOICE_GESTURE_IDLE, effects: [] };
      if (state.type === "holding") {
        const discard = state.cancelArmed || event.at - state.pressedAt < config.tooShortMs;
        return {
          state: VOICE_GESTURE_IDLE,
          effects: [{ type: discard ? "cancel" : "stop" }],
        };
      }
      return { state, effects: [] };
    case "interrupt":
      // Losing the pointer is not a decision to discard: keep what was said.
      return {
        state: VOICE_GESTURE_IDLE,
        effects: state.type === "holding" ? [{ type: "stop" }] : [],
      };
  }
}
