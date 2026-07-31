import type { VoiceInputState } from "@t3tools/client-runtime/voice";
import { VOICE_INPUT_MAX_DURATION_SECONDS } from "@t3tools/contracts/voice";
import { MicIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";

const COUNTDOWN_THRESHOLD_SECONDS = 15;
const LEVEL_BAR_COUNT = 12;

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
  const [levels, setLevels] = useState<ReadonlyArray<number>>(() =>
    Array.from({ length: LEVEL_BAR_COUNT }, () => 0),
  );
  useEffect(
    () =>
      props.subscribeLevel((level) => {
        setLevels((previous) => [...previous.slice(1), level]);
      }),
    [props.subscribeLevel],
  );
  return (
    <div className="flex h-4 items-center gap-px" aria-hidden="true">
      {levels.map((level, index) => (
        <span
          // The bars are fixed positional slots over a rolling sample window.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className="w-0.5 rounded-full bg-destructive/80"
          style={{ height: `${Math.round(20 + Math.min(1, level) * 80)}%` }}
        />
      ))}
    </div>
  );
}

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
  const elapsedSeconds = useElapsedSeconds(recording?.startedAt ?? null);
  const remainingSeconds = Math.max(0, VOICE_INPUT_MAX_DURATION_SECONDS - elapsedSeconds);
  const showCountdown = remainingSeconds <= COUNTDOWN_THRESHOLD_SECONDS;

  if (recording) {
    return (
      <div
        className="flex h-9 items-center gap-1 rounded-full border border-destructive/35 bg-destructive/10 px-1.5 sm:h-8"
        role="group"
        aria-label="Voice recording controls"
      >
        <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-destructive">
          <VoiceLevelMeter subscribeLevel={props.subscribeLevel} />
          <span
            className={cn(
              "tabular-nums",
              showCountdown && "animate-pulse motion-reduce:animate-none",
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
          className="rounded-full px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted"
          onClick={() => props.onCleanupChange(!recording.cleanup)}
          aria-pressed={recording.cleanup}
          title="Clean up filler words and punctuation after transcribing"
        >
          Cleanup {recording.cleanup ? "on" : "off"}
        </button>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          onClick={props.onCancel}
          aria-label="Cancel voice recording"
          title="Cancel · Esc"
        >
          <XIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-full bg-destructive text-white"
          onClick={props.onToggle}
          aria-label="Stop recording and transcribe"
          title="Stop and transcribe · ⌘⇧M / Ctrl⇧M"
        >
          <SquareIcon className="size-3 fill-current" />
        </button>
      </div>
    );
  }

  if (props.state.type === "stopping" || props.state.type === "transcribing") {
    return (
      <div
        className="flex h-9 items-center gap-1 rounded-full border border-border bg-muted/60 px-2 sm:h-8"
        role="group"
        aria-label="Voice transcription in progress"
      >
        <Spinner className="size-3.5 text-muted-foreground" />
        <span className="px-0.5 text-xs text-muted-foreground">Transcribing…</span>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          onClick={props.onCancel}
          aria-label="Cancel transcription"
          title="Cancel transcription"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  if (props.state.type === "failed" && props.state.canRetry) {
    return (
      <div className="flex items-center gap-1" role="group" aria-label="Voice transcription failed">
        <button
          type="button"
          className="flex size-9 items-center justify-center rounded-full text-destructive hover:bg-destructive/10 sm:size-8"
          onClick={props.onRetry}
          aria-label="Retry voice transcription"
          title="Transcription failed — retry with the same recording"
        >
          <RotateCwIcon className="size-4" />
        </button>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          onClick={props.onCancel}
          aria-label="Discard failed voice recording"
          title="Discard recording"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  const requestingPermission = props.state.type === "requesting_permission";
  return (
    <button
      type="button"
      className={cn(
        "flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:size-8",
        requestingPermission && "bg-muted",
      )}
      disabled={props.disabled || requestingPermission}
      onClick={props.onToggle}
      aria-label={requestingPermission ? "Requesting microphone access" : "Dictate message"}
      title={requestingPermission ? "Requesting microphone…" : "Dictate message · ⌘⇧M / Ctrl⇧M"}
    >
      {requestingPermission ? <Spinner className="size-4" /> : <MicIcon className="size-4" />}
    </button>
  );
}
