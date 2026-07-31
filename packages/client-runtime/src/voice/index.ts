import {
  VOICE_INPUT_MAX_DURATION_SECONDS,
  type VoiceAudioFormat,
  type VoiceTranscriptionErrorCode,
  type VoiceTranscriptionResponse,
} from "@t3tools/contracts/voice";

export {
  createVoicePreflightCache,
  voicePreflightReady,
  type VoicePreflightCache,
  type VoicePreflightSnapshot,
} from "./preflight.ts";

export type VoiceInputError = {
  readonly code: VoiceTranscriptionErrorCode | "permission_denied" | "recording_failed";
  readonly message?: string;
  readonly permanent?: boolean;
};

export type VoiceInputState =
  | { readonly type: "idle" }
  | { readonly type: "requesting_permission" }
  | { readonly type: "recording"; readonly startedAt: number; readonly cleanup: boolean }
  | { readonly type: "stopping" }
  | { readonly type: "transcribing"; readonly requestId: string }
  | {
      readonly type: "completed";
      readonly requestId: string;
      readonly rawText: string;
      readonly text: string;
      readonly cleanupApplied: boolean;
      readonly warning?: "cleanup_failed";
    }
  | {
      readonly type: "failed";
      readonly stage: "permission" | "recording" | "transcription";
      readonly error: VoiceInputError;
      readonly canRetry: boolean;
    };

export type VoiceRecording = {
  readonly data: string;
  readonly format: VoiceAudioFormat;
  readonly durationSeconds?: number;
  dispose(): void;
};

export type VoiceCaptureAdapter = {
  requestPermission(signal: AbortSignal): Promise<"granted" | "denied" | "blocked">;
  start(input: {
    readonly signal: AbortSignal;
    readonly onLevel?: (level: number) => void;
    readonly onInterrupted?: () => void;
  }): Promise<void>;
  stop(): Promise<VoiceRecording>;
  cancel(): Promise<void>;
};

export type VoiceTranscriptionClient = {
  transcribe(
    input: {
      readonly requestId: string;
      readonly audio: { readonly data: string; readonly format: VoiceAudioFormat };
      readonly cleanup: boolean;
      readonly durationSeconds?: number;
    },
    signal: AbortSignal,
  ): Promise<VoiceTranscriptionResponse>;
};

export type VoiceInputAnalyticsEvent =
  | { readonly type: "recording_started"; readonly cleanup: boolean }
  | { readonly type: "recording_stopped" }
  | { readonly type: "recording_cancelled" }
  | { readonly type: "transcription_completed"; readonly cleanupApplied: boolean }
  | { readonly type: "voice_error"; readonly code: VoiceInputError["code"] };

export type VoiceInputControllerOptions = {
  readonly capture: VoiceCaptureAdapter;
  readonly client: VoiceTranscriptionClient;
  readonly createRequestId?: () => string;
  readonly now?: () => number;
  readonly maxDurationSeconds?: number;
  readonly onAnalytics?: (event: VoiceInputAnalyticsEvent) => void;
  readonly onLevel?: (level: number) => void;
};

// React Native's Hermes runtime has no global `crypto`, so referencing it directly would make
// every transcription fail on mobile. Platforms with a real UUID source should inject one via
// `createRequestId`; this fallback only needs enough entropy for request idempotency keys.
function defaultCreateRequestId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof globalCrypto?.randomUUID === "function") return globalCrypto.randomUUID();
  // @effect-diagnostics-next-line globalRandom:off
  const random = () => Math.random().toString(36).slice(2, 10);
  // @effect-diagnostics-next-line globalDate:off
  return `voice-${Date.now().toString(36)}-${random()}${random()}`;
}

const RETRYABLE_ERRORS = new Set<VoiceInputError["code"]>([
  "rate_limited",
  "transcription_failed",
  "model_unavailable",
]);

