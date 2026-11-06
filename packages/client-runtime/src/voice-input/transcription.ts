import * as Schema from "effect/Schema";

/** Cancellation is cooperative: settle only after the underlying work has stopped. */
export type VoiceTranscriptionOptions = {
  readonly signal: AbortSignal;
  /** Recorded length by the controller's clock; set when transcribing a finished recording. */
  readonly durationSeconds?: number;
};

export type VoiceStreamingSession = {
  readonly finish: (options: VoiceTranscriptionOptions) => Promise<string>;
};

export type PreparedVoiceTranscription = {
  readonly locale: string;
  /** Recording stops by itself at this length; defaults to the controller's limit. */
  readonly maxDurationSeconds?: number;
  /**
   * Runs alongside capture once recording starts. Resolves with the transcript when it
   * transcribed live, or null when `transcribe` still runs after the recording stops.
   * A rejection stops the recording.
   */
  readonly start?: (uri: string, options: VoiceTranscriptionOptions) => Promise<string | null>;
  readonly transcribe: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
  /** Present when audio streams during capture; `finish` then replaces `transcribe`. */
  readonly streaming?: VoiceStreamingSession;
};

export type VoiceTranscriber = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceTranscription>;
};

const VoiceTranscriptionErrorCode = Schema.Literals([
  /** A transcription service refused the request; the message is shown to the user as is. */
  "rejected",
  "unavailable",
  "unsupported-locale",
  "preparation-failed",
  "transcription-failed",
  "cancelled",
]);
export type VoiceTranscriptionErrorCode = typeof VoiceTranscriptionErrorCode.Type;

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    code: VoiceTranscriptionErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export function throwIfVoiceTranscriptionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VoiceTranscriptionError({
      code: "cancelled",
      message: "Voice transcription was cancelled.",
    });
  }
}
