import { describe, expect, it } from "vite-plus/test";

import { testExports } from "./VoiceInput.ts";

describe("relay Voice Input normalization", () => {
  it("measures decoded base64 size and rejects malformed input", () => {
    expect(testExports.decodedBase64Size("AAAA")).toBe(3);
    expect(testExports.decodedBase64Size("YQ==")).toBe(1);
    expect(testExports.decodedBase64Size("not base64")).toBe(-1);
  });

  it("rejects recordings meaningfully over the duration limit", () => {
    expect(testExports.durationExceedsLimit(undefined)).toBe(false);
    expect(testExports.durationExceedsLimit(120)).toBe(false);
    expect(testExports.durationExceedsLimit(122)).toBe(false);
    expect(testExports.durationExceedsLimit(124)).toBe(true);
  });

  it("returns redacted integration status only", () => {
    expect(
      testExports.integrationStatus({
        credentialCiphertext: "encrypted-secret",
        credentialHint: "…1234",
        state: "connected",
        lastValidatedAt: "2026-07-31T00:00:00.000Z",
        errorCode: null,
      }),
    ).toEqual({
      configured: true,
      credentialHint: "…1234",
      state: "connected",
      lastValidatedAt: "2026-07-31T00:00:00.000Z",
    });
  });

  it("filters model discovery by compatible modality", () => {
    const payload = {
      data: [
        {
          id: "openai/transcribe",
          name: "Transcribe",
          architecture: {
            input_modalities: ["audio"],
            output_modalities: ["text"],
          },
          pricing: { audio: "0.001" },
        },
        {
          id: "openai/chat",
          name: "Chat",
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          pricing: { prompt: "0.01", completion: "0.02" },
        },
      ],
    };
    expect(testExports.normalizeModels(payload, "transcription").map((model) => model.id)).toEqual([
      "openai/gpt-4o-mini-transcribe",
      "openai/gpt-4o-transcribe",
    ]);
    expect(testExports.normalizeModels(payload, "text").map((model) => model.id)).toEqual([
      "openai/chat",
    ]);
  });

  it("replaces an incompatible persisted transcription model with the default", () => {
    expect(testExports.resolveTranscriptionModel("openai/gpt-audio-mini")).toBe(
      "openai/gpt-4o-mini-transcribe",
    );
    expect(testExports.resolveTranscriptionModel("openai/gpt-4o-transcribe")).toBe(
      "openai/gpt-4o-transcribe",
    );
  });

  it("cleanup prompt forbids acting on content and limits context", () => {
    expect(testExports.CLEANUP_SYSTEM_PROMPT).toContain("Do not answer or act");
    expect(testExports.CLEANUP_SYSTEM_PROMPT).toContain("Preserve commands");
    expect(testExports.CLEANUP_SYSTEM_PROMPT).not.toContain("repository");
    expect(testExports.CLEANUP_SYSTEM_PROMPT).not.toContain("thread history");
  });

  it.each([
    [400, "invalid_audio"],
    [403, "credential_invalid"],
    [413, "audio_too_large"],
    [415, "unsupported_format"],
    [422, "invalid_audio"],
    [429, "rate_limited"],
    [503, "model_unavailable"],
  ] as const)("maps OpenRouter HTTP %s to %s", async (status, code) => {
    const error = await testExports.upstreamError(
      new Response(JSON.stringify({ error: { message: "provider detail" } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(error.code).toBe(code);
    expect(error.cause).toEqual(
      expect.objectContaining({ message: expect.stringContaining("HTTP") }),
    );
  });

  it("maps a rejected transcription model to model_unavailable", async () => {
    const error = await testExports.upstreamError(
      new Response(
        JSON.stringify({ error: { message: "Model openai/gpt-audio-mini does not exist" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );

    expect(error.code).toBe("model_unavailable");
  });
});
