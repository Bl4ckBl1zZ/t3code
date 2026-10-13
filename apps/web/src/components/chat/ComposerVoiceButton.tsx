import { MicIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type PointerEvent } from "react";

import { cn } from "~/lib/utils";
import {
  VOICE_GESTURE_IDLE,
  voiceGestureTransition,
  type VoiceGestureEvent,
  type VoiceGestureState,
} from "../../voice/voiceGesture";
import {
  cancelVoiceRecording,
  holdVoiceRecording,
  retryVoiceTranscription,
  startVoiceRecording,
  stopVoiceRecording,
  subscribeVoiceLevel,
  useVoiceSession,
  type VoiceTarget,
} from "../../voice/webVoiceSession";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const LEVEL_BARS = [
  { id: "a", weight: 0.55 },
  { id: "b", weight: 1 },
  { id: "c", weight: 0.75 },
  { id: "d", weight: 0.9 },
  { id: "e", weight: 0.6 },
] as const;
const LEVEL_STEPS = 8;

/**
 * Bars that follow the microphone level. Levels arrive about twelve times a
 * second while recording and are written to the bars directly, skipping
 * repeats, so silence and idle cost no renders or paints.
 */
function VoiceLevelMeter() {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    let lastStep = -1;
    return subscribeVoiceLevel((level) => {
      const step = Math.round(level * LEVEL_STEPS);
      if (step === lastStep) return;
      lastStep = step;
      for (const [index, bar] of barsRef.current.entries()) {
        const weight = LEVEL_BARS[index]?.weight ?? 1;
        if (bar) bar.style.scale = `1 ${0.2 + 0.8 * (step / LEVEL_STEPS) * weight}`;
      }
    });
  }, []);
  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5">
      {LEVEL_BARS.map((bar, index) => (
        <span
          key={bar.id}
          ref={(element) => {
            barsRef.current[index] = element;
          }}
          className="h-4 w-0.5 origin-center scale-y-20 rounded-full bg-current transition-transform duration-75"
        />
      ))}
    </span>
  );
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Elapsed time, switching to the time left near the clip limit. */
function VoiceRecordingClock(props: { startedAt: number; maxSeconds: number }) {
  const elapsedNow = () => (Date.now() - props.startedAt) / 1_000;
  const [elapsed, setElapsed] = useState(elapsedNow);
  useEffect(() => {
    const timer = window.setInterval(
      () => setElapsed((Date.now() - props.startedAt) / 1_000),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [props.startedAt]);
  const remaining = props.maxSeconds - elapsed;
  const ending = remaining <= 10;
  return (
    <span className={cn("text-xs tabular-nums", ending && "text-warning-foreground")}>
      {ending ? `${formatClock(remaining)} left` : formatClock(elapsed)}
    </span>
  );
}

/**
 * Microphone action in the composer footer. Tap to dictate hands-free, hold
 * to talk, slide up while holding to discard. The button stays the same
 * element while recording so a hold keeps its pointer capture.
 */
export const ComposerVoiceButton = memo(function ComposerVoiceButton(props: {
  readonly target: VoiceTarget;
  readonly disabled: boolean;
  readonly shortcutLabel: string | null;
  /** Called before a recording starts so the composer can remember the caret. */
  readonly onBeforeStart: () => void;
}) {
  const session = useVoiceSession();
  const gestureRef = useRef<VoiceGestureState>(VOICE_GESTURE_IDLE);
  const holdTimerRef = useRef<number | null>(null);
  // The click that follows a handled press must not toggle the recording again.
  const pressHandledRef = useRef(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const { target, onBeforeStart } = props;

  const recording = session.phase === "recording";
  const busy = session.phase === "starting" || session.phase === "transcribing";
  const failed = session.phase === "failed" && session.targetKey === target.key ? session : null;

  // Errors surface once, as a toast; the retry stays on the button.
  const failureMessage = failed?.message ?? null;
  useEffect(() => {
    if (failureMessage) {
      toastManager.add({ type: "error", title: "Voice input", description: failureMessage });
    }
  }, [failureMessage]);

  // Esc discards an active recording unless a dialog owns the key.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')) {
        return;
      }
      event.preventDefault();
      cancelVoiceRecording();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [recording]);

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };

  const dispatch = (event: VoiceGestureEvent) => {
    const next = voiceGestureTransition(gestureRef.current, event);
    gestureRef.current = next.state;
    for (const effect of next.effects) {
      switch (effect.type) {
        case "start":
          onBeforeStart();
          void startVoiceRecording(target);
          holdTimerRef.current = window.setTimeout(() => {
            holdTimerRef.current = null;
            dispatch({ type: "hold_elapsed" });
          }, 300);
          break;
        case "hold":
          holdVoiceRecording();
          break;
        case "cancel_armed":
          setCancelArmed(effect.armed);
          break;
        case "stop":
          setCancelArmed(false);
          void stopVoiceRecording();
          break;
        case "cancel":
          setCancelArmed(false);
          cancelVoiceRecording();
          break;
      }
    }
    if (next.state.type === "idle") clearHoldTimer();
  };

  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    },
    [],
  );

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || props.disabled) return;
    // A running hands-free recording stops on click instead.
    if (session.phase !== "idle" && session.phase !== "failed") return;
    event.preventDefault();
    pressHandledRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    dispatch({ type: "press", at: Date.now(), y: event.clientY });
  };

  const onClick = () => {
    if (pressHandledRef.current) {
      pressHandledRef.current = false;
      return;
    }
    if (session.phase === "recording") {
      void stopVoiceRecording();
    } else if (session.phase === "idle" || session.phase === "failed") {
      // Keyboard activation; pointer presses start in onPointerDown.
      onBeforeStart();
      void startVoiceRecording(target);
    }
  };

  const label = recording
    ? "Stop and transcribe"
    : session.phase === "transcribing"
      ? "Transcribing"
      : "Voice input";
  const hint = recording
    ? session.hold
      ? cancelArmed
        ? "Release to discard"
        : "Release to transcribe, slide up to discard"
      : "Click to transcribe, Esc to discard"
    : `Tap to dictate, hold to talk${props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}`;

  return (
    <div className="flex items-center gap-1">
      {recording ? (
        <>
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Discard recording"
            onPointerDown={(event) => event.preventDefault()}
            onClick={cancelVoiceRecording}
          >
            <XIcon />
          </Button>
          <span
            className={cn(
              "flex items-center gap-1.5 text-muted-foreground",
              cancelArmed && "text-destructive",
            )}
          >
            <VoiceLevelMeter />
            <VoiceRecordingClock startedAt={session.startedAt} maxSeconds={session.maxSeconds} />
          </span>
        </>
      ) : null}
      {session.phase === "transcribing" ? (
        <span className="text-xs text-muted-foreground">Transcribing…</span>
      ) : null}
      {failed?.canRetry ? (
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-sm"
          aria-label="Retry transcription"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void retryVoiceTranscription()}
        >
          <RotateCcwIcon />
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={recording ? "ghost-destructive" : "ghost"}
              size="icon-sm"
              aria-label={label}
              aria-busy={busy || undefined}
              disabled={props.disabled || session.phase === "transcribing"}
              onPointerDown={onPointerDown}
              onPointerMove={(event) => dispatch({ type: "move", y: event.clientY })}
              onPointerUp={() => dispatch({ type: "release", at: Date.now() })}
              onPointerCancel={() => {
                pressHandledRef.current = false;
                dispatch({ type: "interrupt" });
              }}
              onLostPointerCapture={() => dispatch({ type: "interrupt" })}
              onClick={onClick}
            />
          }
        >
          {recording ? <SquareIcon /> : <MicIcon />}
        </TooltipTrigger>
        <TooltipPopup>{hint}</TooltipPopup>
      </Tooltip>
    </div>
  );
});
