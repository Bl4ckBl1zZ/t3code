import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceInputController, type VoiceCaptureAdapter, type VoiceRecording } from "./index.ts";

function fixture(options?: { readonly onLevel?: (level: number) => void }) {
  const recording: VoiceRecording = {
    data: "AAAA",
    format: "webm",
    durationSeconds: 2.5,
    dispose: vi.fn(),
  };
  const capture: VoiceCaptureAdapter = {
    requestPermission: vi.fn(async () => "granted" as const),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => recording),
    cancel: vi.fn(async () => undefined),
  };
  const transcribe = vi.fn(async ({ requestId }: { requestId: string }) => ({
    requestId,
    rawText: "hello",
    text: "Hello.",
    cleanupApplied: true,
  }));
  const controller = new VoiceInputController({
    capture,
    client: { transcribe },
    createRequestId: () => "request-1",
    ...(options?.onLevel ? { onLevel: options.onLevel } : {}),
  });
  return { capture, controller, recording, transcribe };
}

describe("VoiceInputController", () => {
  it("records, transcribes, and disposes ephemeral audio", async () => {
    const { controller, recording, transcribe } = fixture();
    expect(await controller.start(true)).toBe(true);
    expect(controller.state.type).toBe("recording");
    expect(await controller.stop()).toBe(true);
    expect(controller.state).toMatchObject({
      type: "completed",
      rawText: "hello",
      text: "Hello.",
      cleanupApplied: true,
    });
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ cleanup: true }),
      expect.anything(),
    );
    expect(recording.dispose).toHaveBeenCalledOnce();
  });

  it("does not abort the completed recording when transcription begins", async () => {
    const { capture, controller } = fixture();
    let recordingSignal: AbortSignal | undefined;
    vi.mocked(capture.start).mockImplementation(async ({ signal }) => {
      recordingSignal = signal;
    });

    await controller.start(true);
    expect(await controller.stop()).toBe(true);
    expect(recordingSignal?.aborted).toBe(false);
    expect(controller.state.type).toBe("completed");
  });

  it("rejects duplicate starts and stops", async () => {
    const { controller } = fixture();
    expect(await controller.start(false)).toBe(true);
    expect(await controller.start(false)).toBe(false);
    expect(await controller.stop()).toBe(true);
    expect(await controller.stop()).toBe(false);
  });

  it("keeps audio for retryable transcription failures", async () => {
    const { controller, recording, transcribe } = fixture();
    transcribe.mockRejectedValueOnce({ code: "rate_limited" }).mockResolvedValueOnce({
      requestId: "request-1",
      rawText: "hello",
      text: "hello",
      cleanupApplied: false,
    });
    await controller.start(false);
    expect(await controller.stop()).toBe(false);
    expect(controller.state).toMatchObject({ type: "failed", canRetry: true });
    expect(recording.dispose).not.toHaveBeenCalled();
    expect(await controller.retry()).toBe(true);
    expect(recording.dispose).toHaveBeenCalledOnce();
  });

  it("preserves a Voice Input error returned through the managed relay", async () => {
    const { controller, recording, transcribe } = fixture();
    transcribe.mockRejectedValueOnce({
      _tag: "ManagedRelayRequestFailedError",
      relayError: {
        _tag: "RelayVoiceInputError",
        code: "credential_invalid",
        traceId: "trace-1",
      },
    });

    await controller.start(false);
    expect(await controller.stop()).toBe(false);
    expect(controller.state).toMatchObject({
      type: "failed",
      stage: "transcription",
      error: { code: "credential_invalid" },
      canRetry: false,
    });
    expect(recording.dispose).toHaveBeenCalledOnce();
  });

  it("reports permanently blocked permission without starting capture", async () => {
    const { capture, controller } = fixture();
    vi.mocked(capture.requestPermission).mockResolvedValue("blocked");
    expect(await controller.start(true)).toBe(false);
    expect(controller.state).toMatchObject({
      type: "failed",
      stage: "permission",
      canRetry: false,
    });
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("cancels an active recording and releases capture", async () => {
    const { capture, controller } = fixture();
    await controller.start(true);
    await controller.cancel();
    expect(capture.cancel).toHaveBeenCalledOnce();
    expect(controller.state).toEqual({ type: "idle" });
  });

  it("forwards the recording duration to the transcription client", async () => {
    const { controller, transcribe } = fixture();
    await controller.start(true);
    await controller.stop();
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 2.5 }),
      expect.anything(),
    );
  });

  it("passes the level callback through to the capture adapter", async () => {
    const onLevel = vi.fn();
    const { capture, controller } = fixture({ onLevel });
    await controller.start(true);
    expect(vi.mocked(capture.start).mock.calls[0]?.[0]?.onLevel).toBe(onLevel);
  });

  it("releases capture when cancelled while requesting permission", async () => {
    const { capture, controller } = fixture();
    let grant: ((value: "granted") => void) | undefined;
    vi.mocked(capture.requestPermission).mockImplementation(
      () => new Promise((resolve) => (grant = resolve)),
    );
    const started = controller.start(true);
    await vi.waitFor(() => expect(controller.state.type).toBe("requesting_permission"));
    await controller.cancel();
    grant?.("granted");
    expect(await started).toBe(false);
    expect(capture.cancel).toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
    expect(controller.state).toEqual({ type: "idle" });
  });

  it("releases capture when the adapter fails to start", async () => {
    const { capture, controller } = fixture();
    vi.mocked(capture.start).mockRejectedValueOnce(new Error("boom"));
    expect(await controller.start(true)).toBe(false);
    expect(capture.cancel).toHaveBeenCalled();
    expect(controller.state).toMatchObject({ type: "failed", stage: "recording" });
  });
});
