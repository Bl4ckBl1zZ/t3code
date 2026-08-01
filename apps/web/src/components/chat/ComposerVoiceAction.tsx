import type { VoiceInputState } from "@t3tools/client-runtime/voice";
import { VOICE_INPUT_MAX_DURATION_SECONDS } from "@t3tools/contracts/voice";
import { MicIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";

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
    <div ref={containerRef} className="flex h-4 items-center gap-px" aria-hidden="true">
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
    <span className="flex items-center gap-1" aria-hidden="true">
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
  const failed = props.state.type === "failed" && props.state.canRetry;
  const requestingPermission = props.state.type === "requesting_permission";
  const idle = !recording && !transcribing && !failed;

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
      data-state={capsuleState}
      className={cn(
        "flex h-9 items-center overflow-hidden rounded-full border transition-[max-width,background-color,border-color,box-shadow] duration-300 ease-[cubic-bezier(0.34,1.2,0.64,1)] motion-reduce:transition-none sm:h-8",
        // Reserving max-width per state (instead of swapping subtrees) is what lets the
        // capsule morph; the action row no longer jumps when recording starts.
        idle && "max-w-9 border-transparent sm:max-w-8",
        recording && "max-w-96 border-destructive/35 bg-destructive/10 px-1.5",
        transcribing && "max-w-56 border-border bg-muted/60 px-2",
        failed &&
          "max-w-24 border-destructive/35 bg-destructive/5 px-1 animate-voice-shake motion-reduce:animate-none",
      )}
      role="group"
      aria-label={
        recording
          ? "Voice recording controls"
          : transcribing
            ? "Voice transcription in progress"
            : failed
              ? "Voice transcription failed"
              : undefined
      }
    >
      {recording ? (
        <>
          <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-destructive">
            <span
              className="size-1.5 shrink-0 rounded-full bg-destructive animate-voice-dot motion-reduce:animate-none"
              aria-hidden="true"
            />
            <VoiceLevelMeter subscribeLevel={props.subscribeLevel} />
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
              title={showCountdown ? "Recording stops automatically at the limit" : undefined}
            >
              {showCountdown ? `-${formatClock(remainingSeconds)}` : formatClock(elapsedSeconds)}
            </span>
          </span>
          <button
            type="button"
            className={cn(
              "rounded-full px-1.5 py-1 text-[11px] transition-colors",
              recording.cleanup
                ? "bg-destructive/10 text-destructive"
                : "text-muted-foreground hover:bg-muted",
            )}
            onClick={() => props.onCleanupChange(!recording.cleanup)}
            aria-pressed={recording.cleanup}
            title="Clean up filler words and punctuation after transcribing"
          >
            Cleanup {recording.cleanup ? "on" : "off"}
          </button>
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
            onClick={props.onCancel}
            aria-label="Cancel voice recording"
            title="Cancel · Esc"
          >
            <XIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-destructive text-white transition-transform hover:scale-105 motion-reduce:transition-none"
            onClick={props.onToggle}
            aria-label="Stop recording and transcribe"
            title="Stop and transcribe · ⌘⇧M / Ctrl⇧M"
          >
            <SquareIcon className="size-3 fill-current" />
          </button>
        </>
      ) : transcribing ? (
        <>
          <TranscribingShimmer />
          <span className="whitespace-nowrap px-1.5 text-xs text-muted-foreground">
            Transcribing…
          </span>
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
            onClick={props.onCancel}
            aria-label="Cancel transcription"
            title="Cancel transcription"
          >
            <XIcon className="size-3.5" />
          </button>
        </>
      ) : failed ? (
        <>
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-destructive transition-colors hover:bg-destructive/10"
            onClick={props.onRetry}
            aria-label="Retry voice transcription"
            title="Transcription failed — retry with the same recording"
          >
            <RotateCwIcon className="size-4" />
          </button>
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
            onClick={props.onCancel}
            aria-label="Discard failed voice recording"
            title="Discard recording"
          >
            <XIcon className="size-3.5" />
          </button>
        </>
      ) : (
        <button
          type="button"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:size-8",
            requestingPermission && "bg-muted",
          )}
          disabled={props.disabled || requestingPermission}
          onClick={props.onToggle}
          aria-label={requestingPermission ? "Requesting microphone access" : "Dictate message"}
          title={requestingPermission ? "Requesting microphone…" : "Dictate message · ⌘⇧M / Ctrl⇧M"}
        >
          {requestingPermission ? <Spinner className="size-4" /> : <MicIcon className="size-4" />}
        </button>
      )}
    </div>
  );
}
