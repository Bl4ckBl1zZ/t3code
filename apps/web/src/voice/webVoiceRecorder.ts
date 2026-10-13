import { bytesToBase64, encodeMonoWav, VOICE_WAV_SAMPLE_RATE } from "./wavEncoding";

// Twelve level readings a second is smooth enough for a meter and cheap to draw.
const LEVEL_INTERVAL_MS = 80;

export type MicrophoneFailure = "unsupported" | "denied" | "no-device" | "failed";

export class MicrophoneError extends Error {
  readonly reason: MicrophoneFailure;

  constructor(reason: MicrophoneFailure, options?: ErrorOptions) {
    super(microphoneFailureMessage(reason), options);
    this.name = "MicrophoneError";
    this.reason = reason;
  }
}

export function microphoneFailureMessage(reason: MicrophoneFailure): string {
  switch (reason) {
    case "unsupported":
      return "This browser cannot record audio here.";
    case "denied":
      return "Microphone access is blocked. Allow it for T3 Code in your browser or system settings.";
    case "no-device":
      return "No microphone was found.";
    case "failed":
      return "The microphone could not start.";
  }
}

export interface WebVoiceClip {
  /** Base64 16 kHz mono WAV. */
  readonly data: string;
  readonly durationSeconds: number;
}

export interface WebVoiceRecording {
  /** Stops recording and encodes the clip. */
  readonly stop: () => Promise<WebVoiceClip>;
  /** Stops recording and drops the audio. */
  readonly cancel: () => void;
}

function openMicrophoneError(cause: unknown): MicrophoneError {
  if (cause instanceof DOMException) {
    if (cause.name === "NotAllowedError" || cause.name === "SecurityError") {
      return new MicrophoneError("denied", { cause });
    }
    if (cause.name === "NotFoundError" || cause.name === "OverconstrainedError") {
      return new MicrophoneError("no-device", { cause });
    }
  }
  return new MicrophoneError("failed", { cause });
}

async function encodeClip(blob: Blob): Promise<WebVoiceClip> {
  const encoded = await blob.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, VOICE_WAV_SAMPLE_RATE).decodeAudioData(
    encoded,
  );
  // Rendering into a one-channel context at the target rate downmixes and resamples.
  const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_WAV_SAMPLE_RATE));
  const context = new OfflineAudioContext(1, frames, VOICE_WAV_SAMPLE_RATE);
  const source = context.createBufferSource();
  source.buffer = decoded;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return {
    data: bytesToBase64(encodeMonoWav(rendered.getChannelData(0), VOICE_WAV_SAMPLE_RATE)),
    durationSeconds: rendered.duration,
  };
}

/**
 * Opens the microphone and starts recording. `onLevel` receives 0..1 while
 * recording and never after stop or cancel; `onInterrupted` fires when the
 * system takes the microphone away.
 */
export async function startWebVoiceRecording(input: {
  readonly onLevel: (level: number) => void;
  readonly onInterrupted: () => void;
}): Promise<WebVoiceRecording> {
  if (
    !window.isSecureContext ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    throw new MicrophoneError("unsupported");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (cause) {
    throw openMicrophoneError(cause);
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  const meterContext = new AudioContext();
  const analyser = meterContext.createAnalyser();
  analyser.fftSize = 512;
  meterContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const levelTimer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    // Speech RMS sits around 0.02-0.2; scale so normal speech fills most of the meter.
    input.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 5));
  }, LEVEL_INTERVAL_MS);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    window.clearInterval(levelTimer);
    void meterContext.close().catch(() => undefined);
    for (const track of stream.getTracks()) track.stop();
  };
  for (const track of stream.getAudioTracks()) {
    track.addEventListener(
      "ended",
      () => {
        if (!released) input.onInterrupted();
      },
      { once: true },
    );
  }

  recorder.start();

  return {
    stop: async () => {
      const blob = await new Promise<Blob>((resolve, reject) => {
        const finish = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
        if (recorder.state === "inactive") {
          finish();
          return;
        }
        recorder.addEventListener("stop", finish, { once: true });
        recorder.addEventListener("error", () => reject(new MicrophoneError("failed")), {
          once: true,
        });
        recorder.stop();
      }).finally(release);
      if (blob.size === 0) throw new MicrophoneError("failed");
      return encodeClip(blob);
    },
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      chunks.length = 0;
      release();
    },
  };
}
