import {
  VOICE_GESTURE_DEFAULTS,
  VOICE_GESTURE_IDLE,
  voiceGestureTransition,
  type VoiceGestureEvent,
  type VoiceGestureState,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice";
import { VOICE_INPUT_MAX_DURATION_SECONDS } from "@t3tools/contracts/voice";
import { MicIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const COUNTDOWN_THRESHOLD_SECONDS = 15;
const LEVEL_BAR_COUNT = 14;
// Fast attack / slow release envelope (per second): speech pops bars up instantly and lets
// them fall away smoothly instead of flickering between raw 10 Hz samples.
const LEVEL_ATTACK_PER_SECOND = 28;
const LEVEL_RELEASE_PER_SECOND = 5;
const LEVEL_MIN_SCALE = 0.18;

// Bars form a dome mirrored around the center like the system dictation meter. Alternating
// response exponents keep neighbors from moving in lockstep so the meter reads as a live
// waveform rather than a uniform block.
const LEVEL_BAR_PROFILES = Array.from({ length: LEVEL_BAR_COUNT }, (_, index) => {
  const centered = Math.sin((Math.PI * (index + 0.5)) / LEVEL_BAR_COUNT);
  return {
    weight: 0.3 + 0.7 * centered,
    exponent: index % 2 === 0 ? 0.8 : 1.3,
    opacity: 0.5 + 0.5 * centered,
  };
});

function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1_000));
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function VoiceLevelMeter(props: {
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
  readonly dimmed?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // The meter runs imperatively in one rAF loop writing transforms — recording produces zero
  // React re-renders and no layout work.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const bars = Array.from(container.children) as HTMLElement[];
    let target = 0;
    let envelope = 0;
    let lastFrame = performance.now();
    let frame = 0;
    const unsubscribe = props.subscribeLevel((level) => {
      target = Math.min(1, Math.max(0, level));
    });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tick = (time: number) => {
      const deltaSeconds = Math.min(0.1, (time - lastFrame) / 1_000);
      lastFrame = time;
      const rate = target > envelope ? LEVEL_ATTACK_PER_SECOND : LEVEL_RELEASE_PER_SECOND;
      envelope += (target - envelope) * Math.min(1, rate * deltaSeconds);
      for (const [index, bar] of bars.entries()) {
        const profile = LEVEL_BAR_PROFILES[index]!;
        const value = Math.min(1, Math.pow(envelope, profile.exponent) * profile.weight);
        const scale = LEVEL_MIN_SCALE + value * (1 - LEVEL_MIN_SCALE);
        bar.style.transform = `scaleY(${scale.toFixed(3)})`;
      }
      frame = requestAnimationFrame(tick);
    };
    if (reducedMotion) {
      // Static mid-height bars: presence without motion.
      for (const bar of bars) bar.style.transform = "scaleY(0.45)";
      return unsubscribe;
    }
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [props.subscribeLevel]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-4 items-center gap-px transition-opacity duration-200 motion-reduce:transition-none",
        props.dimmed && "opacity-40",
      )}
      aria-hidden="true"
    >
      {LEVEL_BAR_PROFILES.map((profile, index) => (
        <span
          // The bars are fixed positional slots driven imperatively by the rAF loop above.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className="h-full w-[3px] origin-center rounded-full bg-destructive"
          style={{ opacity: profile.opacity, transform: `scaleY(${LEVEL_MIN_SCALE})` }}
        />
      ))}
    </div>
  );
}

function TranscribingShimmer() {
  return (
    <span
      className="flex items-center gap-1 animate-voice-row-in motion-reduce:animate-none"
      aria-hidden="true"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 rounded-full bg-muted-foreground animate-voice-shimmer-dot motion-reduce:animate-none motion-reduce:opacity-60"
          style={{ animationDelay: `${index * 140}ms` }}
        />
      ))}
    </span>
  );
}

/**
 * Voice input control rendered as one persistent capsule that morphs between states —
 * idle mic button, expanding recording pill, collapsing transcribing pill, failure shake —
 * so the eye tracks a single element instead of four swapped subtrees.
 */
