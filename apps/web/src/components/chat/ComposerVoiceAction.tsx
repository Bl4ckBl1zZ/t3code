import type { VoiceInputState } from "@t3tools/client-runtime/voice";
import { MicIcon, RotateCwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";

function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const seconds = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ComposerVoiceAction(props: {
  readonly state: VoiceInputState;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onCleanupChange: (cleanup: boolean) => void;
}) {
  const recording = props.state.type === "recording" ? props.state : null;
  const elapsed = useElapsed(recording?.startedAt ?? null);
  const processing =
    props.state.type === "requesting_permission" ||
    props.state.type === "stopping" ||
    props.state.type === "transcribing";

  if (recording) {
    return (
      <div
        className="flex h-9 items-center gap-1 rounded-full border border-destructive/35 bg-destructive/10 px-1.5 sm:h-8"
        role="group"
        aria-label="Voice recording controls"
      >
        <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-destructive">
          <span className="size-2 animate-pulse rounded-full bg-destructive motion-reduce:animate-none" />
          <span className="tabular-nums" aria-label={`Recording, ${elapsed}`}>
            {elapsed}
          </span>
        </span>
        <button
          type="button"
          className="rounded-full px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted"
          onClick={() => props.onCleanupChange(!recording.cleanup)}
          aria-pressed={recording.cleanup}
        >
          Cleanup {recording.cleanup ? "on" : "off"}
        </button>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          onClick={props.onCancel}
          aria-label="Cancel voice recording"
        >
          <XIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-full bg-destructive text-white"
          onClick={props.onToggle}
          aria-label="Stop recording and transcribe"
        >
          <SquareIcon className="size-3 fill-current" />
        </button>
      </div>
    );
  }

  if (props.state.type === "failed" && props.state.canRetry) {
    return (
      <button
        type="button"
        className="flex size-9 items-center justify-center rounded-full text-destructive hover:bg-destructive/10 sm:size-8"
        onClick={props.onRetry}
        aria-label="Retry voice transcription"
        title="Retry voice transcription"
      >
        <RotateCwIcon className="size-4" />
      </button>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:size-8",
        processing && "bg-muted",
      )}
      disabled={props.disabled || processing}
      onClick={props.onToggle}
      aria-label={processing ? "Transcribing voice input" : "Dictate message"}
      title={processing ? "Transcribing…" : "Dictate message · ⌘⇧M / Ctrl⇧M"}
    >
      {processing ? <Spinner className="size-4" /> : <MicIcon className="size-4" />}
    </button>
  );
}
