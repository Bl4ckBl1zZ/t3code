/** Reading gestures, not focus loss, collapse an existing desktop composer. */
export interface ComposerReadingGesture {
  distance: number;
  lastEventAt: number;
  suppressed: boolean;
}
export function createComposerReadingGesture(): ComposerReadingGesture {
  return { distance: 0, lastEventAt: -Infinity, suppressed: false };
}
export function recordComposerReadingGesture(
  state: ComposerReadingGesture,
  input: {
    now: number;
    delta: number;
    eligible: boolean;
    canScroll: boolean;
    towardLogicalEnd: boolean;
  },
): boolean {
  if (input.now - state.lastEventAt > 120) {
    state.distance = 0;
    state.suppressed = false;
  }
  state.lastEventAt = input.now;
  if (state.suppressed || !input.eligible || !input.canScroll || input.towardLogicalEnd) {
    state.distance = 0;
    return false;
  }
  state.distance += Math.abs(input.delta);
  if (state.distance < 24) return false;
  state.distance = 0;
  return true;
}
export function suppressComposerReadingGesture(state: ComposerReadingGesture, now: number) {
  if (now - state.lastEventAt <= 120) state.suppressed = true;
}
export function resolveRestingComposerInset(previous: number, measured: number, resting: boolean) {
  return resting ? Math.max(previous, measured + 94) : measured;
}
