import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_VOICE_INPUT_SETTINGS,
  OpenRouterIntegrationStatus,
  VoiceInputSettings,
  VoiceTranscriptionError,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResponse,
} from "./voice.ts";

const decode = <S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> =>
  Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;

describe("voice contracts", () => {
  it("decodes relay-controlled defaults", () => {
    expect(decode(VoiceInputSettings, DEFAULT_VOICE_INPUT_SETTINGS)).toEqual(
      DEFAULT_VOICE_INPUT_SETTINGS,
    );
  });

  it("trims dictionary entries and enforces dictionary constraints", () => {
    expect(
      decode(VoiceInputSettings, {
        ...DEFAULT_VOICE_INPUT_SETTINGS,
        dictionary: ["  T3 Code  "],
      }).dictionary,
    ).toEqual(["T3 Code"]);
    expect(() =>
      decode(VoiceInputSettings, {
        ...DEFAULT_VOICE_INPUT_SETTINGS,
        dictionary: ["x".repeat(81)],
      }),
    ).toThrow();
    expect(() =>
      decode(VoiceInputSettings, {
        ...DEFAULT_VOICE_INPUT_SETTINGS,
        dictionary: Array.from({ length: 251 }, (_, index) => `entry-${index}`),
      }),
    ).toThrow();
  });

  it("keeps integration status redacted by construction", () => {
    const status = decode(OpenRouterIntegrationStatus, {
      configured: true,
      credentialHint: "…1234",
      state: "connected",
    });
    expect(status).not.toHaveProperty("apiKey");
    expect(
      decode(OpenRouterIntegrationStatus, {
        configured: true,
        state: "connected",
        apiKey: "secret",
      }),
    ).not.toHaveProperty("apiKey");
  });

  it("validates transcription payloads, responses, and tagged error codes", () => {
    expect(
      decode(VoiceTranscriptionRequest, {
        requestId: "request-1",
        audio: { data: "AAAA", format: "webm" },
        cleanup: false,
      }).audio.format,
    ).toBe("webm");
    expect(
      decode(VoiceTranscriptionResponse, {
        requestId: "request-1",
        rawText: "hello",
        text: "Hello.",
        cleanupApplied: true,
      }).cleanupApplied,
    ).toBe(true);
    expect(decode(VoiceTranscriptionError, { code: "no_speech" }).code).toBe("no_speech");
    expect(() => decode(VoiceTranscriptionError, { code: "unknown" })).toThrow();
  });
});
