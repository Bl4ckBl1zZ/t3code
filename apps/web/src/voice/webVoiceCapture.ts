import type { VoiceCaptureAdapter, VoiceRecording } from "@t3tools/client-runtime/voice";
import type { VoiceAudioFormat } from "@t3tools/contracts/voice";

// OpenRouter's transcription endpoint accepts m4a/ogg/wav/mp3/aac but not WebM, which is what
// Chromium's MediaRecorder picks by default — so probe only containers the provider can read.
// Safari lands on audio/mp4 and Firefox on audio/ogg, matching what mobile already sends.
const MIME_TYPES: ReadonlyArray<{ readonly mimeType: string; readonly format: VoiceAudioFormat }> =
  [
    { mimeType: "audio/mp4;codecs=mp4a.40.2", format: "m4a" },
    { mimeType: "audio/mp4", format: "m4a" },
    { mimeType: "audio/ogg;codecs=opus", format: "ogg" },
  ];

const TRANSCRIBABLE_FORMATS = new Set<VoiceAudioFormat>(["m4a", "ogg", "wav", "mp3", "aac"]);

const LEVEL_SAMPLE_INTERVAL_MS = 100;

export function selectRecordingMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): { readonly mimeType: string; readonly format: VoiceAudioFormat } | undefined {
  return MIME_TYPES.find(({ mimeType }) => isTypeSupported(mimeType));
}

export function isTranscribableFormat(format: VoiceAudioFormat): boolean {
  return TRANSCRIBABLE_FORMATS.has(format);
}

export function voiceFormatFromMimeType(mimeType: string): VoiceAudioFormat | null {
  const container = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (container) {
    case "audio/webm":
    case "video/webm":
      return "webm";
    case "audio/mp4":
    case "video/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
    case "application/ogg":
      return "ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/aac":
      return "aac";
    default:
      return null;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Could not read recording.")),
      { once: true },
    );
    reader.addEventListener(
      "load",
      () => {
        const result = reader.result;
        if (typeof result !== "string") {
          reject(new Error("Could not encode recording."));
          return;
        }
        resolve(result.slice(result.indexOf(",") + 1));
      },
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}

export class WebVoiceCapture implements VoiceCaptureAdapter {
  #stream: MediaStream | null = null;
  #recorder: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #format: VoiceAudioFormat | null = null;
  #audioContext: AudioContext | null = null;
  #levelTimer: number | null = null;
  #startedAt = 0;

  async requestPermission(signal: AbortSignal): Promise<"granted" | "denied" | "blocked"> {
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      return "blocked";
    }
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (signal.aborted) {
        this.#release();
        return "denied";
      }
      return "granted";
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        try {
          const permission = await navigator.permissions.query({
            name: "microphone" as PermissionName,
          });
          return permission.state === "denied" ? "blocked" : "denied";
        } catch {
          // Safari and Firefox reject the "microphone" permission name.
          return "denied";
        }
      }
      throw cause;
    }
  }

  async start(input: {
    readonly signal: AbortSignal;
    readonly onLevel?: (level: number) => void;
    readonly onInterrupted?: () => void;
  }): Promise<void> {
    const stream = this.#stream;
    if (!stream) throw new Error("Microphone permission was not granted.");
    const supported = selectRecordingMimeType((mimeType) =>
      MediaRecorder.isTypeSupported(mimeType),
    );
    this.#chunks = [];
    this.#recorder = new MediaRecorder(
      stream,
      supported ? { mimeType: supported.mimeType } : undefined,
    );
    // When no probed type matched, the browser records in its default container; the real format
    // is resolved from the recorder/blob MIME type at stop() instead of being assumed here.
    this.#format = supported?.format ?? voiceFormatFromMimeType(this.#recorder.mimeType) ?? null;
    // Fail before the user speaks rather than uploading audio the provider will reject.
    if (this.#format !== null && !isTranscribableFormat(this.#format)) {
      throw new Error("This browser records an audio format transcription cannot accept.");
    }
    this.#recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.#chunks.push(event.data);
    });
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => input.onInterrupted?.(), { once: true });
    }
    if (input.onLevel) this.#startLevelSampling(stream, input.onLevel);
    input.signal.addEventListener("abort", () => void this.cancel(), { once: true });
    this.#startedAt = Date.now();
    this.#recorder.start(250);
  }

  async stop(): Promise<VoiceRecording> {
    const recorder = this.#recorder;
    if (!recorder) throw new Error("No recording is active.");
    const durationSeconds = Math.max(0, (Date.now() - this.#startedAt) / 1_000);
    const blob = await new Promise<Blob>((resolve, reject) => {
      const finish = () =>
        resolve(
          new Blob(this.#chunks, recorder.mimeType ? { type: recorder.mimeType } : undefined),
        );
      // An interruption (device unplugged, OS revoked the mic) may have stopped the recorder
      // already; collect whatever audio made it into the buffer instead of throwing.
      if (recorder.state === "inactive") {
        finish();
        return;
      }
      recorder.addEventListener("stop", finish, { once: true });
      recorder.addEventListener("error", () => reject(new Error("Audio recording failed.")), {
        once: true,
      });
      recorder.stop();
    });
    const format =
      this.#format ??
      voiceFormatFromMimeType(recorder.mimeType) ??
      voiceFormatFromMimeType(blob.type);
    this.#release();
    if (blob.size === 0) throw new Error("The recording did not contain usable audio.");
    if (!format) throw new Error("This browser records an unsupported audio format.");
    // Covers the case where the container was only knowable from the finished blob.
    if (!isTranscribableFormat(format)) {
      throw new Error("This browser records an audio format transcription cannot accept.");
    }
    const data = await blobToBase64(blob);
    return {
      data,
      format,
      durationSeconds,
      dispose: () => {
        this.#chunks = [];
      },
    };
  }

  async cancel(): Promise<void> {
    if (this.#recorder?.state === "recording") this.#recorder.stop();
    this.#chunks = [];
    this.#release();
  }

  #startLevelSampling(stream: MediaStream, onLevel: (level: number) => void): void {
    try {
      this.#audioContext = new AudioContext();
    } catch {
      return;
    }
    // iOS Safari creates AudioContexts suspended unless construction happens inside a fresh
    // user gesture; resume explicitly so the meter works after async preflight.
    void this.#audioContext.resume().catch(() => undefined);
    const analyser = this.#audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    this.#audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    this.#levelTimer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) {
        const centered = (value - 128) / 128;
        sum += centered * centered;
      }
      onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    }, LEVEL_SAMPLE_INTERVAL_MS);
  }

  #release(): void {
    if (this.#levelTimer !== null) window.clearInterval(this.#levelTimer);
    this.#levelTimer = null;
    void this.#audioContext?.close().catch(() => undefined);
    this.#audioContext = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    this.#recorder = null;
    this.#format = null;
  }
}
