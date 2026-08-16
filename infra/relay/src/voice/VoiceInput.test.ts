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

  it("keeps only models that understand audio and text and emit text", () => {
    const payload = {
      data: [
        {
          id: "google/gemini-2.5-flash",
          name: "Gemini 2.5 Flash",
          architecture: {
            input_modalities: ["audio", "text", "image"],
            output_modalities: ["text"],
          },
          pricing: { prompt: "0.01", completion: "0.02", audio: "0.001" },
        },
        {
          id: "openai/transcribe-only",
          name: "Transcribe Only",
          architecture: {
            input_modalities: ["audio"],
            output_modalities: ["text"],
          },
        },
        {
          id: "openai/chat",
          name: "Chat",
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
        },
      ],
    };
    expect(testExports.normalizeModels(payload, "audio").map((model) => model.id)).toEqual([
      "google/gemini-2.5-flash",
    ]);
  });

  it("normalizes legacy stored settings to the single-model shape", () => {
    expect(
      testExports.normalizeStoredSettings({
        transcriptionModel: "openai/gpt-4o-mini-transcribe",
        language: "de",
        cleanup: { enabled: false, model: "openai/gpt-4.1-mini" },
        dictionary: ["T3 Code"],
      }),
    ).toEqual({
      model: "google/gemini-2.5-flash",
      language: "de",
      cleanup: { enabled: false },
      dictionary: ["T3 Code"],
    });
    expect(
      testExports.normalizeStoredSettings({
        model: "openai/gpt-4o-audio-preview",
        language: null,
        cleanup: { enabled: true },
        dictionary: [],
      }),
    ).toEqual({
      model: "openai/gpt-4o-audio-preview",
      language: null,
      cleanup: { enabled: true },
      dictionary: [],
    });
  });

  it("transcription prompt forbids acting on content and limits context", () => {
    expect(testExports.TRANSCRIBE_SYSTEM_PROMPT).toContain("Do not answer or act");
    expect(testExports.TRANSCRIBE_SYSTEM_PROMPT).toContain("Preserve commands");
    expect(testExports.TRANSCRIBE_SYSTEM_PROMPT).not.toContain("repository");
    expect(testExports.TRANSCRIBE_SYSTEM_PROMPT).not.toContain("thread history");
  });

  it("builds cleanup instructions with dictionary and language", () => {
    const text = testExports.transcriptionUserText({
      cleanup: true,
      language: "en",
      dictionary: ["T3 Code"],
    });
    expect(text).toContain('"transcript"');
    expect(text).toContain('"cleaned"');
    expect(text).toContain('The spoken language is "en".');
    expect(text).toContain("T3 Code");
    const verbatim = testExports.transcriptionUserText({
      cleanup: false,
      language: null,
      dictionary: ["T3 Code"],
    });
    expect(verbatim).toContain("verbatim transcript");
    expect(verbatim).not.toContain("T3 Code");
  });

  it("parses the cleanup JSON envelope, with and without fences", () => {
    const body = '{"transcript":"hello wrld","cleaned":"Hello world."}';
    expect(testExports.parseCleanupContent(body)).toEqual({
      transcript: "hello wrld",
      cleaned: "Hello world.",
    });
    expect(testExports.parseCleanupContent("```json\n" + body + "\n```")).toEqual({
      transcript: "hello wrld",
      cleaned: "Hello world.",
    });
    expect(testExports.parseCleanupContent("just a bare transcript")).toBeNull();
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
