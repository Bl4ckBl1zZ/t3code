import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type {
  VoiceAudioFormat,
  VoiceInputStatus,
  VoiceTranscriptionRequest,
} from "@t3tools/contracts/relay";

export type RelayVoiceTranscriberDependencies = {
  /** The account's voice status, fetched if not cached. Throws `VoiceTranscriptionError`. */
  readonly loadStatus: (signal: AbortSignal) => Promise<VoiceInputStatus>;
  /** The recording at `uri`, base64-encoded. */
  readonly readAudio: (uri: string) => Promise<string>;
  /** Sends the clip to the relay. Throws `VoiceTranscriptionError` with a user-facing message. */
  readonly transcribe: (
    request: VoiceTranscriptionRequest,
    signal: AbortSignal,
  ) => Promise<{ readonly text: string }>;
  readonly deviceLocale: () => string;
  readonly requestId: () => string;
};

const AUDIO_FORMATS: Readonly<Record<string, VoiceAudioFormat>> = {
  wav: "wav",
  m4a: "m4a",
  mp4: "m4a",
  mp3: "mp3",
  ogg: "ogg",
  aac: "aac",
  flac: "flac",
};

/** The relay's name for a recording's container, from its file extension. */
export function voiceAudioFormatFromUri(uri: string): VoiceAudioFormat {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(uri)?.[1]?.toLowerCase();
  return (extension && AUDIO_FORMATS[extension]) || "m4a";
}

/** Reports cancellation instead of whatever the aborted work failed or returned with. */
async function settleUnlessAborted<A>(signal: AbortSignal, work: () => Promise<A>): Promise<A> {
  try {
    const value = await work();
    throwIfVoiceTranscriptionAborted(signal);
    return value;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw error;
  }
}

/**
 * Transcribes through the signed-in account's T3 Connect voice input. The
 * account's spoken language and the relay's clip limit apply to the recording.
 */
export function createRelayVoiceTranscriber(
  dependencies: RelayVoiceTranscriberDependencies,
): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      const status = await settleUnlessAborted(signal, () => dependencies.loadStatus(signal));
      if (!status.available) {
        throw new VoiceTranscriptionError("rejected", "Voice input is unavailable right now.");
      }
      return {
        locale: status.settings.language ?? dependencies.deviceLocale(),
        maxDurationSeconds: status.limits.maxClipSeconds,
        transcribe: async (uri, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);
          const data = await dependencies.readAudio(uri);
          throwIfVoiceTranscriptionAborted(options.signal);
          const request: VoiceTranscriptionRequest = {
            requestId: dependencies.requestId(),
            audio: { data, format: voiceAudioFormatFromUri(uri) },
            // The relay bills compressed clips by this length; never send zero.
            durationSeconds: Math.max(options.durationSeconds ?? 0, 0.1),
          };
          const result = await settleUnlessAborted(options.signal, () =>
            dependencies.transcribe(request, options.signal),
          );
          return result.text;
        },
      };
    },
  };
}
