import type { VoiceCaptureAdapter, VoiceRecording } from "@t3tools/client-runtime/voice";
import {
  AudioModule,
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
} from "expo-audio";
import { File } from "expo-file-system";
import { AppState, type NativeEventSubscription } from "react-native";

const LEVEL_SAMPLE_INTERVAL_MS = 100;
// Metering is reported in dBFS; treat -50 dB as silence for the visual meter.
const LEVEL_FLOOR_DB = -50;

export class MobileVoiceCapture implements VoiceCaptureAdapter {
  #recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  #appStateSubscription: NativeEventSubscription | null = null;
  #statusSubscription: { remove(): void } | null = null;
  #levelTimer: ReturnType<typeof setInterval> | null = null;
  #interrupted = false;

  async requestPermission(_signal: AbortSignal): Promise<"granted" | "denied" | "blocked"> {
    const existing = await getRecordingPermissionsAsync();
    if (existing.granted) return "granted";
    if (!existing.canAskAgain) return "blocked";
    const requested = await requestRecordingPermissionsAsync();
    if (requested.granted) return "granted";
    return requested.canAskAgain ? "denied" : "blocked";
  }

  async start(input: {
    readonly signal: AbortSignal;
    readonly onLevel?: (level: number) => void;
    readonly onInterrupted?: () => void;
  }): Promise<void> {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      interruptionModeAndroid: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
    this.#interrupted = false;
    this.#recorder = new AudioModule.AudioRecorder({
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
    await this.#recorder.prepareToRecordAsync();
    this.#statusSubscription = this.#recorder.addListener("recordingStatusUpdate", (status) => {
      if (status.hasError && !this.#interrupted) {
        this.#interrupted = true;
        input.onInterrupted?.();
      }
    });
    this.#appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !this.#interrupted) {
        this.#interrupted = true;
        input.onInterrupted?.();
      }
    });
    if (input.onLevel) {
      const recorder = this.#recorder;
      const onLevel = input.onLevel;
      this.#levelTimer = setInterval(() => {
        const metering = recorder.getStatus().metering;
        if (typeof metering !== "number") return;
        onLevel(Math.min(1, Math.max(0, (metering - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB)));
      }, LEVEL_SAMPLE_INTERVAL_MS);
    }
    input.signal.addEventListener("abort", () => void this.cancel(), { once: true });
    this.#recorder.record({ forDuration: 120 });
  }

  async stop(): Promise<VoiceRecording> {
    const recorder = this.#recorder;
    if (!recorder) throw new Error("No recording is active.");
    await recorder.stop();
    const uri = recorder.uri;
    const durationSeconds = recorder.currentTime;
    this.#releaseSession();
    if (!uri) throw new Error("The recording did not contain usable audio.");
    const file = new File(uri);
    const data = await file.base64();
    return {
      data,
      format: "m4a",
      durationSeconds,
      dispose: () => {
        try {
          file.delete();
        } catch {
          // Temporary recordings are best-effort cleanup after the native file has moved.
        }
      },
    };
  }

  async cancel(): Promise<void> {
    try {
      if (this.#recorder?.isRecording) await this.#recorder.stop();
      const uri = this.#recorder?.uri;
      if (uri) new File(uri).delete();
    } finally {
      this.#releaseSession();
    }
  }

  #releaseSession(): void {
    if (this.#levelTimer !== null) clearInterval(this.#levelTimer);
    this.#levelTimer = null;
    this.#statusSubscription?.remove();
    this.#statusSubscription = null;
    this.#appStateSubscription?.remove();
    this.#appStateSubscription = null;
    this.#recorder = null;
    void setIsAudioActiveAsync(false);
  }
}
