import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_GESTURE_IDLE,
  voiceGestureTransition,
  type VoiceGestureEffect,
  type VoiceGestureEvent,
  type VoiceGestureState,
} from "./voiceGesture";

function run(events: ReadonlyArray<VoiceGestureEvent>) {
  let state: VoiceGestureState = VOICE_GESTURE_IDLE;
  const effects: VoiceGestureEffect[] = [];
  for (const event of events) {
    const next = voiceGestureTransition(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects: effects.map((effect) => effect.type) };
}

describe("voiceGestureTransition", () => {
  it("starts on press and keeps a quick tap recording hands-free", () => {
    expect(
      run([
        { type: "press", at: 0, y: 100 },
        { type: "release", at: 150 },
      ]),
    ).toEqual({ state: VOICE_GESTURE_IDLE, effects: ["start"] });
  });

  it("transcribes a hold on release", () => {
    expect(
      run([
        { type: "press", at: 0, y: 100 },
        { type: "hold_elapsed" },
        { type: "move", y: 70 },
        { type: "release", at: 2_000 },
      ]).effects,
    ).toEqual(["start", "hold", "stop"]);
  });

  it("discards a hold released in the cancel zone or released too soon", () => {
    expect(
      run([
        { type: "press", at: 0, y: 100 },
        { type: "hold_elapsed" },
        { type: "move", y: 10 },
        { type: "release", at: 2_000 },
      ]).effects,
    ).toEqual(["start", "hold", "cancel_armed", "cancel"]);
    expect(
      run([
        { type: "press", at: 0, y: 100 },
        { type: "hold_elapsed" },
        { type: "release", at: 400 },
      ]).effects,
    ).toEqual(["start", "hold", "cancel"]);
  });

  it("disarms only after sliding back past the hysteresis band", () => {
    const armed = run([
      { type: "press", at: 0, y: 100 },
      { type: "hold_elapsed" },
      { type: "move", y: 15 },
      // 85 px up is still inside the band (80 - 24).
      { type: "move", y: 30 },
    ]);
    expect(armed.state).toMatchObject({ type: "holding", cancelArmed: true });
    const disarmed = run([
      { type: "press", at: 0, y: 100 },
      { type: "hold_elapsed" },
      { type: "move", y: 15 },
      { type: "move", y: 60 },
      { type: "release", at: 2_000 },
    ]);
    expect(disarmed.effects).toEqual(["start", "hold", "cancel_armed", "cancel_armed", "stop"]);
  });

  it("keeps the audio when the pointer is lost mid-hold, even with cancel armed", () => {
    expect(
      run([
        { type: "press", at: 0, y: 100 },
        { type: "hold_elapsed" },
        { type: "move", y: 0 },
        { type: "interrupt" },
      ]).effects,
    ).toEqual(["start", "hold", "cancel_armed", "stop"]);
  });
});
