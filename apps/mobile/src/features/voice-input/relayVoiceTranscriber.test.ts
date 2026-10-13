import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";
import type { VoiceInputStatus, VoiceTranscriptionRequest } from "@t3tools/contracts/relay";
import { describe, expect, it, vi } from "vite-plus/test";

import { createRelayVoiceTranscriber, voiceAudioFormatFromUri } from "./relayVoiceTranscriber";

const STATUS: VoiceInputStatus = {
  available: true,
  settings: { language: "de", dictionary: [], cleanup: true },
  limits: { maxClipSeconds: 120, maxUploadBytes: 10_485_760, dailySeconds: 1_800 },
  usedSecondsToday: 0,
};

function transcriber(input: {
  readonly status?: VoiceInputStatus;
  readonly transcribe?: (
    request: VoiceTranscriptionRequest,
    signal: AbortSignal,
  ) => Promise<{ readonly text: string }>;
}) {
  const transcribe = vi.fn(input.transcribe ?? (async () => ({ text: "Hallo Welt" })));
  return {
    transcribe,
    transcriber: createRelayVoiceTranscriber({
      loadStatus: async () => input.status ?? STATUS,
      readAudio: async () => "AAAA",
      transcribe,
      deviceLocale: () => "en-US",
      requestId: () => "request-1",
    }),
  };
}

describe("createRelayVoiceTranscriber", () => {
  it("records up to the relay's clip limit in the account's language and sends the clip", async () => {
    const { transcriber: relay, transcribe } = transcriber({});
    const signal = new AbortController().signal;

    const prepared = await relay.prepare({ signal });
    const text = await prepared.transcribe("file:///cache/recording-1.m4a", {
      signal,
      durationSeconds: 4.2,
    });

    expect(prepared.locale).toBe("de");
    expect(prepared.maxDurationSeconds).toBe(120);
    expect(text).toBe("Hallo Welt");
    expect(transcribe).toHaveBeenCalledWith(
      {
        requestId: "request-1",
        audio: { data: "AAAA", format: "m4a" },
        durationSeconds: 4.2,
      },
      signal,
    );
  });

  it("uses the device language when the account has none", async () => {
    const { transcriber: relay } = transcriber({
      status: { ...STATUS, settings: { ...STATUS.settings, language: null } },
    });
    const prepared = await relay.prepare({ signal: new AbortController().signal });
    expect(prepared.locale).toBe("en-US");
  });

  it("refuses to record when the relay has voice input turned off", async () => {
    const { transcriber: relay } = transcriber({ status: { ...STATUS, available: false } });
    await expect(relay.prepare({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: "rejected",
      message: "Voice input is unavailable right now.",
    });
  });

  it("passes the relay's refusal through and reports cancellation over late failures", async () => {
    const refusal = new VoiceTranscriptionError(
      "rejected",
      "You reached today's voice input limit.",
    );
    const abort = new AbortController();
    const { transcriber: relay } = transcriber({
      transcribe: async () => {
        throw refusal;
      },
    });
    const prepared = await relay.prepare({ signal: abort.signal });
    await expect(
      prepared.transcribe("file:///a.m4a", { signal: abort.signal, durationSeconds: 1 }),
    ).rejects.toBe(refusal);

    const cancelled = transcriber({
      transcribe: async () => {
        abort.abort();
        throw refusal;
      },
    });
    const preparedAgain = await cancelled.transcriber.prepare({
      signal: new AbortController().signal,
    });
    await expect(
      preparedAgain.transcribe("file:///a.m4a", { signal: abort.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("voiceAudioFormatFromUri", () => {
  it("names the container by extension and assumes m4a otherwise", () => {
    expect(voiceAudioFormatFromUri("file:///a/recording.WAV")).toBe("wav");
    expect(voiceAudioFormatFromUri("file:///a/recording.mp4?x=1")).toBe("m4a");
    expect(voiceAudioFormatFromUri("file:///a/recording")).toBe("m4a");
  });
});
