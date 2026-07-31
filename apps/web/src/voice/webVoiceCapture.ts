import type { VoiceCaptureAdapter, VoiceRecording } from "@t3tools/client-runtime/voice";
import type { VoiceAudioFormat } from "@t3tools/contracts/voice";

const MIME_TYPES: ReadonlyArray<{ readonly mimeType: string; readonly format: VoiceAudioFormat }> =
  [
    { mimeType: "audio/webm;codecs=opus", format: "webm" },
    { mimeType: "audio/mp4;codecs=mp4a.40.2", format: "m4a" },
    { mimeType: "audio/mp4", format: "m4a" },
    { mimeType: "audio/ogg;codecs=opus", format: "ogg" },
  ];

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read recording."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not encode recording."));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export class WebVoiceCapture implements VoiceCaptureAdapter {
  #stream: MediaStream | null = null;
  #recorder: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #format: VoiceAudioFormat = "webm";
  #audioContext: AudioContext | null = null;
  #levelFrame: number | null = null;
  #startedAt = 0;

  async requestPermission(signal: AbortSignal): Promise<"granted" | "denied" | "blocked"> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return "blocked";
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
    const supported = MIME_TYPES.find(({ mimeType }) => MediaRecorder.isTypeSupported(mimeType));
    const options = supported ? { mimeType: supported.mimeType } : undefined;
    this.#format = supported?.format ?? "webm";
    this.#chunks = [];
    this.#recorder = new MediaRecorder(stream, options);
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
      recorder.addEventListener(
        "stop",
        () => resolve(new Blob(this.#chunks, { type: recorder.mimeType })),
        { once: true },
      );
      recorder.addEventListener("error", () => reject(new Error("Audio recording failed.")), {
        once: true,
      });
      recorder.stop();
    });
    this.#release();
    const data = await blobToBase64(blob);
    return {
      data,
      format: this.#format,
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
    this.#audioContext = new AudioContext();
    const analyser = this.#audioContext.createAnalyser();
    analyser.fftSize = 64;
    this.#audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const sample = () => {
      analyser.getByteFrequencyData(samples);
      onLevel(samples.reduce((sum, value) => sum + value, 0) / samples.length / 255);
      this.#levelFrame = window.requestAnimationFrame(sample);
    };
    sample();
  }

  #release(): void {
    if (this.#levelFrame !== null) window.cancelAnimationFrame(this.#levelFrame);
    this.#levelFrame = null;
    void this.#audioContext?.close();
    this.#audioContext = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    this.#recorder = null;
  }
}
