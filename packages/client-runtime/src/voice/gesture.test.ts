import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_GESTURE_DEFAULTS,
  VOICE_GESTURE_IDLE,
  voiceGestureCancelProgress,
  voiceGestureTransition,
  type VoiceGestureEvent,
  type VoiceGestureState,
} from "./gesture.ts";

function run(events: readonly VoiceGestureEvent[], from: VoiceGestureState = VOICE_GESTURE_IDLE) {
  let state = from;
  const effects = [];
  for (const event of events) {
    const result = voiceGestureTransition(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

describe("voiceGestureTransition", () => {
  it("classifies a quick release as a tap", () => {
    const { state, effects } = run([
      { type: "press", at: 0, y: 500 },
      { type: "release", at: 120 },
    ]);
    expect(state).toEqual(VOICE_GESTURE_IDLE);
    expect(effects).toEqual([{ type: "tap" }]);
  });

  it("classifies a held press and transcribes on release", () => {
    const { state, effects } = run([
      { type: "press", at: 0, y: 500 },
      { type: "hold_elapsed" },
      { type: "release", at: 2_000 },
    ]);
    expect(state).toEqual(VOICE_GESTURE_IDLE);
    expect(effects).toEqual([{ type: "hold_classified" }, { type: "stop_and_transcribe" }]);
  });

  it("discards a hold released before the too-short threshold", () => {
    const { effects } = run([
      { type: "press", at: 0, y: 500 },
      { type: "hold_elapsed" },
      { type: "release", at: VOICE_GESTURE_DEFAULTS.tooShortMs - 1 },
    ]);
    expect(effects).toEqual([
      { type: "hold_classified" },
      { type: "cancel_recording", reason: "too_short" },
    ]);
  });

  it("arms cancel past the slide distance and cancels on release", () => {
    const { state, effects } = run([
      { type: "press", at: 0, y: 500 },
      { type: "hold_elapsed" },
      { type: "move", y: 500 - VOICE_GESTURE_DEFAULTS.cancelDistance },
      { type: "release", at: 5_000 },
    ]);
    expect(state).toEqual(VOICE_GESTURE_IDLE);
    expect(effects).toEqual([
      { type: "hold_classified" },
      { type: "cancel_armed_changed", armed: true },
      { type: "cancel_recording", reason: "swipe" },
    ]);
  });

  it("disarms only after travel drops below the hysteresis band", () => {
    const armDistance = VOICE_GESTURE_DEFAULTS.cancelDistance;
    const stillArmed = armDistance - VOICE_GESTURE_DEFAULTS.cancelHysteresis + 1;
    const disarmed = armDistance - VOICE_GESTURE_DEFAULTS.cancelHysteresis - 1;
    const { effects } = run([
      { type: "press", at: 0, y: 500 },
      { type: "hold_elapsed" },
      { type: "move", y: 500 - armDistance },
      { type: "move", y: 500 - stillArmed },
      { type: "move", y: 500 - disarmed },
      { type: "release", at: 5_000 },
    ]);
    expect(effects).toEqual([
      { type: "hold_classified" },
      { type: "cancel_armed_changed", armed: true },
      { type: "cancel_armed_changed", armed: false },
      { type: "stop_and_transcribe" },
    ]);
  });

  it("never reports negative travel for downward movement", () => {
    const { state } = run([
      { type: "press", at: 0, y: 500 },
      { type: "hold_elapsed" },
      { type: "move", y: 900 },
    ]);
    expect(state).toMatchObject({ type: "holding", travel: 0, cancelArmed: false });
    expect(voiceGestureCancelProgress(state)).toBe(0);
  });

  it("cancels on interrupt from both pressing and holding", () => {
    const pressing = run([{ type: "press", at: 0, y: 500 }, { type: "interrupt" }]);
    expect(pressing.state).toEqual(VOICE_GESTURE_IDLE);
    expect(pressing.effects).toEqual([{ type: "cancel_recording", reason: "interrupted" }]);

    const holding = run([
      { type: "press", at: 0, y: 500 },
      { type: "hold_elapsed" },
      { type: "interrupt" },
    ]);
    expect(holding.effects).toEqual([
      { type: "hold_classified" },
      { type: "cancel_recording", reason: "interrupted" },
    ]);
  });

  it("ignores stray events outside their states", () => {
    expect(voiceGestureTransition(VOICE_GESTURE_IDLE, { type: "release", at: 10 }).effects).toEqual(
      [],
    );
    expect(voiceGestureTransition(VOICE_GESTURE_IDLE, { type: "move", y: 10 }).effects).toEqual([]);
    expect(voiceGestureTransition(VOICE_GESTURE_IDLE, { type: "hold_elapsed" }).effects).toEqual(
      [],
    );
    const pressing = run([{ type: "press", at: 0, y: 500 }]).state;
    expect(voiceGestureTransition(pressing, { type: "press", at: 5, y: 400 }).state).toBe(pressing);
  });

  it("reports cancel progress while holding", () => {
    const halfway = run([
      { type: "press", at: 0, y: 500 },
      { type: "hold_elapsed" },
      { type: "move", y: 500 - VOICE_GESTURE_DEFAULTS.cancelDistance / 2 },
    ]).state;
    expect(voiceGestureCancelProgress(halfway)).toBeCloseTo(0.5);
  });
});