export function ComposerVoiceAction(props: {
  readonly state: VoiceInputState;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onCleanupChange: (cleanup: boolean) => void;
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
}) {
  const recording = props.state.type === "recording" ? props.state : null;
  const transcribing = props.state.type === "stopping" || props.state.type === "transcribing";
  const failedState = props.state.type === "failed" && props.state.canRetry ? props.state : null;
  const failed = failedState !== null;
  const requestingPermission = props.state.type === "requesting_permission";
  const idle = !recording && !transcribing && !failed;

  // Push-to-talk gesture. The pure machine classifies press/move/release into tap vs hold vs
  // slide-up cancel; this layer owns the pointer events, the 300ms hold timer, and mapping the
  // machine's effects onto the controller callbacks.
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<VoiceGestureState>(VOICE_GESTURE_IDLE);
  const holdTimerRef = useRef<number | null>(null);
  // A click event still fires on the mic button after pointerup; when the pointer sequence was
  // already handled by the machine (tap or hold), that click must not toggle a second time.
  // Keyboard activation fires click without any pointer events, so it passes through.
  const suppressClickRef = useRef(false);
  // Release while the permission prompt is still in flight: stop as soon as recording starts.
  const pendingStopRef = useRef(false);
  const [gesture, setGesture] = useState({ holding: false, armed: false });

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const applyGestureEvent = (event: VoiceGestureEvent) => {
    const next = voiceGestureTransition(gestureRef.current, event);
    gestureRef.current = next.state;
    const holding = next.state.type === "holding";
    const armed = holding && next.state.cancelArmed;
    setGesture((prev) =>
      prev.holding === holding && prev.armed === armed ? prev : { holding, armed },
    );
    for (const effect of next.effects) {
      switch (effect.type) {
        case "tap":
          props.onToggle();
          break;
        case "hold_classified":
          // The press happened on the idle mic, so toggle starts push-to-talk capture.
          pendingStopRef.current = false;
          props.onToggle();
          break;
        case "stop_and_transcribe":
          if (props.state.type === "recording") props.onToggle();
          else pendingStopRef.current = true;
          break;
        case "cancel_recording":
          pendingStopRef.current = false;
          props.onCancel();
          break;
        case "cancel_armed_changed":
          break; // Reflected via the gesture UI state above.
      }
    }
  };

  const endPointerSequence = () => {
    clearHoldTimer();
    suppressClickRef.current = true;
    // The trailing click (if any) dispatches before timers run; self-heal for sequences where
    // no click follows so a later keyboard activation is never swallowed.
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const stateType = props.state.type;
  useEffect(() => {
    if (!pendingStopRef.current) return;
    if (stateType === "recording") {
      pendingStopRef.current = false;
      props.onToggle();
    } else if (stateType === "idle" || stateType === "failed") {
      // The start never happened (unavailable, denied); nothing left to stop.
      pendingStopRef.current = false;
    }
    // onToggle identity churns with the parent's draft state; the ref guard makes reruns inert.
  }, [stateType]);

  useEffect(() => clearHoldTimer, []);

  const elapsedSeconds = useElapsedSeconds(recording?.startedAt ?? null);
  const remainingSeconds = Math.max(0, VOICE_INPUT_MAX_DURATION_SECONDS - elapsedSeconds);
  const showCountdown = recording !== null && remainingSeconds <= COUNTDOWN_THRESHOLD_SECONDS;

  const capsuleState = recording
    ? "recording"
    : transcribing
      ? "transcribing"
      : failed
        ? "failed"
        : "idle";

  return (
    <div
      ref={capsuleRef}
      data-state={capsuleState}
      data-gesture={gesture.holding ? (gesture.armed ? "cancel-armed" : "holding") : undefined}
      // Pointer capture lives on the capsule (not the mic button) because the button unmounts
      // when the capsule morphs into the recording row mid-hold; the capsule persists, so
      // move/release events keep arriving here for the machine.
      onPointerMove={(event) => {
        if (gestureRef.current.type === "idle") return;
        applyGestureEvent({ type: "move", y: event.clientY });
      }}
      onPointerUp={() => {
        if (gestureRef.current.type === "idle") return;
        endPointerSequence();
        applyGestureEvent({ type: "release", at: performance.now() });
      }}
      onPointerCancel={() => {
        if (gestureRef.current.type === "idle") return;
        endPointerSequence();
        applyGestureEvent({ type: "interrupt" });
      }}
      className={cn(
        "flex h-9 items-center overflow-hidden rounded-full border transition-[max-width,background-color,border-color,box-shadow] motion-reduce:transition-none sm:h-8",
        // Per-property timing (lists match transition-property order): the width morph gets a
        // springy overshoot while colors crossfade in 200ms so the cancel-armed swap never
        // snaps. The overshoot curve only applies while expanding into a state — max-width
        // overshoot is invisible there because it passes beyond the content's natural width.
        // Collapsing home targets the idle classes, which keep the gentler curve; otherwise
        // the overshoot would undershoot max-width below the mic button and clip it.
        idle
          ? "[transition-duration:300ms,200ms,200ms,200ms] [transition-timing-function:cubic-bezier(0.34,1.2,0.64,1),ease-out,ease-out,ease-out]"
          : "[transition-duration:360ms,200ms,200ms,200ms] [transition-timing-function:cubic-bezier(0.34,1.45,0.64,1),ease-out,ease-out,ease-out]",
        // Reserving max-width per state (instead of swapping subtrees) is what lets the
        // capsule morph; the action row no longer jumps when recording starts.
        idle && "max-w-9 border-transparent sm:max-w-8",
        recording &&
          (gesture.armed
            ? "max-w-96 border-border bg-muted/60 px-1.5"
            : "max-w-96 border-destructive/35 bg-destructive/10 px-1.5"),
        transcribing && "max-w-56 border-border bg-muted/60 px-2",
        failed &&
          "max-w-24 border-destructive/35 bg-destructive/5 px-1 animate-voice-shake motion-reduce:animate-none",
      )}
      role="group"
      aria-label={
        recording
          ? gesture.holding
            ? gesture.armed
              ? "Recording, release to cancel"
              : "Recording, release to send"
            : "Voice recording controls"
          : transcribing
            ? "Voice transcription in progress"
            : failed
              ? "Voice transcription failed"
              : undefined
      }
    >
      {recording ? (
        <>
          <span
            className={cn(
              "flex items-center gap-1.5 px-1 text-xs font-medium transition-colors duration-200 animate-voice-row-in motion-reduce:animate-none motion-reduce:transition-none",
              gesture.armed ? "text-muted-foreground" : "text-destructive",
            )}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full transition-colors duration-200 animate-voice-dot motion-reduce:animate-none motion-reduce:transition-none",
                gesture.armed ? "bg-muted-foreground" : "bg-destructive",
              )}
              aria-hidden="true"
            />
            <VoiceLevelMeter subscribeLevel={props.subscribeLevel} dimmed={gesture.armed} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "tabular-nums",
                      showCountdown && "animate-voice-countdown-tick motion-reduce:animate-none",
                    )}
                    aria-label={
                      showCountdown
                        ? `Recording, ${remainingSeconds} seconds remaining`
                        : `Recording, ${formatClock(elapsedSeconds)}`
                    }
                  />
                }
              >
                {showCountdown ? `-${formatClock(remainingSeconds)}` : formatClock(elapsedSeconds)}
              </TooltipTrigger>
              {showCountdown ? (
                <TooltipPopup side="top">Recording stops automatically at the limit</TooltipPopup>
              ) : null}
            </Tooltip>
          </span>
          {gesture.holding ? (
            // Finger/mouse is still down during push-to-talk, so the row's buttons are
            // unreachable; name what releasing right now does instead. Sliding up only arms the
            // discard — the release is what decides — so the armed copy is the same shape.
            <span
              className="whitespace-nowrap px-1.5 text-xs text-muted-foreground animate-voice-row-in motion-reduce:animate-none"
              aria-live="polite"
            >
              {gesture.armed ? "Release to cancel" : "Release to send · ↑ slide to cancel"}
            </span>
          ) : (
            <>
              {/* Small animation-delays build the row left-to-right; fill-mode `both` (baked
                  into the animate token) keeps the delayed buttons invisible until their turn. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className={cn(
                        "rounded-full px-1.5 py-1 text-[11px] transition-colors animate-voice-row-in [animation-delay:40ms] motion-reduce:animate-none",
                        recording.cleanup
                          ? "bg-destructive/10 text-destructive"
                          : "text-muted-foreground hover:bg-muted",
                      )}
                      onClick={() => props.onCleanupChange(!recording.cleanup)}
                      aria-pressed={recording.cleanup}
                    />
                  }
                >
                  Cleanup {recording.cleanup ? "on" : "off"}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  Clean up filler words and punctuation after transcribing
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted animate-voice-row-in [animation-delay:75ms] motion-reduce:animate-none"
                      onClick={props.onCancel}
                      aria-label="Cancel voice recording"
                    />
                  }
                >
                  <XIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">Cancel · Esc</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-destructive text-white transition-transform hover:scale-105 animate-voice-row-in [animation-delay:110ms] motion-reduce:animate-none motion-reduce:transition-none"
                      onClick={props.onToggle}
                      aria-label="Stop recording and transcribe"
                    />
                  }
                >
                  <SquareIcon className="size-3 fill-current" />
                </TooltipTrigger>
                <TooltipPopup side="top">Stop and transcribe · ⌘⇧M / Ctrl⇧M</TooltipPopup>
              </Tooltip>
            </>
          )}
        </>
      ) : transcribing ? (
        <>
          <TranscribingShimmer />
          <span className="whitespace-nowrap px-1.5 text-xs text-muted-foreground animate-voice-row-in [animation-delay:40ms] motion-reduce:animate-none">
            Transcribing…
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted animate-voice-row-in [animation-delay:75ms] motion-reduce:animate-none"
                  onClick={props.onCancel}
                  aria-label="Cancel transcription"
                />
              }
            >
              <XIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Cancel transcription</TooltipPopup>
          </Tooltip>
        </>
      ) : failedState ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-destructive transition-colors hover:bg-destructive/10"
                  // retry() re-requests microphone access for permission failures and re-sends the
                  // kept recording for transcription failures.
                  onClick={props.onRetry}
                  aria-label={
                    failedState.stage === "permission"
                      ? "Try microphone access again"
                      : "Retry voice transcription"
                  }
                />
              }
            >
              <RotateCwIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {failedState.stage === "permission"
                ? "Microphone access failed — try again"
                : "Transcription failed — retry with the same recording"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
                  onClick={props.onCancel}
                  aria-label="Discard failed voice recording"
                />
              }
            >
              <XIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Discard recording</TooltipPopup>
          </Tooltip>
        </>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  // touch-none keeps a touch hold from turning into a page scroll (which would
                  // pointercancel the push-to-talk gesture).
                  // Press feel: a quick dip to .92 on press and a plain ease-out release.
                  "flex size-9 shrink-0 touch-none select-none items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.92] active:duration-100 motion-reduce:transition-none motion-reduce:active:scale-100 sm:size-8",
                  requestingPermission && "bg-muted",
                )}
                disabled={props.disabled || requestingPermission}
                onPointerDown={(event) => {
                  if (!event.isPrimary) return;
                  suppressClickRef.current = false;
                  pendingStopRef.current = false;
                  // Capture on the capsule so the gesture survives this button unmounting when the
                  // capsule morphs into the recording row.
                  capsuleRef.current?.setPointerCapture(event.pointerId);
                  applyGestureEvent({ type: "press", at: performance.now(), y: event.clientY });
                  clearHoldTimer();
                  holdTimerRef.current = window.setTimeout(() => {
                    holdTimerRef.current = null;
                    applyGestureEvent({ type: "hold_elapsed" });
                  }, VOICE_GESTURE_DEFAULTS.holdClassifyMs);
                }}
                onContextMenu={(event) => {
                  if (gestureRef.current.type !== "idle") event.preventDefault();
                }}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  // Keyboard activation (Enter/Space) arrives here with no pointer sequence.
                  props.onToggle();
                }}
                aria-label={
                  requestingPermission ? "Requesting microphone access" : "Dictate message"
                }
              />
            }
          >
            {requestingPermission ? <Spinner className="size-4" /> : <MicIcon className="size-4" />}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {requestingPermission
              ? "Requesting microphone…"
              : "Dictate message · ⌘⇧M / Ctrl⇧M · hold to talk"}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