export function voiceInputErrorMessage(error: VoiceInputError): string {
  switch (error.code) {
    case "permission_denied":
      return "Microphone access was denied.";
    case "recording_failed":
      return error.message ?? "Recording failed. Check your microphone and try again.";
    case "unauthenticated":
      return "Sign in to T3 Connect to use Voice Input.";
    case "integration_not_configured":
      return "Connect OpenRouter in Settings to use Voice Input.";
    case "credential_invalid":
      return "Your OpenRouter API key was rejected. Update it in Settings.";
    case "invalid_audio":
    case "unsupported_format":
      return error.message
        ? `The recording could not be processed: ${error.message}`
        : "The recording could not be processed.";
    case "audio_too_large":
      return "The recording is too large to transcribe.";
    case "duration_exceeded":
      return "The recording is longer than the transcription limit.";
    case "no_speech":
      return "No speech was detected in the recording.";
    case "model_unavailable":
      return "The transcription model is temporarily unavailable.";
    case "rate_limited":
      return "Transcription is rate limited right now. Try again shortly.";
    case "provider_payment_required":
      return "OpenRouter needs credit to transcribe. Check your account balance.";
    case "request_aborted":
      return "The transcription request was interrupted.";
    case "transcription_failed":
      return error.message ?? "Transcription failed. Try again.";
  }
}

function normalizeError(error: unknown): VoiceInputError {
  if (
    typeof error === "object" &&
    error !== null &&
    "relayError" in error &&
    typeof error.relayError === "object" &&
    error.relayError !== null &&
    "_tag" in error.relayError &&
    error.relayError._tag === "RelayVoiceInputError"
  ) {
    const relayError = error.relayError as { code?: unknown; detail?: unknown };
    if (typeof relayError.code === "string") {
      return {
        code: relayError.code as VoiceInputError["code"],
        ...(typeof relayError.detail === "string" ? { message: relayError.detail } : {}),
      };
    }
    return normalizeError(error.relayError);
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const candidate = error as { code?: unknown; message?: unknown; permanent?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code as VoiceInputError["code"],
        ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
        ...(typeof candidate.permanent === "boolean" ? { permanent: candidate.permanent } : {}),
      };
    }
  }
  return {
    code: "transcription_failed",
    ...(error instanceof Error ? { message: error.message } : {}),
  };
}

export class VoiceInputController {
  readonly #capture: VoiceCaptureAdapter;
  readonly #client: VoiceTranscriptionClient;
  readonly #createRequestId: () => string;
  readonly #now: () => number;
  readonly #maxDurationMs: number;
  readonly #onAnalytics: ((event: VoiceInputAnalyticsEvent) => void) | undefined;
  readonly #onLevel: ((level: number) => void) | undefined;
  readonly #listeners = new Set<(state: VoiceInputState) => void>();
  #state: VoiceInputState = { type: "idle" };
  #abortController: AbortController | null = null;
  #durationTimer: ReturnType<typeof setTimeout> | null = null;
  #recording: VoiceRecording | null = null;
  #cleanup = true;
  #generation = 0;

  constructor(options: VoiceInputControllerOptions) {
    this.#capture = options.capture;
    this.#client = options.client;
    this.#createRequestId = options.createRequestId ?? defaultCreateRequestId;
    this.#now = options.now ?? Date.now;
    this.#maxDurationMs = (options.maxDurationSeconds ?? VOICE_INPUT_MAX_DURATION_SECONDS) * 1_000;
    this.#onAnalytics = options.onAnalytics;
    this.#onLevel = options.onLevel;
  }

  get state(): VoiceInputState {
    return this.#state;
  }

  subscribe(listener: (state: VoiceInputState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  #setState(state: VoiceInputState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  async start(cleanup: boolean): Promise<boolean> {
    if (
      this.#state.type !== "idle" &&
      this.#state.type !== "completed" &&
      this.#state.type !== "failed"
    ) {
      return false;
    }
    await this.cancel();
    this.#cleanup = cleanup;
    const generation = ++this.#generation;
    this.#abortController = new AbortController();
    this.#setState({ type: "requesting_permission" });
    try {
      const permission = await this.#capture.requestPermission(this.#abortController.signal);
      if (generation !== this.#generation) {
        // A stale permission grant can leave the adapter holding a live microphone stream.
        await this.#capture.cancel().catch(() => undefined);
        return false;
      }
      if (permission !== "granted") {
        const error: VoiceInputError = {
          code: "permission_denied",
          permanent: permission === "blocked",
        };
        this.#setState({
          type: "failed",
          stage: "permission",
          error,
          canRetry: permission !== "blocked",
        });
        this.#onAnalytics?.({ type: "voice_error", code: error.code });
        return false;
      }
      await this.#capture.start({
        signal: this.#abortController.signal,
        ...(this.#onLevel ? { onLevel: this.#onLevel } : {}),
        onInterrupted: () => void this.stop(),
      });
      if (generation !== this.#generation) {
        await this.#capture.cancel().catch(() => undefined);
        return false;
      }
      this.#setState({ type: "recording", startedAt: this.#now(), cleanup });
      this.#onAnalytics?.({ type: "recording_started", cleanup });
      // The controller integrates with browser/native lifecycles rather than an Effect runtime.
      // @effect-diagnostics-next-line globalTimers:off
      this.#durationTimer = setTimeout(() => void this.stop(), this.#maxDurationMs);
      return true;
    } catch (cause) {
      await this.#capture.cancel().catch(() => undefined);
      if (generation !== this.#generation) return false;
      const error = normalizeError(cause);
      this.#setState({ type: "failed", stage: "recording", error, canRetry: false });
      this.#onAnalytics?.({ type: "voice_error", code: error.code });
      return false;
    }
  }

  async stop(): Promise<boolean> {
    if (this.#state.type !== "recording") return false;
    this.#clearDurationTimer();
    this.#setState({ type: "stopping" });
    try {
      this.#recording = await this.#capture.stop();
      this.#onAnalytics?.({ type: "recording_stopped" });
      return await this.#transcribe();
    } catch (cause) {
      const error = normalizeError(cause);
      this.#setState({ type: "failed", stage: "recording", error, canRetry: false });
      this.#onAnalytics?.({ type: "voice_error", code: error.code });
      return false;
    }
  }

  setRecordingCleanup(cleanup: boolean): boolean {
    if (this.#state.type !== "recording") return false;
    this.#cleanup = cleanup;
    this.#setState({ ...this.#state, cleanup });
    return true;
  }

  async retry(): Promise<boolean> {
    if (this.#state.type !== "failed" || !this.#state.canRetry || this.#recording === null) {
      return false;
    }
    return this.#transcribe();
  }

  async #transcribe(): Promise<boolean> {
    const recording = this.#recording;
    if (recording === null) return false;
    const generation = ++this.#generation;
    // The capture adapter owns the recording signal until stop() has finished. Aborting it here
    // tells browser capture adapters to cancel the whole voice operation while we are transitioning
    // to transcription.
    this.#abortController = new AbortController();
    const requestId = this.#createRequestId();
    this.#setState({ type: "transcribing", requestId });
    try {
      const result = await this.#client.transcribe(
        {
          requestId,
          audio: { data: recording.data, format: recording.format },
          cleanup: this.#cleanup,
          ...(recording.durationSeconds === undefined
            ? {}
            : { durationSeconds: recording.durationSeconds }),
        },
        this.#abortController.signal,
      );
      if (generation !== this.#generation || result.requestId !== requestId) return false;
      this.#disposeRecording();
      this.#setState({
        type: "completed",
        requestId,
        rawText: result.rawText,
        text: result.text,
        cleanupApplied: result.cleanupApplied,
        ...(result.warning ? { warning: result.warning } : {}),
      });
      this.#onAnalytics?.({
        type: "transcription_completed",
        cleanupApplied: result.cleanupApplied,
      });
      return true;
    } catch (cause) {
      if (generation !== this.#generation) return false;
      const error = normalizeError(cause);
      const canRetry = RETRYABLE_ERRORS.has(error.code);
      if (!canRetry) this.#disposeRecording();
      this.#setState({ type: "failed", stage: "transcription", error, canRetry });
      this.#onAnalytics?.({ type: "voice_error", code: error.code });
      return false;
    }
  }

  async cancel(): Promise<void> {
    const wasActive = this.#state.type !== "idle";
    ++this.#generation;
    this.#clearDurationTimer();
    this.#abortController?.abort();
    this.#abortController = null;
    // Release capture from every non-idle state: a pending permission request or a failed start
    // can still hold a live microphone stream even though nothing is "recording".
    if (this.#state.type !== "idle") {
      await this.#capture.cancel().catch(() => undefined);
    }
    this.#disposeRecording();
    this.#setState({ type: "idle" });
    if (wasActive) this.#onAnalytics?.({ type: "recording_cancelled" });
  }

  dispose(): void {
    void this.cancel();
    this.#listeners.clear();
  }

  #clearDurationTimer(): void {
    if (this.#durationTimer !== null) clearTimeout(this.#durationTimer);
    this.#durationTimer = null;
  }

  #disposeRecording(): void {
    this.#recording?.dispose();
    this.#recording = null;
  }
}
